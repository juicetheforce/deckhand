/**
 * The real display helper (panel/deckhand-panel) under a headless KWin:
 *
 * - it finds an output by name and shows a layer-shell surface on it, and
 *   says so ("ready", the output's size);
 * - the canvas is drawn scaled to fit, on its background; an opaque image
 *   lands where it was sent, scaled with the canvas; a half-transparent one
 *   is blended over the background; every image is answered "drawn";
 * - an output that does not exist is refused, exit 2, with the reason;
 * - at rest it uses no CPU at all;
 * - **touch, from recorded evdev frames** (FIFOs, read with
 *   --touch-test-range): multitouch contacts reported down at their place on
 *   the canvas — through its scale and, letterboxed, its origin — and up when
 *   lifted; a lift never seen down, and movement, report nothing; after
 *   SYN_DROPPED every contact is lifted and a slot needs a new contact; a
 *   sibling is read and says nothing; pairing names the first touchscreen
 *   touched, single-touch, once; a device going away says so; a path that is
 *   not an input device is refused without the test flag. The grab itself is
 *   checked only on hardware.
 *
 * KWin runs with `--virtual` (no screen, no input devices), on its own
 * Wayland socket and **a D-Bus of its own that can start no services** — a
 * headless KWin on a normal session bus starts the portals, and they attach
 * to the real display (learned 2026-10-15). Its config and state go to a
 * scratch directory. Skipped, saying so, where kwin_wayland or the helper's
 * build is missing.
 *
 *   make -C panel && node scripts/smoke-panel.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HELPER = path.join(REPO, 'panel/deckhand-panel');
const { canvasFrame, imageFrame, quitFrame, touchFrame } = await import(path.join(REPO, 'dist/drivers/panel-frames.js'));
import { openSync, writeSync, closeSync } from 'node:fs';

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
  console.log(`panel: skipped — ${!which('kwin_wayland') ? 'no kwin_wayland on this machine' : `no helper at ${HELPER} (make -C panel)`}`);
  process.exit(0);
}

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-panel-'));
const SOCKET = `dh-panel-${process.pid}`;
const runtime = process.env.XDG_RUNTIME_DIR;
await fs.writeFile(
  path.join(TMP, 'bus.conf'),
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${TMP}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
);
const busOut = execFileSync('dbus-daemon', ['--config-file', path.join(TMP, 'bus.conf'), '--fork', '--print-address=1', '--print-pid=1']).toString().trim().split('\n');
const [busAddress, busPid] = busOut;
const env = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: busAddress,
  XDG_CONFIG_HOME: path.join(TMP, 'config'),
  XDG_DATA_HOME: path.join(TMP, 'data'),
  XDG_STATE_HOME: path.join(TMP, 'state'),
  XDG_CACHE_HOME: path.join(TMP, 'cache'),
  QT_QPA_PLATFORM: 'offscreen',
};
delete env.WAYLAND_DISPLAY;
delete env.DISPLAY;
const kwin = spawn('kwin_wayland', ['--virtual', '--socket', SOCKET, '--width', '1920', '--height', '720', '--output-count', '2', '--no-lockscreen'], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
});
let kwinLog = '';
kwin.stderr.on('data', (c) => (kwinLog += c));

const kwinGone = new Promise((resolve) => kwin.on('exit', resolve));
async function cleanup() {
  try {
    process.kill(-kwin.pid, 'SIGTERM');
  } catch {}
  // KWin takes a moment to stop; it and everything it started (its process
  // group) are gone before this returns.
  const stopped = await Promise.race([kwinGone.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped) {
    try {
      process.kill(-kwin.pid, 'SIGKILL');
    } catch {}
  }
  try {
    process.kill(Number(busPid), 'SIGTERM');
  } catch {}
  await sleep(300);
  await fs.rm(TMP, { recursive: true, force: true });
}

try {
  const up = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(path.join(runtime, SOCKET))) return true;
      await sleep(100);
    }
    return false;
  })();
  check('a headless KWin on its own socket and bus', up, kwinLog.slice(-400));
  const helperEnv = { ...env, WAYLAND_DISPLAY: SOCKET };

  /** Run the helper; collect its JSON lines. */
  function helper(args) {
    const proc = spawn(HELPER, args, { env: helperEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    readline.createInterface({ input: proc.stdout }).on('line', (line) => events.push(JSON.parse(line)));
    const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
    return { proc, events, exited };
  }
  async function until(fn, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(20);
    }
    return false;
  }

  console.log('an output that does not exist');
  const bad = helper(['--output', 'HDMI-A-9']);
  const badCode = await bad.exited;
  check('refused: exit 2, saying which', badCode === 2 && bad.events.some((e) => e.ev === 'error' && /HDMI-A-9/.test(e.message)), JSON.stringify({ badCode, events: bad.events }));

  console.log('a panel on Virtual-1');
  const dump = path.join(TMP, 'screen.ppm');
  const h = helper(['--output', 'Virtual-1', '--dump', dump]);
  const ready = await until(() => h.events.some((e) => e.ev === 'ready'));
  const r = h.events.find((e) => e.ev === 'ready');
  check('ready: the output, its size, a layer-shell surface', ready && r.output === 'Virtual-1' && r.width === 1920 && r.height === 720 && r.surface === 'layer-shell', JSON.stringify(r));

  // At rest, nothing: CPU time does not move while nothing is sent.
  const cpu = async () => {
    const stat = (await fs.readFile(`/proc/${h.proc.pid}/stat`, 'utf8')).split(') ')[1].split(' ');
    return Number(stat[11]) + Number(stat[12]);
  };
  await sleep(300);
  const before = await cpu();
  await sleep(3000);
  const after = await cpu();
  check(`at rest for 3 s: no CPU time used (${after - before} ticks)`, after === before);

  // A 960 × 360 canvas on a 1920 × 720 screen: drawn at twice its size.
  h.proc.stdin.write(canvasFrame(960, 360, [10, 20, 30]));
  h.proc.stdin.write(imageFrame(100, 50, 10, 10, Buffer.alloc(10 * 10 * 4).fill(Buffer.from([255, 0, 0, 255]))));
  h.proc.stdin.write(imageFrame(300, 100, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 255, 0, 128]))));
  const drawn = await until(() => h.events.filter((e) => e.ev === 'drawn').length === 2);
  check('each image answered "drawn"', drawn, JSON.stringify(h.events));
  h.proc.stdin.write(quitFrame());
  const code = await h.exited;
  check('quit: exit 0', code === 0, String(code));

  const ppm = await fs.readFile(dump);
  const header = ppm.subarray(0, 20).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/);
  const offset = header[0].length;
  const at = (x, y) => [...ppm.subarray(offset + (y * 1920 + x) * 3, offset + (y * 1920 + x) * 3 + 3)];
  check('the dump is the screen: 1920 × 720', header && header[1] === '1920' && header[2] === '720');
  check('the background everywhere nothing was drawn', JSON.stringify(at(5, 5)) === '[10,20,30]' && JSON.stringify(at(1900, 700)) === '[10,20,30]', JSON.stringify([at(5, 5), at(1900, 700)]));
  check('an opaque image at its place, scaled with the canvas (100,50 → 200..219, 100..119)',
    JSON.stringify(at(200, 100)) === '[255,0,0]' && JSON.stringify(at(219, 119)) === '[255,0,0]' && JSON.stringify(at(199, 110)) === '[10,20,30]' && JSON.stringify(at(220, 110)) === '[10,20,30]',
    JSON.stringify([at(200, 100), at(219, 119), at(199, 110), at(220, 110)]));
  const [rr, gg, bb] = at(602, 202);
  check(`a half-transparent image blended over the background (${rr},${gg},${bb} ≈ 5,138,15)`, Math.abs(rr - 5) <= 1 && Math.abs(gg - 138) <= 1 && Math.abs(bb - 15) <= 1);

  console.log('touch, from recorded frames');
  // struct input_event on x86_64: two longs of time, u16 type, u16 code, s32 value.
  const EV = { SYN: 0, KEY: 1, ABS: 3 };
  const C = { REPORT: 0, DROPPED: 3, BTN_TOUCH: 0x14a, ABS_X: 0, ABS_Y: 1, SLOT: 0x2f, MT_X: 0x35, MT_Y: 0x36, TRACKING: 0x39 };
  const ev = (type, code, value) => {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(type, 16);
    b.writeUInt16LE(code, 18);
    b.writeInt32LE(value, 20);
    return b;
  };
  const syn = () => ev(EV.SYN, C.REPORT, 0);
  const fifo = (name) => {
    const p = path.join(TMP, name);
    execFileSync('mkfifo', [p]);
    // Read and write, so the FIFO has a writer before the helper opens it,
    // and its end of input comes only when this closes it.
    return { path: p, fd: openSync(p, 'r+') };
  };
  const send = (f, ...events) => writeSync(f.fd, Buffer.concat(events));
  const touches = (t, from) => t.events.slice(from).filter((e) => e.ev === 'touch');

  const touch = fifo('touch');
  const sibling = fifo('sibling');
  const t = helper(['--output', 'Virtual-1', '--touch-test-range', '1000']);
  await until(() => t.events.some((e) => e.ev === 'ready'));
  t.proc.stdin.write(canvasFrame(960, 360));
  t.proc.stdin.write(touchFrame(1, [['t', touch.path], ['s', sibling.path]]));
  check('both devices opened', await until(() => t.events.filter((e) => e.ev === 'touch-open').length === 2), JSON.stringify(t.events));

  let mark = t.events.length;
  send(touch, ev(EV.ABS, C.SLOT, 0), ev(EV.ABS, C.TRACKING, 5), ev(EV.ABS, C.MT_X, 500), ev(EV.ABS, C.MT_Y, 250), syn());
  send(touch, ev(EV.ABS, C.SLOT, 1), ev(EV.ABS, C.TRACKING, 6), ev(EV.ABS, C.MT_X, 100), ev(EV.ABS, C.MT_Y, 900), syn());
  await until(() => touches(t, mark).length === 2);
  let seen = touches(t, mark);
  check('two fingers: each down at its place on the canvas (scale 2: 0.5,0.25 → 480,90; 0.1,0.9 → 96,324)',
    seen.length === 2 && seen[0].contact === 0 && seen[0].edge === 'down' && seen[0].x === 480 && seen[0].y === 90 && seen[1].contact === 1 && seen[1].x === 96 && seen[1].y === 324,
    JSON.stringify(seen));
  mark = t.events.length;
  send(touch, ev(EV.ABS, C.SLOT, 1), ev(EV.ABS, C.MT_X, 300), syn());
  send(touch, ev(EV.ABS, C.SLOT, 3), ev(EV.ABS, C.TRACKING, -1), syn());
  send(sibling, ev(EV.KEY, C.BTN_TOUCH, 1), ev(EV.ABS, C.ABS_X, 10), ev(EV.ABS, C.ABS_Y, 10), syn(), ev(EV.KEY, C.BTN_TOUCH, 0), syn());
  send(touch, ev(EV.ABS, C.SLOT, 0), ev(EV.ABS, C.TRACKING, -1), syn());
  await until(() => touches(t, mark).length >= 1);
  await sleep(150);
  seen = touches(t, mark);
  check('a finger moving, a lift never seen down and a sibling\'s touch report nothing; a lift reports up', seen.length === 1 && seen[0].contact === 0 && seen[0].edge === 'up', JSON.stringify(seen));

  mark = t.events.length;
  send(touch, ev(EV.SYN, C.DROPPED, 0), ev(EV.ABS, C.SLOT, 2), ev(EV.ABS, C.TRACKING, 9), syn());
  await until(() => touches(t, mark).length >= 1);
  send(touch, ev(EV.ABS, C.SLOT, 1), ev(EV.ABS, C.MT_Y, 100), syn());
  send(touch, ev(EV.ABS, C.SLOT, 1), ev(EV.ABS, C.TRACKING, -1), syn(), ev(EV.ABS, C.TRACKING, 7), ev(EV.ABS, C.MT_X, 0), ev(EV.ABS, C.MT_Y, 0), syn());
  await until(() => touches(t, mark).length >= 2);
  await sleep(150);
  seen = touches(t, mark);
  check('SYN_DROPPED: the finger still down is lifted, what came with the drop ignored, and its slot down again only with a new contact',
    seen.length === 2 && seen[0].contact === 1 && seen[0].edge === 'up' && seen[1].contact === 1 && seen[1].edge === 'down' && seen[1].x === 0 && seen[1].y === 0,
    JSON.stringify(seen));

  mark = t.events.length;
  t.proc.stdin.write(canvasFrame(1000, 360));
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.TRACKING, 11), ev(EV.ABS, C.MT_X, 500), ev(EV.ABS, C.MT_Y, 500), syn());
  await until(() => touches(t, mark).length >= 1);
  seen = touches(t, mark);
  check('letterboxed (1000 × 360 on 1920 × 720: scale 1.92, 14 px down): the middle of the screen is 500, 180.2', seen[0]?.x === 500 && seen[0]?.y === 180.2, JSON.stringify(seen));

  mark = t.events.length;
  closeSync(touch.fd);
  check('the touchscreen going away: its contacts lifted, and said', await until(() => t.events.slice(mark).some((e) => e.ev === 'touch-gone' && e.device === touch.path)) && touches(t, mark).some((e) => e.contact === 4 && e.edge === 'up'), JSON.stringify(t.events.slice(mark)));
  check('…the panel stays', t.proc.exitCode === null);

  console.log('pairing');
  const a = fifo('pair-a');
  const b = fifo('pair-b');
  mark = t.events.length;
  t.proc.stdin.write(touchFrame(2, [['t', a.path], ['t', b.path]]));
  await until(() => t.events.slice(mark).filter((e) => e.ev === 'touch-open').length === 2);
  send(b, ev(EV.KEY, C.BTN_TOUCH, 1), ev(EV.ABS, C.ABS_X, 400), ev(EV.ABS, C.ABS_Y, 400), syn());
  await until(() => t.events.slice(mark).some((e) => e.ev === 'tap'));
  send(a, ev(EV.KEY, C.BTN_TOUCH, 1), ev(EV.ABS, C.ABS_X, 400), ev(EV.ABS, C.ABS_Y, 400), syn());
  await sleep(150);
  const taps = t.events.slice(mark).filter((e) => e.ev === 'tap');
  check('the first touchscreen touched is named, once, and no touch is reported', taps.length === 1 && taps[0].device === b.path && touches(t, mark).length === 0, JSON.stringify(t.events.slice(mark)));
  t.proc.stdin.write(quitFrame());
  check('quit: exit 0', (await t.exited) === 0);
  for (const f of [sibling, a, b]) closeSync(f.fd);

  const strict = helper(['--output', 'Virtual-1']);
  await until(() => strict.events.some((e) => e.ev === 'ready'));
  const notDevice = fifo('not-a-device');
  strict.proc.stdin.write(touchFrame(1, [['t', notDevice.path]]));
  check('without the test flag, a path that is not an input device is refused', await until(() => strict.events.some((e) => e.ev === 'touch-failed' && /not an input device/.test(e.message))), JSON.stringify(strict.events));
  strict.proc.stdin.write(quitFrame());
  await strict.exited;
  closeSync(notDevice.fd);
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\npanel: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
