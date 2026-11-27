/**
 * A Brightness slider dragged quickly on a virtual deck, with the real display
 * helper under a headless KWin, checked frame by frame as the screen shows it
 * (found by the maintainer on the 10.3" panel, 2026-11-22: the panel slow to
 * redraw, blacking out and flashing its background while the finger moved,
 * and catching up about a second after it lifted).
 *
 * The real daemon session and virtual driver drive the real helper
 * (panel/deckhand-panel) through scripts/test/panel-shim.mjs, which stands in
 * for the touchscreen and says the finger's moves; the helper logs every frame
 * it hands KWin (--present-log: the brightness, and a 16 × 6 grid of samples).
 * A page with a background picture, four keys of their own colours and a
 * Brightness slider placed between the samples; a finger drags it to the
 * bottom and back up, a move every 8 ms. For **every frame shown**, during the
 * drag and after it:
 *
 * - **no blackout**: every sample on the background is the background's
 *   colour at that frame's brightness — never black, never an older level;
 * - **no flash**: every key is its own colour at that frame's brightness —
 *   never the bare background where a key should be;
 * - **no backlog**: once the finger lifts, the screen settles at the
 *   session's level within 250 ms, and no older level is shown after it.
 *
 * And **the cost per drag step**, CPU of the daemon (this process), the helper
 * and KWin, against the same drag on a Volume slider (fake pactl, its own cost
 * not counted); nothing at rest afterwards.
 *
 * KWin runs as in smoke-panel: --virtual, its own socket and a D-Bus of its
 * own. Skipped, saying so, where kwin_wayland or the helper's build is
 * missing.
 *
 *   make -C panel && npm run build:ts && node scripts/smoke-brightness-drag.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HELPER = path.join(REPO, 'panel/deckhand-panel');
// Fakes first: src/input.js reads DECKHAND_INPUT_BIN when it is imported; the real one would type into this desktop.
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const which = (cmd) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim() || null;
  } catch {
    return null;
  }
};
if (!which('kwin_wayland') || !existsSync(HELPER)) {
  console.log(`brightness drag: skipped — ${!which('kwin_wayland') ? 'no kwin_wayland on this machine' : `no helper at ${HELPER} (make -C panel)`}`);
  process.exit(0);
}

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-bright-'));
const SOCKET = `dh-bright-${process.pid}`;
const PRESENTS = path.join(TMP, 'presents.log');
const PID_FILE = path.join(TMP, 'helper.pid');
const SOCKS = path.join(TMP, 'socks');
await fs.mkdir(SOCKS);
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(TMP, 'bin', 'pactl'));
await fs.writeFile(path.join(TMP, 'pactl.json'), '{}');

/** A private dbus-daemon: one for KWin, one for the fake logind. */
const busConf = async (name) => {
  const dir = path.join(TMP, name);
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, 'bus.conf'),
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${dir}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
  );
  return execFileSync('dbus-daemon', ['--config-file', path.join(dir, 'bus.conf'), '--fork', '--print-address=1', '--print-pid=1']).toString().trim().split('\n');
};
const [kwinBus, kwinBusPid] = await busConf('kwin-bus');
const [systemBus, systemBusPid] = await busConf('system-bus');

const kwinEnv = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: kwinBus,
  XDG_CONFIG_HOME: path.join(TMP, 'config'),
  XDG_DATA_HOME: path.join(TMP, 'data'),
  XDG_STATE_HOME: path.join(TMP, 'state'),
  XDG_CACHE_HOME: path.join(TMP, 'cache'),
  QT_QPA_PLATFORM: 'offscreen',
};
delete kwinEnv.WAYLAND_DISPLAY;
delete kwinEnv.DISPLAY;
const kwin = spawn('kwin_wayland', ['--virtual', '--socket', SOCKET, '--width', '1920', '--height', '720', '--output-count', '2', '--no-lockscreen'], { env: kwinEnv, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let kwinLog = '';
kwin.stderr.on('data', (c) => (kwinLog += c));
const kwinGone = new Promise((resolve) => kwin.on('exit', resolve));

const { edid, fakeSysfs, ILITEK, ILITEK_NODES } = await import('./test/fake-sysfs.mjs');
const sysfs = fakeSysfs(TMP);
Object.assign(process.env, {
  PATH: `${path.join(TMP, 'bin')}:${process.env.PATH}`,
  FAKE_PACTL_STATE: path.join(TMP, 'pactl.json'),
  DECKHAND_DRM_DIR: sysfs.drm,
  DECKHAND_INPUT_DIR: sysfs.input,
  DECKHAND_UDEV_DATA_DIR: sysfs.udev,
  DECKHAND_DEV_INPUT_DIR: sysfs.dev,
  DECKHAND_PANEL_BIN: path.join(REPO, 'scripts/test/panel-shim.mjs'),
  DECKHAND_STATE_DIR: path.join(TMP, 'deckhand-state'),
  PANEL_SHIM_BIN: HELPER,
  PANEL_SHIM_PRESENT_LOG: PRESENTS,
  PANEL_SHIM_PID_FILE: PID_FILE,
  PANEL_SHIM_INPUT_DIR: SOCKS,
  WAYLAND_DISPLAY: SOCKET,
  DBUS_SYSTEM_BUS_ADDRESS: systemBus,
});

async function cleanup() {
  try {
    process.kill(-kwin.pid, 'SIGTERM');
  } catch {}
  const stopped = await Promise.race([kwinGone.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped) {
    try {
      process.kill(-kwin.pid, 'SIGKILL');
    } catch {}
  }
  for (const pid of [kwinBusPid, systemBusPid]) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
  await sleep(300);
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** CPU of a process in ms, from /proc (user + system). */
const TICK_MS = 1000 / Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
const cpuOf = (pid) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(fields[11]) + Number(fields[12])) * TICK_MS;
  } catch {
    return NaN;
  }
};
const ownCpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** round(1000 * (p / 100)^(1 / 2.2)): the helper's LIGHT table (panel/panel.c). */
const LIGHT = Array.from({ length: 101 }, (_, p) => Math.round(1000 * Math.pow(p / 100, 1 / 2.2)));
const atLevel = (rgb, p) => rgb.map((c) => (p === 100 ? c : Math.floor((c * LIGHT[p]) / 1000)));
const hexRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Every frame shown so far: { t, level, samples[96] as [r,g,b] }. */
const presents = async () =>
  (await fs.readFile(PRESENTS, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [t, level, ...hex] = line.split(' ');
      return { t: Number(t), level: Number(level), samples: hex.map(hexRgb) };
    })
    .filter((p) => p.samples.length === 96);
/** The grid's sample at column i, row j: the centre of that cell of the 1920 × 720 screen. */
const sampleAt = (i, j) => ({ x: ((2 * i + 1) * 1920) / 32, y: ((2 * j + 1) * 720) / 12 });

try {
  const up = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(path.join(process.env.XDG_RUNTIME_DIR, SOCKET))) return true;
      await sleep(100);
    }
    return false;
  })();
  check('a headless KWin on its own socket and bus', up, kwinLog.slice(-400));
  if (!up) throw new Error('no KWin');

  const { validateConfig } = await import(path.join(REPO, 'dist/config.js'));
  const { createVirtualDriver } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
  const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
  const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));
  const audio = await import(path.join(REPO, 'dist/services/audio.js'));
  const { startFakeLogind } = await import('./test/fake-logind.mjs');
  const sharp = (await import('sharp')).default;

  await sysfs.usbDevice('pci0/usb3/3-2.3', '222a');
  for (const node of ILITEK_NODES) await sysfs.inputNode(node);
  await sysfs.plug('Virtual-1', 'connected', edid({ maker: 'GRA', product: '6e4e', name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);

  // The page's background, a picture as on the maintainer's pages — the heaviest thing a full redraw sends.
  const BG = [64, 96, 192];
  const picture = path.join(TMP, 'ground.png');
  await sharp({ create: { width: 1920, height: 720, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } }).png().toFile(picture);
  // Four keys, each over one sample; the sliders between the samples (columns at x 780 and 900, 1020 and 1140).
  const KEYS = [
    { id: 'k1', x: 120, y: 120, color: [255, 32, 32] },
    { id: 'k2', x: 480, y: 120, color: [32, 255, 32] },
    { id: 'k3', x: 1320, y: 360, color: [255, 255, 32] },
    { id: 'k4', x: 1680, y: 480, color: [255, 32, 255] },
  ];
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const controls = [
    ...KEYS.map((k) => ({ id: k.id, x: k.x, y: k.y, w: 120, h: 120 })),
    { id: 'bright', x: 820, y: 60, w: 60, h: 600, kind: 'slider' },
    { id: 'vol', x: 1060, y: 60, w: 60, h: 600, kind: 'slider' },
  ];
  const KEY = 'GRA-6e4e';
  const HEADSET = 'alsa_output.usb-Example_Headset-00.analog-stereo';
  const config = validateConfig({
    decks: { [KEY]: { name: 'Panel', virtual: { output: 'Virtual-1', touch: ILITEK } } },
    profiles: {
      p: {
        layouts: {
          [KEY]: {
            startPage: 'main',
            pages: {
              main: {
                panel: { size: { width: 1920, height: 720 }, preset: 'free', controls },
                background: { color: hex(BG), image: picture },
                buttons: {
                  ...Object.fromEntries(KEYS.map((k) => [k.id, { background: hex(k.color) }])),
                  bright: { action: { type: 'brightness' } },
                  vol: { action: { type: 'audio.volume', node: HEADSET } },
                },
              },
            },
          },
        },
      },
    },
  });
  // Which samples fall on a key, a slider, or the background alone.
  const inBox = (s, b) => s.x >= b.x && s.x < b.x + b.w && s.y >= b.y && s.y < b.y + b.h;
  const keySamples = [];
  const groundSamples = [];
  for (let j = 0; j < 6; j++)
    for (let i = 0; i < 16; i++) {
      const s = sampleAt(i, j);
      const key = KEYS.find((k) => inBox(s, { ...k, w: 120, h: 120 }));
      const slider = controls.filter((c) => c.kind === 'slider').some((c) => inBox(s, c));
      if (key) keySamples.push({ at: j * 16 + i, color: key.color, id: key.id });
      else if (!slider) groundSamples.push(j * 16 + i);
    }
  check('the layout: a sample on each key, and the background sampled everywhere else (no slider under a sample)', keySamples.length === 4 && groundSamples.length === 92, `${keySamples.length} keys, ${groundSamples.length} background`);

  await startFakeLogind(systemBus);
  const driver = createVirtualDriver(() => config);
  const stopAudio = audio.subscribe(() => session?.invalidateByType(['audio.volume']));
  let session;
  const found = (await driver.list()).find((f) => f.id === KEY);
  if (!found) throw new Error('the virtual deck was not found');
  const device = await found.open();
  session = new DeckSession(device, {
    serial: KEY,
    hardware: config.decks[KEY],
    layout: config.profiles.p.layouts[KEY],
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'p',
    onActionNeeded: () => {},
  });
  await session.start();
  const helperPid = Number(await fs.readFile(PID_FILE, 'utf8'));

  /** A shown frame as it should be at its own level: the problems found in it. */
  const wrongIn = (p) => {
    const problems = [];
    const bg = atLevel(BG, p.level);
    const black = groundSamples.filter((at) => p.samples[at].every((v) => v <= 2)).length;
    const offGround = groundSamples.filter((at) => !near(p.samples[at], bg)).length;
    if (black > 0) problems.push(`black on ${black} of ${groundSamples.length} background samples`);
    else if (offGround > 0) problems.push(`the background not at its level on ${offGround} samples (${p.samples[groundSamples[0]]} for ${bg})`);
    const missing = keySamples.filter((k) => !near(p.samples[k.at], atLevel(k.color, p.level)));
    if (missing.length > 0) problems.push(`keys ${missing.map((k) => `${k.id} ${p.samples[k.at]}`).join(', ')} not their colour at ${p.level}`);
    return problems;
  };
  const settled = async () => {
    const all = await presents();
    return all.length > 0 && wrongIn(all.at(-1)).length === 0;
  };
  const ready = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await presents()).length > 0 && device.touchState() === 'ready' && (await settled())) return true;
      await sleep(50);
    }
    return false;
  };
  check('the page shown whole at 100: background, keys', await ready(10000), JSON.stringify((await presents()).at(-1) ? wrongIn((await presents()).at(-1)) : 'no frame'));
  await sleep(500);

  /** A finger: down on a control, moves every 8 ms down by `depth` and back up, then up. Resolves when it lifts. */
  const sock = path.join(SOCKS, 'Virtual-1.sock');
  const drag = (contact, id, depth, steps) =>
    new Promise((resolve, reject) => {
      const c = controls.find((k) => k.id === id);
      const x = c.x + c.w / 2;
      const y0 = c.y + c.h / 2;
      const lines = [{ ev: 'touch', contact, edge: 'down', x, y: y0 }];
      for (let i = 1; i <= steps; i++) {
        const f = i <= steps / 2 ? i / (steps / 2) : (steps - i) / (steps / 2);
        lines.push({ ev: 'touch', contact, edge: 'move', x, y: y0 + depth * f + (i % 2) });
      }
      lines.push({ ev: 'touch', contact, edge: 'up' });
      const conn = net.connect(sock, async () => {
        for (const line of lines) {
          conn.write(JSON.stringify(line) + '\n');
          await sleep(8);
        }
        conn.end(() => resolve(lines.length - 2));
      });
      conn.on('error', reject);
    });
  const cpuNow = () => ({ own: ownCpu(), helper: cpuOf(helperPid), kwin: cpuOf(kwin.pid) });
  const spent = (a, b) => ({ own: b.own - a.own, helper: b.helper - a.helper, kwin: b.kwin - a.kwin });

  // ---- VOLUME, the same drag, for the cost ----
  console.log('a Volume slider dragged the same way, for comparison');
  const cpu2 = cpuNow();
  const vsteps = await drag(2, 'vol', 640, 120);
  await sleep(2500);
  const volCost = spent(cpu2, cpuNow());
  console.log(`    ${vsteps} moves; CPU per move: daemon ${(volCost.own / vsteps).toFixed(2)} ms, helper ${(volCost.helper / vsteps).toFixed(2)} ms, KWin ${(volCost.kwin / vsteps).toFixed(2)} ms`);
  // ---- BRIGHTNESS, dragged fast: to the bottom and back ----
  console.log('a Brightness slider dragged fast, to the bottom and back');
  const shownBefore = (await presents()).length;
  const cpu0 = cpuNow();
  let lowest = session.currentBrightness();
  const watch = setInterval(() => (lowest = Math.min(lowest, session.currentBrightness())), 2);
  const steps = await drag(1, 'bright', 640, 120);
  const liftedAt = Date.now();
  clearInterval(watch);
  // Give a backlog every chance to show itself: well past the 250 ms allowed.
  await sleep(2500);
  const cpu1 = cpuNow();
  const shown = (await presents()).slice(shownBefore);
  const finalLevel = session.currentBrightness();
  const levels = [...new Set(shown.map((p) => p.level))];
  check('the drag reached the bottom (5) and came back up', lowest === 5 && finalLevel > 50, `lowest ${lowest}; final ${finalLevel}; levels shown ${levels.join(',')}`);
  const bad = shown.map((p) => ({ p, problems: wrongIn(p) })).filter((x) => x.problems.length > 0);
  const blackouts = bad.filter((x) => x.problems.some((m) => m.startsWith('black')));
  const flashes = bad.filter((x) => x.problems.some((m) => m.startsWith('keys')));
  check('no blackout: no frame shown with the background black', blackouts.length === 0, `${blackouts.length} of ${shown.length} frames; first at +${blackouts[0] ? blackouts[0].p.t - liftedAt : 0} ms from the lift: ${blackouts[0]?.problems.join('; ')}`);
  check('no flash: every frame shown has every key, in its colour at that frame\'s level', flashes.length === 0, `${flashes.length} of ${shown.length} frames: ${flashes[0]?.problems.join('; ')}`);
  check('every frame shown is whole and at one level: the background at that level too', bad.length === 0, `${bad.length} of ${shown.length} frames wrong: ${bad[0]?.problems.join('; ')}`);
  const atFinal = shown.findIndex((p, i) => p.level === finalLevel && shown.slice(i).every((q) => q.level === finalLevel) && wrongIn(p).length === 0);
  const settleMs = atFinal >= 0 ? shown[atFinal].t - liftedAt : null;
  const lastMs = shown.length > 0 ? shown.at(-1).t - liftedAt : null;
  check('no backlog: within 250 ms of the lift the screen is whole at the session\'s level, and nothing older is shown after it', atFinal >= 0 && settleMs <= 250, `settled at ${settleMs} ms; last frame at ${lastMs} ms; final level ${finalLevel}; last shown ${shown.at(-1)?.level}`);
  const brightCost = spent(cpu0, cpu1);
  console.log(`    ${steps} moves, ${shown.length} frames shown, last at +${lastMs} ms from the lift; CPU per move: daemon ${(brightCost.own / steps).toFixed(2)} ms, helper ${(brightCost.helper / steps).toFixed(2)} ms, KWin ${(brightCost.kwin / steps).toFixed(2)} ms`);

  const per = (c, n) => (c.own + c.helper + c.kwin) / n;
  console.log(`    in all per move: brightness ${per(brightCost, steps).toFixed(2)} ms, volume ${per(volCost, vsteps).toFixed(2)} ms`);
  // A level changes every pixel, so each frame shown re-dims the whole screen (3–5 ms at 1920 × 720): a brightness move
  // costs more than a volume move's redraw of one slider. A full redraw per move (before the fix) cost about five times as much.
  // At most three times, not two: the ratio depends on the processor as well as the code. A volume move is mostly the daemon's
  // JavaScript, a brightness move mostly pixels in the helper and the compositor, and a faster processor shortens the first
  // more than the second; on one with fast and slow cores, where each process lands moves it again. Measured there with the
  // same code: 1.9–2.7 times, against about 1.3–2.0 on the machine the check was written on.
  check('a brightness drag costs at most three times a volume drag per move — never a redraw of the page per move', per(brightCost, steps) <= per(volCost, vsteps) * 3, `brightness ${per(brightCost, steps).toFixed(2)} ms, volume ${per(volCost, vsteps).toFixed(2)} ms`);

  // ---- AT REST ----
  const rest0 = cpuNow();
  const restShown = (await presents()).length;
  await sleep(2000);
  const rest = spent(rest0, cpuNow());
  check('at rest: no frame shown, the helper uses no CPU', (await presents()).length === restShown && rest.helper === 0, `${(await presents()).length - restShown} frames, helper ${rest.helper} ms`);

  stopAudio();
  // Bounded: a helper still working through a backlog (the bug this checks for) must not hang the run.
  await Promise.race([Promise.resolve(session.close?.()).then(() => device.close()), sleep(5000)]);
} catch (err) {
  check('the run', false, err.stack ?? String(err));
} finally {
  await cleanup();
}
console.log(failures === 0 ? 'brightness drag: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
