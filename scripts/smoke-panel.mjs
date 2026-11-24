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
 *   lifted; a lift never seen down, and movement, report nothing, until the
 *   daemon follows a contact (M): then it is reported moved, once per frame,
 *   until it lifts; after
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
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HELPER = path.join(REPO, 'panel/deckhand-panel');
const { brightnessFrame, canvasFrame, followFrame, groundFrame, imageFrame, imageFrameParts, quitFrame, touchFrame } = await import(path.join(REPO, 'dist/drivers/panel-frames.js'));
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
  // As the daemon sends a key (imageFrameParts): its head, then its pixels, in
  // two writes — here a moment apart, so the helper gets them in two reads.
  const [redHead, redPixels] = imageFrameParts(100, 50, 10, 10, Buffer.alloc(10 * 10 * 4).fill(Buffer.from([255, 0, 0, 255])));
  h.proc.stdin.write(redHead);
  await sleep(150);
  h.proc.stdin.write(redPixels);
  h.proc.stdin.write(imageFrame(300, 100, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 255, 0, 128]))));
  // An image is placed over the background, never over what was there
  // (custom layouts, round 2a): a clear image where an opaque one was leaves
  // the background, and a soft edge drawn twice is the same as once.
  h.proc.stdin.write(imageFrame(400, 100, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([255, 255, 255, 255]))));
  h.proc.stdin.write(imageFrame(400, 100, 4, 4, Buffer.alloc(4 * 4 * 4)));
  h.proc.stdin.write(imageFrame(500, 100, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 255, 0, 128]))));
  h.proc.stdin.write(imageFrame(500, 100, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 255, 0, 128]))));
  const drawn = await until(() => h.events.filter((e) => e.ev === 'drawn').length === 6);
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
  check('a clear image where an opaque one was: the background again, nothing of the old one', JSON.stringify(at(802, 202)) === '[10,20,30]', JSON.stringify(at(802, 202)));
  const twice = at(1002, 202);
  check(`a half-transparent image drawn twice is drawn once: over the background, not over itself (${twice})`, Math.abs(twice[0] - 5) <= 1 && Math.abs(twice[1] - 138) <= 1 && Math.abs(twice[2] - 15) <= 1);

  console.log('the output going away and coming back');
  // KWin removes a screen's output when it wakes from power saving and adds it
  // back; the helper waits for it rather than exiting. kscreen-doctor disables
  // and enables the headless KWin's output, which does the same to the
  // output's global.
  if (!which('kscreen-doctor')) {
    console.log('  not checked here: no kscreen-doctor on this machine');
  } else {
    const kd = (what) => new Promise((resolve) => execFile('kscreen-doctor', [`output.Virtual-1.${what}`], { env: { ...helperEnv, QT_QPA_PLATFORM: 'wayland' }, timeout: 15000 }, (err) => resolve(!err)));
    const dump2 = path.join(TMP, 'back.ppm');
    const w = helper(['--output', 'Virtual-1', '--dump', dump2]);
    await until(() => w.events.some((e) => e.ev === 'ready'));
    const count = (ev) => w.events.filter((e) => e.ev === ev).length;
    const pid = w.proc.pid;
    const ticks = async () => {
      const stat = (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ');
      return Number(stat[11]) + Number(stat[12]);
    };
    for (const round of [1, 2]) {
      check(`round ${round}: the output disabled: "output-lost", and the helper stays`, (await kd('disable')) && (await until(() => count('output-lost') === round)) && w.proc.exitCode === null, JSON.stringify(w.events));
      w.proc.stdin.write(imageFrame(0, 0, 4, 4, Buffer.alloc(4 * 4 * 4, 255)));
      check(`round ${round}: drawing goes on meanwhile, answered "drawn"`, await until(() => count('drawn') === round));
      if (round === 1) {
        await sleep(300);
        const t0 = await ticks();
        await sleep(2000);
        const t1 = await ticks();
        check(`waiting for the output for 2 s: no CPU time used (${t1 - t0} ticks)`, t1 === t0);
      }
      check(`round ${round}: enabled again: "ready" again, on the same output`, (await kd('enable')) && (await until(() => count('ready') === round + 1)) && w.events.filter((e) => e.ev === 'ready').at(-1).output === 'Virtual-1', JSON.stringify(w.events));
    }
    w.proc.stdin.write(canvasFrame(1920, 720, [1, 2, 3]));
    w.proc.stdin.write(imageFrame(500, 300, 8, 8, Buffer.alloc(8 * 8 * 4).fill(Buffer.from([0, 0, 255, 255]))));
    await until(() => count('drawn') === 3);
    w.proc.stdin.write(quitFrame());
    check('quit after: exit 0', (await w.exited) === 0);
    const back = await fs.readFile(dump2);
    const head2 = back.subarray(0, 20).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/);
    const px = (x, y) => JSON.stringify([...back.subarray(head2[0].length + (y * 1920 + x) * 3, head2[0].length + (y * 1920 + x) * 3 + 3)]);
    check('what is drawn once it is back is on the screen', px(503, 303) === '[0,0,255]' && px(10, 10) === '[1,2,3]', JSON.stringify([px(503, 303), px(10, 10)]));
  }

  console.log('a virtual deck\'s button outline, on the screen');
  {
    // Faces as the daemon renders them for a virtual deck (deck.ts: outline on), at 1:1, on black:
    // the outline is OUTLINE_PX of light line inside each shape's edge, the fill inward of it, and
    // nothing outside the shape — every shape by the one rule (Ryan, 2026-11-20).
    const { renderFace, OUTLINE_PX } = await import(path.join(REPO, 'dist/render.js'));
    const key = { background: { r: 16, g: 16, b: 20, alpha: 1 } };
    const shots = path.join(TMP, 'outline.ppm');
    const o = helper(['--output', 'Virtual-1', '--dump', shots]);
    await until(() => o.events.some((e) => e.ev === 'ready'));
    o.proc.stdin.write(canvasFrame(1920, 720, [0, 0, 0]));
    const faces = [
      ['rectangle', 100],
      ['round', 300],
      ['hexagon', 500],
    ];
    for (const [shape, x] of faces) {
      for (const part of imageFrameParts(x, 100, 120, 120, await renderFace(key, { width: 120, height: 120, shape, outline: true }))) o.proc.stdin.write(part);
    }
    await until(() => o.events.filter((e) => e.ev === 'drawn').length === faces.length);
    o.proc.stdin.write(quitFrame());
    await o.exited;
    const shot = await fs.readFile(shots);
    const head = shot.subarray(0, 20).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/);
    const px = (x, y) => [...shot.subarray(head[0].length + (y * 1920 + x) * 3, head[0].length + (y * 1920 + x) * 3 + 3)];
    const light = (p) => p[0] > 50 && p[0] < 90 && Math.abs(p[0] - p[1]) <= 2;
    const fill = (p) => JSON.stringify(p) === '[16,16,20]';
    const black = (p) => JSON.stringify(p) === '[0,0,0]';
    // Across the middle row (y 160) from the left edge of each box: a hexagon's side corner is there too.
    for (const [shape, x] of faces) {
      const row = [x - 1, x, x + OUTLINE_PX - 1, x + OUTLINE_PX, x + 60].map((xx) => px(xx, 160));
      check(`${shape}: outside black, ${OUTLINE_PX} px of light outline inside the edge, then the fill`, black(row[0]) && light(row[1]) && light(row[2]) && fill(row[3]) && fill(row[4]), JSON.stringify(row));
    }
    check('a round button\'s box corner, outside its shape: black, no outline there', black(px(301, 101)), JSON.stringify(px(301, 101)));
    check('a rectangle\'s corner is outlined on both edges', light(px(100, 100)) && light(px(101, 101)) && fill(px(102, 102)), JSON.stringify([px(100, 100), px(101, 101), px(102, 102)]));
  }

  console.log('drawn darker, by the deck\'s brightness');
  {
    const shots = path.join(TMP, 'dim.ppm');
    const d = helper(['--output', 'Virtual-1', '--dump', shots]);
    await until(() => d.events.some((e) => e.ev === 'ready'));
    // As the daemon does: the level, then the canvas and every key again.
    const redraw = (percent) => {
      d.proc.stdin.write(brightnessFrame(percent));
      d.proc.stdin.write(canvasFrame(960, 360, [100, 200, 40]));
      d.proc.stdin.write(imageFrame(10, 10, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([200, 100, 50, 255]))));
      d.proc.stdin.write(imageFrame(30, 10, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 0, 0, 128]))));
    };
    const pixels = async (percent) => {
      redraw(percent);
      const drawn = d.events.filter((e) => e.ev === 'drawn').length;
      await until(() => d.events.filter((e) => e.ev === 'drawn').length >= drawn);
      await sleep(200);
    };
    await pixels(50);
    d.proc.stdin.write(quitFrame());
    check('quit: exit 0', (await d.exited) === 0);
    const read = async () => {
      const ppm = await fs.readFile(shots);
      const off = ppm.subarray(0, 20).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/)[0].length;
      return (x, y) => [...ppm.subarray(off + (y * 1920 + x) * 3, off + (y * 1920 + x) * 3 + 3)];
    };
    let px = await read();
    // A level is light given off, as a backlight's: a stored value is scaled by (level / 100)^(1 / 2.2) — 0.73 at 50.
    check('at 50: the key and the background give off half the light (values × 0.73)', JSON.stringify(px(24, 24)) === '[146,73,36]' && JSON.stringify(px(5, 5)) === '[73,146,29]', JSON.stringify([px(24, 24), px(5, 5)]));
    check('at 50: a half-transparent key blends over the dimmed background', Math.abs(px(64, 24)[1] - 73) <= 1, JSON.stringify(px(64, 24)));
    // At 5, the floor: still visibly lit, as a Stream Deck at 5 is — white at 65 of 255 (× 0.256), never 12.
    const f = helper(['--output', 'Virtual-1', '--dump', shots]);
    await until(() => f.events.some((e) => e.ev === 'ready'));
    f.proc.stdin.write(brightnessFrame(5));
    f.proc.stdin.write(canvasFrame(960, 360, [255, 255, 255]));
    await until(() => f.events.some((e) => e.ev === 'drawn'));
    f.proc.stdin.write(quitFrame());
    await f.exited;
    px = await read();
    check('at 5, the lowest a key or slider sets: visibly lit — white drawn at 65 of 255', JSON.stringify(px(5, 5)) === '[65,65,65]', JSON.stringify(px(5, 5)));
    const z = helper(['--output', 'Virtual-1', '--dump', shots]);
    await until(() => z.events.some((e) => e.ev === 'ready'));
    z.proc.stdin.write(brightnessFrame(0));
    z.proc.stdin.write(canvasFrame(960, 360, [100, 200, 40]));
    z.proc.stdin.write(imageFrame(10, 10, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([200, 100, 50, 255]))));
    await until(() => z.events.some((e) => e.ev === 'drawn'));
    z.proc.stdin.write(quitFrame());
    await z.exited;
    px = await read();
    check('at 0: pure black, key and background', JSON.stringify(px(24, 24)) === '[0,0,0]' && JSON.stringify(px(5, 5)) === '[0,0,0]', JSON.stringify([px(24, 24), px(5, 5)]));
    const bad = helper(['--output', 'Virtual-1']);
    await until(() => bad.events.some((e) => e.ev === 'ready'));
    const head = Buffer.alloc(6);
    head.writeUInt32LE(2, 0);
    head[4] = 'B'.charCodeAt(0);
    head[5] = 101;
    bad.proc.stdin.write(head);
    check('a level above 100 is refused', (await bad.exited) === 5 && bad.events.some((e) => e.ev === 'error'), JSON.stringify(bad.events));
  }

  console.log("a page's background: a colour, a picture, an opacity, over the whole screen");
  {
    const shots = path.join(TMP, 'ground.ppm');
    /**
     * Run a helper with the protocol traced, send frames, and read back its pixels, the alpha KWin is given, the
     * formats of the buffers it gave KWin, and each opaque region it set, in order: 'all' (the whole 1920 × 720
     * surface), 'none' (nil), or the region's rectangle when it is anything else.
     */
    const run = async (send, waitDrawn) => {
      const proc = spawn(HELPER, ['--output', 'Virtual-1', '--dump', shots], { env: { ...helperEnv, WAYLAND_DEBUG: 'client' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const events = [];
      let trace = '';
      proc.stderr.on('data', (c) => (trace += c));
      readline.createInterface({ input: proc.stdout }).on('line', (line) => events.push(JSON.parse(line)));
      const exited = new Promise((resolve) => proc.on('exit', resolve));
      await until(() => events.some((e) => e.ev === 'ready'));
      send(proc.stdin);
      await until(() => events.filter((e) => e.ev === 'drawn').length >= waitDrawn);
      await sleep(200);
      proc.stdin.write(quitFrame());
      const code = await exited;
      const ppm = await fs.readFile(shots);
      const alpha = await fs.readFile(shots + '.alpha');
      const off = ppm.subarray(0, 20).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/)[0].length;
      const aoff = alpha.subarray(0, 20).toString('latin1').match(/^P5\n(\d+) (\d+)\n255\n/)[0].length;
      // wl_shm_pool.create_buffer(new id, offset, width, height, stride, format): 0 ARGB8888, 1 XRGB8888.
      const formats = [...trace.matchAll(/wl_shm_pool#\d+\.create_buffer\(new id wl_buffer#\d+, \d+, \d+, \d+, \d+, (\d+)\)/g)].map((m) => Number(m[1]));
      const added = new Map([...trace.matchAll(/ wl_region#(\d+)\.add\((-?\d+), (-?\d+), (-?\d+), (-?\d+)\)/g)].map((m) => [m[1], m.slice(2, 6).join(',')]));
      const opaque = [...trace.matchAll(/ wl_surface#\d+\.set_opaque_region\((?:wl_region#(\d+)|nil)\)/g)].map((m) =>
        m[1] === undefined ? 'none' : added.get(m[1]) === '0,0,1920,720' ? 'all' : `region ${added.get(m[1])}`,
      );
      // Whether the surface was declared opaque before its first buffer was attached (so its first frame is).
      const firstAttach = trace.search(/ wl_surface#\d+\.attach\(wl_buffer#/);
      const firstOpaque = trace.search(/ wl_surface#\d+\.set_opaque_region\(wl_region#/);
      return {
        code,
        formats,
        opaque,
        opaqueFirst: firstOpaque !== -1 && firstAttach !== -1 && firstOpaque < firstAttach,
        px: (x, y) => [...ppm.subarray(off + (y * 1920 + x) * 3, off + (y * 1920 + x) * 3 + 3), alpha[aoff + y * 1920 + x]],
      };
    };
    const key = (x) => imageFrame(x, 10, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([200, 100, 50, 255])));
    const halfKey = (x) => imageFrame(x, 10, 4, 4, Buffer.alloc(4 * 4 * 4).fill(Buffer.from([0, 0, 0, 128])));

    // A helper given nothing to draw: opaque black, alpha 255 — never a clear canvas showing what is behind.
    let g = await run(() => undefined, 0);
    check('a new panel, nothing drawn yet: opaque black (0,0,0,255)', g.code === 0 && JSON.stringify(g.px(5, 5)) === '[0,0,0,255]' && JSON.stringify(g.px(1900, 700)) === '[0,0,0,255]', JSON.stringify([g.px(5, 5), g.px(1900, 700)]));

    // Fully opaque: ARGB8888 buffers, alpha 255, the whole surface declared opaque. Always ARGB8888, because
    // KWin 6.7 and earlier (desktop OpenGL) keep a surface's texture in its first buffer's format.
    g = await run((w) => {
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([20, 40, 60], 255));
      w.write(key(10));
    }, 1);
    check('a background at 100%: its colour everywhere, opaque', g.code === 0 && JSON.stringify(g.px(5, 5)) === '[20,40,60,255]' && JSON.stringify(g.px(1900, 700)) === '[20,40,60,255]', JSON.stringify([g.px(5, 5), g.px(1900, 700)]));
    check('…and the buffers KWin is given are ARGB8888 only', g.formats.length >= 2 && g.formats.every((f) => f === 0), JSON.stringify(g.formats));
    check('…and the whole surface is declared opaque, before its first buffer', g.opaque.length >= 1 && g.opaque.every((o) => o === 'all') && g.opaqueFirst, JSON.stringify({ opaque: g.opaque, first: g.opaqueFirst }));

    // 50%: see-through everywhere but the keys; no part of the surface declared opaque.
    g = await run((w) => {
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([200, 100, 0], 128));
      w.write(key(10));
      w.write(halfKey(30));
    }, 2);
    check('a background at 50%: its colour premultiplied, alpha 128, over the whole screen', JSON.stringify(g.px(5, 5)) === '[100,50,0,128]' && JSON.stringify(g.px(1919, 719)) === '[100,50,0,128]', JSON.stringify([g.px(5, 5), g.px(1919, 719)]));
    check('an opaque key on it stays fully opaque', JSON.stringify(g.px(24, 24)) === '[200,100,50,255]', JSON.stringify(g.px(24, 24)));
    const half = g.px(64, 24);
    check(`a half-transparent key over it: alpha ${half[3]} ≈ 191, colour ≈ 50,25,0`, Math.abs(half[3] - 191) <= 1 && Math.abs(half[0] - 50) <= 1 && Math.abs(half[1] - 25) <= 1 && half[2] === 0, JSON.stringify(half));
    check('…the buffers still ARGB8888 only, never made again in another format', g.formats.length === 2 && g.formats.every((f) => f === 0), JSON.stringify(g.formats));
    check('…and the surface no longer declared opaque', g.opaque.at(-1) === 'none' && g.opaque.slice(0, -1).every((o) => o === 'all'), JSON.stringify(g.opaque));

    // A picture, the screen's size, is the background under every key.
    const pic = Buffer.alloc(1920 * 720 * 4);
    for (let y = 0; y < 720; y++) for (let x = 0; x < 1920; x++) pic.set(x < 960 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 1920 + x) * 4);
    g = await run((w) => {
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([0, 0, 0], 255, { width: 1920, height: 720, rgba: pic }));
      w.write(imageFrame(470, 10, 20, 4, Buffer.alloc(20 * 4 * 4)));
    }, 1);
    check('a picture: its left half red, right half blue, the whole screen', JSON.stringify(g.px(5, 5)) === '[255,0,0,255]' && JSON.stringify(g.px(1915, 715)) === '[0,0,255,255]', JSON.stringify([g.px(5, 5), g.px(1915, 715)]));
    check('a clear key across its middle puts the picture back under it, both halves', JSON.stringify(g.px(950, 22)) === '[255,0,0,255]' && JSON.stringify(g.px(970, 22)) === '[0,0,255,255]', JSON.stringify([g.px(950, 22), g.px(970, 22)]));
    // A smaller picture (the screen has changed size since it was drawn) is stretched over the screen.
    g = await run((w) => {
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([0, 0, 0], 255, { width: 2, height: 1, rgba: Buffer.from([0, 255, 0, 255, 255, 255, 0, 255]) }));
      w.write(key(10));
    }, 1);
    check('a picture of another size still covers the screen', JSON.stringify(g.px(100, 700)) === '[0,255,0,255]' && JSON.stringify(g.px(1900, 5)) === '[255,255,0,255]', JSON.stringify([g.px(100, 700), g.px(1900, 5)]));

    // Brightness dims the whole deck, background included: at 50 what shows through darkens too; at 0, opaque black.
    g = await run((w) => {
      w.write(brightnessFrame(50));
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([200, 100, 0], 128));
      w.write(key(10));
    }, 1);
    const dim = g.px(5, 5);
    check(`at 50 on a 50% background: darker and less see-through (${dim} ≈ 73,36,0,162)`, Math.abs(dim[0] - 73) <= 1 && Math.abs(dim[1] - 36) <= 1 && Math.abs(dim[3] - 162) <= 1, JSON.stringify(dim));
    check('…its key giving off half the light, still opaque', JSON.stringify(g.px(24, 24)) === '[146,73,36,255]', JSON.stringify(g.px(24, 24)));
    g = await run((w) => {
      w.write(brightnessFrame(0));
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([200, 100, 0], 0));
      w.write(key(10));
    }, 1);
    check('asleep (0) on a fully clear background: opaque black, not clear', JSON.stringify(g.px(5, 5)) === '[0,0,0,255]' && JSON.stringify(g.px(24, 24)) === '[0,0,0,255]', JSON.stringify([g.px(5, 5), g.px(24, 24)]));

    // A canvas frame after a see-through background: opaque again, declared opaque again, the buffers unchanged.
    g = await run((w) => {
      w.write(canvasFrame(960, 360));
      w.write(groundFrame([200, 100, 0], 64));
      w.write(canvasFrame(960, 360, [1, 2, 3]));
      w.write(key(10));
    }, 1);
    check('a canvas frame after it: its colour, opaque (alpha 255)', JSON.stringify(g.px(5, 5)) === '[1,2,3,255]', JSON.stringify(g.px(5, 5)));
    check('…declared opaque again, after being see-through', JSON.stringify(g.opaque.slice(-2)) === '["none","all"]', JSON.stringify(g.opaque));
    check('…and the same two ARGB8888 buffers throughout', g.formats.length === 2 && g.formats.every((f) => f === 0), JSON.stringify(g.formats));

    // A frame whose picture does not match its size is refused.
    const bad = helper(['--output', 'Virtual-1']);
    await until(() => bad.events.some((e) => e.ev === 'ready'));
    const wrong = groundFrame([0, 0, 0], 255, { width: 2, height: 1, rgba: Buffer.alloc(8) });
    wrong.writeUInt32LE(3, 9); // claims 3 × 1
    bad.proc.stdin.write(wrong);
    check('a background whose pixels do not match its size is refused', (await bad.exited) === 5 && bad.events.some((e) => e.ev === 'error'), JSON.stringify(bad.events));
  }

  console.log('idle notifications, from this compositor');
  {
    const probe = helper(['--idle-probe']);
    check('the probe: this compositor offers it', (await probe.exited) === 0 && probe.events[0]?.ev === 'available', JSON.stringify(probe.events));
    const absent = helper(['--idle', '300', '0', '--idle-test-protocol', 'no_such_interface']);
    check('a compositor without it: says so, exit 3', (await absent.exited) === 3 && absent.events[0]?.ev === 'unavailable', JSON.stringify(absent.events));
    const idle = helper(['--idle', '300', '700']);
    check('ready', await until(() => idle.events.some((e) => e.ev === 'ready')));
    check('dim, then sleep, as their timeouts pass', await until(() => idle.events.filter((e) => e.ev === 'idled').map((e) => e.level).join() === 'dim,sleep', 3000), JSON.stringify(idle.events));
    const ticks = async () => (await fs.readFile(`/proc/${idle.proc.pid}/stat`, 'utf8')).split(' ').slice(13, 15).map(Number).reduce((x, y) => x + y);
    const t0 = await ticks();
    await sleep(2000);
    const t1 = await ticks();
    check(`waiting for 2 s: no CPU time used (${t1 - t0} ticks)`, t1 === t0);
    idle.proc.stdin.end();
    check('its stdin closed: it quits', (await Promise.race([idle.exited, sleep(2000).then(() => 'still running')])) === 0);
    const bad = helper(['--idle', 'soon', '0']);
    check('a timeout that is not a number is refused', (await bad.exited) === 1);
  }

  console.log('an image frame whose size overflows');
  {
    const o = helper(['--output', 'Virtual-1']);
    await until(() => o.events.some((e) => e.ev === 'ready'));
    o.proc.stdin.write(canvasFrame(960, 360, [1, 2, 3]));
    // 0x80000000 × 0x80000000 × 4 wraps to 0 in 64 bits, which matches "no pixels".
    const body = Buffer.alloc(16);
    body.writeInt32LE(-2147483647, 0);
    body.writeInt32LE(-2147483647, 4);
    body.writeUInt32LE(0x80000000, 8);
    body.writeUInt32LE(0x80000000, 12);
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = 'I'.charCodeAt(0);
    o.proc.stdin.write(Buffer.concat([head, body]));
    const code = await Promise.race([o.exited, sleep(3000).then(() => 'still running')]);
    if (code === 'still running') o.proc.kill('SIGKILL');
    check('refused: exit 5, saying so, nothing drawn', code === 5 && o.events.some((e) => e.ev === 'error' && /bad image frame/.test(e.message)) && !o.events.some((e) => e.ev === 'drawn'), JSON.stringify({ code, events: o.events }));
    // A real key at the limit's near side is still drawn.
    const ok = helper(['--output', 'Virtual-1']);
    await until(() => ok.events.some((e) => e.ev === 'ready'));
    ok.proc.stdin.write(canvasFrame(960, 360, [1, 2, 3]));
    ok.proc.stdin.write(imageFrame(-2, -2, 4, 4, Buffer.alloc(4 * 4 * 4, 255)));
    check('an ordinary image partly off the canvas is still drawn', await until(() => ok.events.some((e) => e.ev === 'drawn')), JSON.stringify(ok.events));
    ok.proc.stdin.write(quitFrame());
    await ok.exited;
  }

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
  // The new canvas is in place once an image after it is answered: a canvas
  // frame has no answer of its own, and a touch read first would be mapped
  // to the old one.
  const drawnBefore = t.events.filter((e) => e.ev === 'drawn').length;
  t.proc.stdin.write(canvasFrame(1000, 360));
  t.proc.stdin.write(imageFrame(0, 0, 1, 1, Buffer.from([0, 0, 0, 255])));
  await until(() => t.events.filter((e) => e.ev === 'drawn').length > drawnBefore);
  mark = t.events.length;
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.TRACKING, 11), ev(EV.ABS, C.MT_X, 500), ev(EV.ABS, C.MT_Y, 500), syn());
  await until(() => touches(t, mark).length >= 1);
  seen = touches(t, mark);
  check('letterboxed (1000 × 360 on 1920 × 720: scale 1.92, 14 px down): the middle of the screen is 500, 180.2', seen[0]?.x === 500 && seen[0]?.y === 180.2, JSON.stringify(seen));

  // Following a contact (a slider's or dial's, round 5): only once asked, once per frame, until it lifts.
  mark = t.events.length;
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.MT_X, 600), syn());
  await sleep(150);
  check('a contact not followed: its movement says nothing, as always', touches(t, mark).length === 0, JSON.stringify(touches(t, mark)));
  t.proc.stdin.write(followFrame(4));
  // The helper reads its touchscreens before its stdin when both are ready, so a move sent in the same
  // instant as the follow can come first and go unreported — as a real finger's first move might, harmlessly.
  await sleep(150);
  // Two changes in one frame are one move: x then y, then the report.
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.MT_X, 700), ev(EV.ABS, C.MT_Y, 600), syn());
  await until(() => touches(t, mark).length >= 1);
  await sleep(100);
  seen = touches(t, mark);
  check('followed (M): its movement reported once per frame, in canvas units (0.7,0.6 → 700, 217.7)', seen.length === 1 && seen[0].edge === 'move' && seen[0].contact === 4 && seen[0].x === 700 && seen[0].y === 217.7, JSON.stringify(seen));
  mark = t.events.length;
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.TRACKING, -1), syn());
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.TRACKING, 12), ev(EV.ABS, C.MT_X, 100), ev(EV.ABS, C.MT_Y, 100), syn());
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.MT_X, 200), syn());
  await until(() => touches(t, mark).length >= 2);
  await sleep(150);
  seen = touches(t, mark);
  check('…until it lifts: a new contact in the same slot is not followed', seen.length === 2 && seen[0].edge === 'up' && seen[1].edge === 'down', JSON.stringify(seen));
  mark = t.events.length;
  t.proc.stdin.write(followFrame(77));
  send(touch, ev(EV.ABS, C.SLOT, 4), ev(EV.ABS, C.MT_X, 300), syn());
  await sleep(150);
  check('a follow for a contact not down is ignored', touches(t, mark).length === 0 && t.proc.exitCode === null, JSON.stringify(touches(t, mark)));

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
