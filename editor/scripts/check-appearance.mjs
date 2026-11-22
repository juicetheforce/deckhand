// Appearance for every deck (scope §7, round 4), end to end in real Electron:
// the main window with a fake Stream Deck XL and a virtual deck through the
// real virtual driver (scripts/test/fake-panel.mjs as its display helper).
// What is checked from outside the page: config.json on disk and the fake
// XL's own drawing.
//
// - A config from before the icon scale is converted when the editor opens
//   it: a 2:1 image under the old crop gets the number that keeps its look,
//   and the config its version (src/icon-fit.ts).
// - The Icon tab's Icon scale on a Stream Deck key and a virtual deck's
//   control: 20–200 in 5s, the mark where the whole image shows (100 for any
//   image on a square key, 70 for a square image in a circle), saved when
//   let go; a built-in following Icon size until moved, Clear icon making it
//   follow again; the grid drawing the scale.
// - The Key tab's Background: a swatch, Default, on both decks, and the deck
//   drawing it.
// - The image limits on icons: one already in the config refused with its
//   reason in the grid and the Icon tab, the deck drawing the missing icon;
//   the picker refusing one with its reason and choosing nothing.
// - The label font drawn on the grid's labels.
//
// Usage: npm run check:appearance   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_APPEARANCE_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-appearance-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const socks = path.join(scratch, 'socks');
const panelLog = path.join(scratch, 'panel.log');
const home = path.join(scratch, 'home');
const pictures = path.join(home, 'Pictures');
await fs.mkdir(configDir);
await fs.mkdir(socks);
await fs.mkdir(pictures, { recursive: true });
await fs.mkdir(path.join(home, '.config'), { recursive: true });
await fs.writeFile(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_PICTURES_DIR="$HOME/Pictures"\n');

const { createRequire } = await import('node:module');
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');
const red = { r: 255, g: 0, b: 0, alpha: 1 };
await sharp({ create: { width: 200, height: 100, channels: 4, background: red } }).png().toFile(path.join(pictures, 'wide.png'));
await sharp({ create: { width: 56, height: 56, channels: 4, background: red } }).png().toFile(path.join(pictures, 'square.png'));
await sharp({ create: { width: 5000, height: 10, channels: 3, background: '#808080' } }).png().toFile(path.join(pictures, 'mural.png'));

const { edid, fakeSysfs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);

Object.assign(process.env, {
  HOME: home,
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_INPUT_BIN: path.join(repoRoot, 'scripts/test/fake-input-helper.mjs'),
  DECKHAND_DRM_DIR: sysfs.drm,
  DECKHAND_INPUT_DIR: sysfs.input,
  DECKHAND_UDEV_DATA_DIR: sysfs.udev,
  DECKHAND_DEV_INPUT_DIR: sysfs.dev,
  DECKHAND_PANEL_BIN: path.join(repoRoot, 'scripts/test/fake-panel.mjs'),
  FAKE_PANEL_LOG: panelLog,
  FAKE_PANEL_INPUT_DIR: socks,
  FAKE_PANEL_SURFACE_FILE: path.join(scratch, 'surface'),
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { createVirtualDriver } = await import(pathToFileURL(path.join(repoRoot, 'dist/drivers/virtual.js')).href);
const { makePanel } = await import(pathToFileURL(path.join(repoRoot, 'dist/panel-presets.js')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const XL = 'LOOK-XL';
const KEY = 'GRA-6e4e';
const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const CUSTOM = {
  size: { width: 1920, height: 720 },
  preset: 'free',
  controls: [
    { id: 'r1', x: 100, y: 100, w: 240, h: 240, shape: 'round' },
    { id: 'w1', x: 500, y: 100, w: 636, h: 270, shape: 'rectangle', radius: 30 },
  ],
};
// No "version": a config from before the icon scale, as everyone's is.
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' }, [KEY]: { name: 'Touch', virtual: { output: 'DP-4', panel: makePanel(SCREEN, 'medium') } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: { icon: '~/Pictures/mural.png', label: 'Mural' },
                1: { label: 'Jump', action: { type: 'hotkey', keys: 'ctrl+1' } },
                2: { icon: '~/Pictures/wide.png' },
                3: { icon: '~/Pictures/square.png', label: 'Sq' },
              },
            },
          },
        },
        [KEY]: { startPage: 'main', pages: { main: { name: 'Main', panel: CUSTOM, buttons: { r1: { icon: '~/Pictures/square.png' }, w1: { label: 'Wide' } } } } },
      },
    },
  },
  startProfile: 'default',
};
const configFile = path.join(configDir, 'config.json');
await fs.writeFile(configFile, JSON.stringify(CONFIG, null, 2) + '\n');

let daemonRef = null;
const virtualDriver = createVirtualDriver(() => daemonRef?.state.config ?? null);
const daemon = await startDaemon(scratch, CONFIG, { virtual: virtualDriver });
daemonRef = daemon;
const xl = new FakeDeck();
await daemon.attach(XL, xl);
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

const onDisk = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));
const buttonOnDisk = async (serial, key) => (await onDisk()).profiles.default.layouts[serial].pages.main.buttons[key] ?? null;

const editor = startEditor(electronPath, editorRoot, env);
const inEditor = (expr) => inPage(editor, 'editor', expr);
const exists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const click = (selector) =>
  inEditor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const keyOn = (selector, key, type = 'keydown') =>
  inEditor(`(() => { document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, key: ${JSON.stringify(key)} })); return true; })()`);
const pressKey = async (selector, key) => {
  await keyOn(selector, key);
  await sleep(150);
  await keyOn(selector, key, 'keyup');
};
const gridKey = (serial, id) => `.grid[data-deck="${serial}"] .key[data-key="${id}"]`;
const select = async (serial, id) => {
  await inEditor(`(() => { document.querySelector(${JSON.stringify(gridKey(serial, id))}).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
  await until(() => exists('.inspector .inspector-title'));
};
const tab = (name) => inEditor(`(() => { [...document.querySelectorAll('.inspector [role=tab]')].find((t) => t.textContent === ${JSON.stringify(name)}).click(); return true; })()`);
const SLIDER = '.inspector [data-inspector-section="icon-scale"] [role="slider"]';
const scaleState = () =>
  inEditor(`(() => { const s = document.querySelector(${JSON.stringify(SLIDER)}); if (!s) return null; return { now: s.getAttribute('aria-valuenow'), text: s.getAttribute('aria-valuetext'), mark: s.querySelector('[data-slider-mark]')?.dataset.sliderMark ?? null, note: document.querySelector('[data-icon-scale-note]')?.textContent ?? null, refused: document.querySelector('.inspector [data-icon-refused]')?.textContent ?? null }; })()`);

const r = {};
const stop = (err) => {
  console.log(`FAIL  the run stopped: ${err?.message ?? err}\n      recorded so far: ${JSON.stringify(r)}`);
  editor.child.kill();
  process.exit(1);
};
process.on('uncaughtException', stop);
process.on('unhandledRejection', stop);
const mustSee = async (what, fn, ms = 10000) => {
  if (!(await until(fn, ms))) throw new Error(`never saw ${what}`);
};

await until(async () => (await inEditor("document.querySelector('.toolbar .pill-connected') !== null")) === true, 15000);

// ---- THE CONVERSION ON OPENING ----
r.converted = await until(async () => (await onDisk()).version === 2, 10000);
r.afterConversion = { wide: await buttonOnDisk(XL, 2), square: await buttonOnDisk(XL, 3), round: await buttonOnDisk(KEY, 'r1') };

// Both decks shown.
await mustSee('Show in editor', () => exists('.show-in-editor-trigger'), 15000);
await click('.show-in-editor-trigger');
await mustSee('the XL in Show in editor', () => exists(`[data-show-deck="${XL}"]`));
for (const deck of [XL, KEY]) {
  await inEditor(`(() => { const box = document.querySelector('[data-show-deck="${deck}"] input[type=checkbox]'); if (box && !box.checked) box.click(); return true; })()`);
}
await click('.show-in-editor-trigger');
await mustSee('both decks', () => inEditor(`document.querySelectorAll('[data-deck-panel]').length === 2`));

// ---- A REFUSED IMAGE ALREADY IN THE CONFIG ----
await mustSee('the refused icon marked in the grid', () => exists(`${gridKey(XL, '0')} [data-icon-refused]`));
r.gridRefused = await inEditor(`document.querySelector(${JSON.stringify(`${gridKey(XL, '0')} [data-icon-refused]`)}).dataset.iconRefused`);
await select(XL, '0');
await tab('Icon');
await mustSee('the Icon tab saying why', async () => (await scaleState())?.refused !== null);
r.inspectorRefused = (await scaleState()).refused;

// ---- ICON SCALE ON A STREAM DECK KEY ----
// Key 2: a 2:1 image, 200 after the conversion; the whole image shows at 100 on a square key.
await select(XL, '2');
await tab('Icon');
await mustSee('key 2\'s scale', async () => (await scaleState())?.mark !== null);
r.wideScale = await scaleState();
await pressKey(SLIDER, 'ArrowLeft');
r.wideSaved = await until(async () => (await buttonOnDisk(XL, 2))?.iconScale === 195);
r.wideGrid = await inEditor(`document.querySelector(${JSON.stringify(`${gridKey(XL, '2')} .key-icon`)}).style.width`);
// Key 1: Jump's default built-in, following Icon size (45.5, shown 46%).
await select(XL, '1');
await tab('Icon');
await mustSee('key 1\'s scale', () => scaleState());
r.builtinAtRest = await scaleState();
await pressKey(SLIDER, 'ArrowRight');
r.builtinOwn = await until(async () => (await buttonOnDisk(XL, 1))?.iconScale === 50);
await mustSee('its own-size note', async () => /^Its own size/.test((await scaleState())?.note ?? ''));
r.builtinGrid = await inEditor(`document.querySelector(${JSON.stringify(`${gridKey(XL, '1')} .key-icon`)}).style.width`);
await inEditor(`(() => { [...document.querySelectorAll('.inspector .picker-actions button')].find((b) => b.textContent.trim() === 'Clear icon').click(); return true; })()`);
r.builtinFollowsAgain = await until(async () => (await buttonOnDisk(XL, 1))?.iconScale === undefined);
await mustSee('following again', async () => /^Follows Icon size/.test((await scaleState())?.note ?? ''));

// ---- ICON SCALE ON A ROUND CONTROL ----
await select(KEY, 'r1');
await tab('Icon');
await mustSee('the round control\'s scale', async () => (await scaleState())?.mark !== null);
r.roundScale = await scaleState();

// ---- THE PICKER REFUSES AN IMAGE OVER THE LIMITS ----
await select(XL, '4');
await tab('Icon');
await mustSee('the picker on Pictures', () => exists('.inspector .picker-item[data-path$="mural.png"]'));
const before = await buttonOnDisk(XL, 4);
await click('.inspector .picker-item[data-path$="mural.png"]');
await mustSee('the picker\'s refusal', () => exists('.inspector .picker-item-refused[data-path$="mural.png"]'));
await sleep(600);
r.pickerRefused = {
  message: await inEditor("document.querySelector('.inspector .picker-bottom .field-error')?.textContent ?? null"),
  unchanged: JSON.stringify(await buttonOnDisk(XL, 4)) === JSON.stringify(before),
};
await click('.inspector .picker-item[data-path$="square.png"]');
r.pickerChose = await until(async () => (await buttonOnDisk(XL, 4))?.icon === '~/Pictures/square.png');

// ---- BACKGROUND ON THE KEY TAB ----
for (const [serial, key] of [[XL, '5'], [KEY, 'w1']]) {
  await select(serial, key);
  await tab('Key');
  await mustSee(`${serial}'s Background row`, () => exists('.inspector [data-colour-picker="key-background"]'));
  await click('.inspector [data-colour-picker="key-background"] [data-colour-swatch]');
  await mustSee('the swatches', () => exists('.inspector [data-colour-chip="#4a1f2b"]'));
  await click('.inspector [data-colour-chip="#4a1f2b"]');
  r[`colour-${serial}`] = await until(async () => (await buttonOnDisk(serial, key))?.background === '#4a1f2b');
  r[`gridColour-${serial}`] = await inEditor(`getComputedStyle(document.querySelector(${JSON.stringify(gridKey(serial, key))})).backgroundColor`);
}
// The XL's key 5 (no icon) drawn in it: the fake deck's last image for that key, its corner pixel.
r.xlDrawn = await until(() => {
  const img = xl.images.get(5);
  return img && img[0] === 0x4a && img[1] === 0x1f && img[2] === 0x2b;
});
await click('.inspector [data-colour-chip="default"]');
r.colourDefault = await until(async () => (await buttonOnDisk(KEY, 'w1'))?.background === undefined);

// ---- THE LABEL FONT ON THE GRID ----
{
  const c = await onDisk();
  c.defaults = { ...c.defaults, labelFont: 'DejaVu Sans Mono' };
  await fs.writeFile(configFile, JSON.stringify(c, null, 2) + '\n');
}
r.gridFont = await until(async () => /DejaVu Sans Mono/.test(await inEditor(`document.querySelector(${JSON.stringify(`${gridKey(XL, '3')} .key-label`)})?.style.fontFamily ?? ''`)));

editor.child.kill();
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

check('a config from before the icon scale is converted on opening: version 2, a 2:1 image under the old crop 200%, a square one nothing', () => {
  assert.equal(r.converted, true);
  assert.deepEqual(r.afterConversion, { wide: { icon: '~/Pictures/wide.png', iconScale: 200 }, square: { icon: '~/Pictures/square.png', label: 'Sq' }, round: { icon: '~/Pictures/square.png' } });
});
check('an icon already in the config over the limits: the grid draws the missing icon with the reason, and the Icon tab says it', () => {
  assert.equal(r.gridRefused, 'mural.png is too large: 5000 × 10 px. The limit is 4096 px on the longer side.');
  assert.equal(r.inspectorRefused, 'mural.png is too large: 5000 × 10 px. The limit is 4096 px on the longer side. The deck shows the missing icon instead.');
});
check('Icon scale on a Stream Deck key: 20–200, its value, the mark at 100 (a 2:1 image fits a square key whole there); a step down saved, the grid drawing it', () => {
  assert.deepEqual({ ...r.wideScale, note: undefined }, { now: '200', text: '200%', mark: '100', note: undefined, refused: null });
  assert.equal(r.wideSaved, true);
  assert.equal(r.wideGrid, '195%');
});
check('a built-in follows Icon size (46%) until moved; moved it is its own (50); Clear icon makes it follow again', () => {
  assert.equal(r.builtinAtRest.text, '46%');
  assert.match(r.builtinAtRest.note, /^Follows Icon size in Settings \(46%\)/);
  assert.equal(r.builtinOwn, true);
  assert.equal(r.builtinGrid, '50%');
  assert.equal(r.builtinFollowsAgain, true);
});
check('a square image on a round control: 100% and the mark at 70, where its corners come inside the circle', () => {
  assert.equal(r.roundScale.text, '100%');
  assert.equal(r.roundScale.mark, '70');
});
check('the picker refuses an image over the limits with its reason, chooses nothing, and still chooses one within them', () => {
  assert.equal(r.pickerRefused.message, 'mural.png is too large: 5000 × 10 px. The limit is 4096 px on the longer side.');
  assert.equal(r.pickerRefused.unchanged, true);
  assert.equal(r.pickerChose, true);
});
check('Background on the Key tab, on a Stream Deck key and a virtual control: a swatch saved and drawn in the grid; the XL draws it; Default removes it', () => {
  assert.equal(r[`colour-${XL}`], true);
  assert.equal(r[`colour-${KEY}`], true);
  assert.equal(r[`gridColour-${XL}`], 'rgb(74, 31, 43)');
  assert.equal(r[`gridColour-${KEY}`], 'rgb(74, 31, 43)');
  assert.equal(r.xlDrawn, true);
  assert.equal(r.colourDefault, true);
});
check('the label font is drawn on the grid\'s labels', () => assert.equal(r.gridFont, true));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
