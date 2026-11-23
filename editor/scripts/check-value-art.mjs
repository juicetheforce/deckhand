// The editor draws a slider's or dial's image layers exactly as the deck does
// (scope §7, round 5): compared pixel for pixel, the deck's drawing against
// the editor's, in real Electron. A virtual deck connected through the real
// virtual driver, with scripts/test/fake-panel.mjs as its display helper,
// logging each control's image whole; the editor's window captured once.
//
// Five controls, each with the same art: a 120 × 300 SVG of four coloured
// quarters, with a viewBox and no preserveAspectRatio — as drawing programs
// save them, and the shape of none of them. As the background of:
// - an upright slider, taller and narrower than the art;
// - a horizontal slider, wider than the art;
// - a dial, square;
// and as the track — the other layer stretched to its area — of an upright
// and a horizontal slider. Every other layer is a transparent image or none,
// and the level is off, so the face is that art alone. The deck stretches it over the whole box (sharp,
// fit 'fill'); an SVG in an <img> keeps its own proportions unless told not
// to, which object-fit cannot do, so before the fix the editor letterboxed it
// along whichever side did not match (found by the maintainer, 2026-11-22).
// Each control is sampled at 16 points, the same fractions of its box in the
// deck's image and in the capture, and every pair must match.
//
// Usage: npm run check:value-art   (builds first)
// DECKHAND_VALUE_ART_SHOT=<file.png> keeps the capture, to look at.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, inPage, onPrivateBus, startEditor, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_VALUE_ART_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-value-art-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const panelLog = path.join(scratch, 'panel.log');
const home = path.join(scratch, 'home');
const pictures = path.join(home, 'Pictures');
const shot = process.env.DECKHAND_VALUE_ART_SHOT ?? path.join(scratch, 'shot.png');
await fs.mkdir(configDir);
await fs.mkdir(pictures, { recursive: true });
await fs.mkdir(path.join(scratch, 'bin'));
await fs.symlink(path.join(repoRoot, 'scripts/test/fake-pactl.mjs'), path.join(scratch, 'bin', 'pactl'));
await fs.writeFile(path.join(scratch, 'pactl.json'), '{}');

const { createRequire } = await import('node:module');
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');
const QUARTERS = { tl: [255, 0, 0], tr: [0, 200, 0], bl: [0, 0, 255], br: [255, 220, 0] };
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
await fs.writeFile(
  path.join(pictures, 'quarters.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="300" viewBox="0 0 120 300">` +
    `<rect x="0" y="0" width="60" height="150" fill="${hex(QUARTERS.tl)}"/><rect x="60" y="0" width="60" height="150" fill="${hex(QUARTERS.tr)}"/>` +
    `<rect x="0" y="150" width="60" height="150" fill="${hex(QUARTERS.bl)}"/><rect x="60" y="150" width="60" height="150" fill="${hex(QUARTERS.br)}"/></svg>\n`,
);
await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(path.join(pictures, 'clear.png'));

const { edid, fakeSysfs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);

Object.assign(process.env, {
  HOME: home,
  PATH: `${path.join(scratch, 'bin')}:${process.env.PATH}`,
  FAKE_PACTL_STATE: path.join(scratch, 'pactl.json'),
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_INPUT_BIN: path.join(repoRoot, 'scripts/test/fake-input-helper.mjs'),
  DECKHAND_DRM_DIR: sysfs.drm,
  DECKHAND_INPUT_DIR: sysfs.input,
  DECKHAND_UDEV_DATA_DIR: sysfs.udev,
  DECKHAND_DEV_INPUT_DIR: sysfs.dev,
  DECKHAND_PANEL_BIN: path.join(repoRoot, 'scripts/test/fake-panel.mjs'),
  FAKE_PANEL_LOG: panelLog,
  // Every control's image logged whole, so any pixel can be read.
  FAKE_PANEL_RGBA_MAX: String(1920 * 720 * 4),
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { createVirtualDriver } = await import(pathToFileURL(path.join(repoRoot, 'dist/drivers/virtual.js')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

const KEY = 'GRA-6e4e';
const CONTROLS = [
  { id: 'v', x: 200, y: 100, w: 110, h: 470, kind: 'slider', what: 'an upright slider' },
  { id: 'h', x: 500, y: 300, w: 470, h: 110, kind: 'slider', direction: 'horizontal', what: 'a horizontal slider' },
  { id: 'd', x: 1100, y: 200, w: 220, h: 220, kind: 'dial', keepRatio: true, what: 'a dial' },
  // The track, the other layer stretched to its area: no background, the art as the track.
  { id: 'tv', x: 1500, y: 100, w: 110, h: 470, kind: 'slider', what: 'an upright slider', layer: 'track' },
  { id: 'th', x: 500, y: 520, w: 470, h: 110, kind: 'slider', direction: 'horizontal', what: 'a horizontal slider', layer: 'track' },
];
const art = (c) => ({
  action: { type: 'audio.volume' },
  level: { show: false },
  layers:
    c.kind === 'dial'
      ? { background: '~/Pictures/quarters.svg', base: null, knob: '~/Pictures/clear.png' }
      : c.layer === 'track'
        ? { track: '~/Pictures/quarters.svg', thumb: '~/Pictures/clear.png' }
        : { background: '~/Pictures/quarters.svg', track: '~/Pictures/clear.png', thumb: '~/Pictures/clear.png' },
});
const CONFIG = {
  decks: { [KEY]: { name: 'Touch', virtual: { output: 'DP-4' } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [KEY]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              panel: { size: { width: 1920, height: 720 }, preset: 'free', controls: CONTROLS.map(({ what, layer, ...c }) => c) },
              buttons: Object.fromEntries(CONTROLS.map((c) => [c.id, art(c)])),
            },
          },
        },
      },
    },
  },
  startProfile: 'default',
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

let daemonRef = null;
const virtualDriver = createVirtualDriver(() => daemonRef?.state.config ?? null);
const daemon = await startDaemon(scratch, CONFIG, { virtual: virtualDriver });
daemonRef = daemon;
const stopWatching = await reloadLikeTheDaemon(daemon);
const panelDevice = await (await virtualDriver.list()).find((f) => f.id === KEY).open();
await daemon.attachDevice(KEY, panelDevice);

const env = {
  ...process.env,
  HOME: home,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.XDG_CONFIG_HOME;
delete env.ELECTRON_RUN_AS_NODE;

const editor = startEditor(electronPath, editorRoot, env);
const inEditor = (expr) => inPage(editor, 'editor', expr);
const exists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const click = (selector) =>
  inEditor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const mustSee = async (what, fn, ms = 10000) => {
  if (!(await until(fn, ms))) throw new Error(`never saw ${what}`);
};

let stopping = false;
const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  const gone = new Promise((resolve) => (editor.child.exitCode !== null ? resolve() : editor.child.once('exit', resolve)));
  editor.child.kill();
  await Promise.race([gone, sleep(5000)]);
  stopWatching?.();
  await daemon.stop().catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  process.exit(code);
};
process.on('uncaughtException', (err) => {
  console.log(`FAIL  the run stopped: ${err.message}`);
  void stop(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`FAIL  the run stopped: ${err?.message ?? err}`);
  void stop(1);
});

// ---- THE DECK: each control's latest image, from the fake panel's log ----
const deckImage = async (c) => {
  const lines = (await fs.readFile(panelLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const frame = lines.filter((f) => f.type === 'I' && f.x === c.x && f.y === c.y && f.w === c.w && f.h === c.h && f.rgba).at(-1);
  return frame ? { w: frame.w, h: frame.h, channels: 4, data: Buffer.from(frame.rgba, 'base64') } : null;
};
await mustSee('every control drawn on the deck', async () => (await Promise.all(CONTROLS.map(deckImage))).every(Boolean), 15000);
// The art is drawn once its files are read; let the last draws land.
await sleep(800);
const deck = Object.fromEntries(await Promise.all(CONTROLS.map(async (c) => [c.id, await deckImage(c)])));

// ---- THE EDITOR: the virtual deck alone, every image loaded, one capture ----
await until(async () => (await inEditor("document.querySelector('.toolbar .pill-connected') !== null")) === true, 15000);
// One deck connected: the editor shows it alone, with no Show in editor to choose from.
const keySel = (id) => `.grid[data-deck="${KEY}"] [data-key="${id}"]`;
await mustSee(
  'every control\'s images loaded in the editor',
  () => inEditor(`[${CONTROLS.map((c) => JSON.stringify(keySel(c.id))).join(',')}].every((s) => { const k = document.querySelector(s); const imgs = k ? [...k.querySelectorAll('img')] : []; return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0); })`),
  15000,
);
await sleep(500);
const boxes = await inEditor(`(() => { const out = { innerWidth: window.innerWidth }; for (const id of ${JSON.stringify(CONTROLS.map((c) => c.id))}) { const b = document.querySelector('.grid[data-deck="${KEY}"] [data-key="' + id + '"]').getBoundingClientRect(); out[id] = { left: b.left, top: b.top, width: b.width, height: b.height }; } return out; })()`);
const captured = await capture(editor, shot);
if (!captured) throw new Error('the editor\'s window could not be captured');
const shotImage = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const scale = shotImage.info.width / boxes.innerWidth;
const pixel = (img, w, x, y) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];

// ---- COMPARED ----
const FRACTIONS = [0.12, 0.38, 0.62, 0.88];
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 48);
for (const c of CONTROLS) {
  const img = deck[c.id];
  const box = boxes[c.id];
  const misses = [];
  let deckQuarters = 0;
  for (const fy of FRACTIONS)
    for (const fx of FRACTIONS) {
      const onDeck = pixel(img.data, img.w, Math.floor(fx * img.w), Math.floor(fy * img.h));
      const inEditorPx = pixel(shotImage.data, shotImage.info.width, Math.floor((box.left + fx * box.width) * scale), Math.floor((box.top + fy * box.height) * scale));
      const quarter = QUARTERS[(fy < 0.5 ? 't' : 'b') + (fx < 0.5 ? 'l' : 'r')];
      if (near(onDeck, quarter)) deckQuarters++;
      if (!near(onDeck, inEditorPx)) misses.push(`at ${fx},${fy}: deck ${onDeck} editor ${inEditorPx}`);
    }
  // The deck's own drawing first: the art stretched over the whole box, each quarter in its quarter.
  const layer = c.layer ?? 'background';
  check(`the deck stretches the ${layer} over ${c.what}'s whole box`, deckQuarters === 16, `${deckQuarters} of 16 points in their quarter's colour`);
  check(`the editor draws ${c.what}'s ${layer} exactly as the deck does (16 points)`, misses.length === 0, misses.slice(0, 4).join('; ') + (misses.length > 4 ? ` … ${misses.length} in all` : ''));
}

console.log(failures === 0 ? '\nvalue art: the editor draws as the deck, all checks passed' : `\n${failures} check(s) failed`);
await stop(failures === 0 ? 0 : 1);
