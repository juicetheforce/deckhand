/**
 * The real display helper (panel/deckhand-panel) under a headless KWin:
 *
 * - it finds an output by name and shows a layer-shell surface on it, and
 *   says so ("ready", the output's size);
 * - the canvas is drawn scaled to fit, on its background; an opaque image
 *   lands where it was sent, scaled with the canvas; a half-transparent one
 *   is blended over the background; every image is answered "drawn";
 * - an output that does not exist is refused, exit 2, with the reason;
 * - at rest it uses no CPU at all.
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
const { canvasFrame, imageFrame, quitFrame } = await import(path.join(REPO, 'dist/drivers/panel-frames.js'));

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
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\npanel: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
