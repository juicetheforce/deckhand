// A page's background (scope §7, round 3), end to end in real Electron: the
// main window with a virtual deck connected through the real virtual driver
// and scripts/test/fake-panel.mjs as its display helper, beside a fake Stream
// Deck. What is checked from outside the page: config.json on disk and the
// helper's frames ('G', the background).
//
// - The background icon on a virtual deck's header, on a custom and a grid
//   page alike; none on a Stream Deck's. It opens a panel for the page shown,
//   naming it; Esc and a click outside close it.
// - Colour (a swatch, typed hex), opacity (0–100 in 5s, previewed on the page
//   while it moves, saved when let go), the one line below 100%, an image
//   chosen like an icon — refused with its reason above 10 MB or 4096 px,
//   dimmed and not chosen — as Fill or Fit, and removed. Each saved on the
//   page, each sent to the deck. Black, Fill and 100% stores nothing.
// - Each page its own: another page keeps black; a new page starts black.
// - Drawn behind the keys in the editor, with a checker below 100%; in Edit
//   layout the icon is dimmed and the background stays behind the controls.
// - Where the screen is GNOME's full-screen window, the panel says
//   see-through may not work there.
//
// Usage: npm run check:background   (builds first)
// DECKHAND_BACKGROUND_SHOT=<file.png> also saves the window with an image chosen at 60%, the panel open, to look at.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, inPage, onPrivateBus, startEditor, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_BACKGROUND_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-background-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const socks = path.join(scratch, 'socks');
const panelLog = path.join(scratch, 'panel.log');
const surfaceFile = path.join(scratch, 'surface');
const home = path.join(scratch, 'home');
const pictures = path.join(home, 'Pictures');
await fs.mkdir(configDir);
await fs.mkdir(socks);
await fs.mkdir(pictures, { recursive: true });
await fs.mkdir(path.join(home, '.config'), { recursive: true });
await fs.writeFile(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_PICTURES_DIR="$HOME/Pictures"\n');

// Three pictures: one fine, one wider than 4096 px, one over 10 MB.
const { createRequire } = await import('node:module');
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');
const half = Buffer.alloc(40 * 20 * 3);
for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) half.set(x < 20 ? [255, 0, 0] : [0, 0, 255], (y * 40 + x) * 3);
await sharp(half, { raw: { width: 40, height: 20, channels: 3 } }).png().toFile(path.join(pictures, 'dusk.png'));
await sharp({ create: { width: 5000, height: 10, channels: 3, background: '#808080' } }).png().toFile(path.join(pictures, 'mural.png'));
await fs.writeFile(path.join(pictures, 'poster.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(12 * 1024 * 1024)]));

const { edid, fakeSysfs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);

Object.assign(process.env, {
  // The daemon runs in this process: "~/Pictures/…" must be the editor's home too.
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
  FAKE_PANEL_SURFACE_FILE: surfaceFile,
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

const XL = 'BG-CHECK-XL';
const KEY = 'GRA-6e4e';
const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const MEDIUM = makePanel(SCREEN, 'medium');
const LARGE = makePanel(SCREEN, 'large');
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' }, [KEY]: { name: 'Touch', virtual: { output: 'DP-4', panel: structuredClone(MEDIUM) } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'XL' } } } } },
        [KEY]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', panel: { ...structuredClone(MEDIUM), preset: 'free' }, buttons: { k1: { label: 'Mic' } } },
            big: { name: 'Big', panel: structuredClone(LARGE), buttons: { k1: { label: 'Large one' } } },
          },
        },
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
await daemon.attach(XL, new FakeDeck());
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
const pageOnDisk = async (id) => (await onDisk()).profiles.default.layouts[KEY].pages[id] ?? null;
const backgroundOnDisk = async (id = 'main') => (await pageOnDisk(id))?.background ?? null;
const frames = async () => (await fs.readFile(panelLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastGround = async (from) => (await frames()).slice(from).filter((f) => f.type === 'G').at(-1) ?? null;

const editor = startEditor(electronPath, editorRoot, env);
const inEditor = (expr) => inPage(editor, 'editor', expr);
const exists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const attr = (selector, name) => inEditor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const click = (selector) =>
  inEditor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const typeInto = (selector, value) =>
  inEditor(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
/** A key pressed and let go on the slider: a moment apart, as a hand does, so the release sees the move. */
const pressKey = async (selector, key) => {
  await keyOn(selector, key);
  await sleep(150);
  await keyOn(selector, key, 'keyup');
};
const keyOn = (selector, key, type = 'keydown') =>
  inEditor(`(() => { document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, key: ${JSON.stringify(key)} })); return true; })()`);
const icon = (deck) => `[data-deck-panel="${deck}"] [data-background-icon]`;
const ground = (deck = KEY) => `.grid[data-deck="${deck}"] [data-page-ground]`;
const groundOf = async (deck = KEY) =>
  inEditor(`(() => { const g = document.querySelector(${JSON.stringify(ground(deck))}); if (!g) return null; const l = g.querySelector('.page-ground-layer'); return { color: g.dataset.groundColor, opacity: Number(g.dataset.groundOpacity), fit: g.dataset.groundFit, image: g.dataset.groundImage, checker: g.querySelector('.page-ground-checker') !== null, layerOpacity: getComputedStyle(l).opacity, under: getComputedStyle(g).zIndex }; })()`);
const panelOpen = () => exists('[data-background-panel]');
const openPanel = async () => {
  if (!(await panelOpen())) await click(icon(KEY));
  await until(panelOpen);
};
const tab = async (name) => {
  await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === ${JSON.stringify(name)}).click(); return true; })()`);
  const shown = () => inEditor(`document.querySelector('[data-deck-panel="${KEY}"] .deck-panel-page [data-dropdown]')?.dataset.value`);
  if (!(await until(async () => (await shown()) === name.toLowerCase()))) throw new Error(`the virtual deck never showed ${name}: it shows ${await shown()}`);
};

const r = {};
process.on('uncaughtException', (err) => {
  console.log(`FAIL  the run stopped: ${err.message}\n      recorded so far: ${JSON.stringify(r)}`);
  editor.child.kill();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`FAIL  the run stopped: ${err?.message ?? err}\n      recorded so far: ${JSON.stringify(r)}`);
  editor.child.kill();
  process.exit(1);
});

await until(async () => (await inEditor("document.querySelector('.toolbar .pill-connected') !== null")) === true, 15000);
// Both decks shown, the virtual deck focused: chosen alone in Show in editor, then the XL ticked beside it.
const mustSee = async (what, fn, ms = 10000) => {
  if (!(await until(fn, ms))) throw new Error(`never saw ${what}`);
};
await mustSee('Show in editor', () => exists('.show-in-editor-trigger'), 15000);
await click('.show-in-editor-trigger');
await mustSee('the virtual deck in Show in editor', () => exists(`[data-show-deck="${KEY}"] .show-in-editor-name`));
await click(`[data-show-deck="${KEY}"] .show-in-editor-name`);
await mustSee('the virtual deck alone', () => exists(`[data-deck-panel="${KEY}"] .deck-panel-header`));
await click('.show-in-editor-trigger');
await mustSee('the XL in Show in editor', () => exists(`[data-show-deck="${XL}"]`));
await inEditor(`(() => { const box = document.querySelector('[data-show-deck="${XL}"] input[type=checkbox]'); if (box && !box.checked) box.click(); return true; })()`);
await click('.show-in-editor-trigger');
await mustSee('both decks', () => exists(`[data-deck-panel="${XL}"] .deck-panel-header`));
// The virtual deck focused, so the toolbar's tabs and New page are its own: a click on its frame does it.
await inEditor(`(() => { const n = document.querySelector('[data-deck-panel="${KEY}"] .deck-panel-name'); if (!n.disabled) n.click(); return true; })()`);
await mustSee('the virtual deck focused', () => inEditor(`document.querySelector('[data-deck-panel="${KEY}"] .deck-panel-name').disabled`));
await mustSee('the virtual deck\'s page background', () => exists(ground(KEY)));

// ---- WHERE THE ICON IS ----
r.icons = { virtual: await exists(icon(KEY)), streamDeck: await exists(icon(XL)), xlGround: await exists(ground(XL)) };
r.startGround = await groundOf();

// ---- THE PANEL ----
let from = (await frames()).length;
await click(icon(KEY));
await until(panelOpen);
r.opened = { page: await attr('[data-background-panel]', 'data-background-panel'), lit: await attr(icon(KEY), 'aria-pressed') };
// A swatch, then typed hex.
await click('[data-background-swatch]');
await until(() => exists('[data-background-chip="#2b2350"]'));
await click('[data-background-chip="#2b2350"]');
await until(async () => (await backgroundOnDisk())?.color === '#2b2350');
await until(async () => (await lastGround(from))?.color.join() === '43,35,80');
r.swatch = { disk: await backgroundOnDisk(), frame: await lastGround(from), ground: await groundOf() };
await typeInto('[data-background-hex]', '#102030');
await until(async () => (await backgroundOnDisk())?.color === '#102030');
r.hex = await backgroundOnDisk();
r.noLineAt100 = !(await exists('[data-background-line]'));

// Opacity: Home and let go — fully clear; the line, the checker, alpha 0.
from = (await frames()).length;
await pressKey('[data-background-panel] [role=slider]', 'Home');
await until(async () => (await backgroundOnDisk())?.opacity === 0);
await until(async () => (await lastGround(from))?.alpha === 0);
r.clear = { disk: await backgroundOnDisk(), alpha: (await lastGround(from))?.alpha, line: await inEditor(`document.querySelector('[data-background-line]')?.textContent ?? null`), gnome: await exists('[data-background-gnome]'), ground: await groundOf() };
// Dragged to 60%: shown on the page while it moves, saved only when let go.
const sliderAt = (fraction, type) =>
  inEditor(`(() => { const s = document.querySelector('[data-background-panel] [role=slider]'); const b = s.getBoundingClientRect(); s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, pointerId: 5, button: 0, clientX: b.left + b.width * ${fraction}, clientY: b.top + b.height / 2 })); return true; })()`);
await sliderAt(0.6, 'pointerdown');
await sleep(250);
r.whileMoving = { ground: (await groundOf()).opacity, disk: (await backgroundOnDisk())?.opacity };
await sliderAt(0.6, 'pointerup');
await until(async () => (await backgroundOnDisk())?.opacity === 60);
r.afterMove = { disk: (await backgroundOnDisk())?.opacity, ground: await groundOf() };

// ---- AN IMAGE, picked like an icon ----
await click('[data-background-choose]');
await until(() => exists('[data-image-chooser] .picker-item'), 10000);
const tile = (name) => `[data-image-chooser] .picker-item[data-path="${path.join(pictures, name)}"]`;
await until(() => exists(tile('dusk.png')), 10000);
r.chooserTiles = await inEditor(`[...document.querySelectorAll('[data-image-chooser] .picker-item .picker-name')].map((n) => n.textContent)`);
await click(tile('poster.png'));
await until(async () => /too big/.test(await inEditor(`document.querySelector('[data-image-chooser-message]').textContent`)));
r.tooBig = { message: await inEditor(`document.querySelector('[data-image-chooser-message]').textContent`), dimmed: await inEditor(`document.querySelector(${JSON.stringify(tile('poster.png'))}).classList.contains('picker-item-refused')`) };
await click(tile('mural.png'));
await until(async () => /too large/.test(await inEditor(`document.querySelector('[data-image-chooser-message]').textContent`)));
r.tooLarge = await inEditor(`document.querySelector('[data-image-chooser-message]').textContent`);
r.refusedNotChosen = (await backgroundOnDisk())?.image ?? null;
from = (await frames()).length;
await click(tile('dusk.png'));
await until(async () => (await backgroundOnDisk())?.image !== undefined);
await until(async () => (await lastGround(from))?.w === 1920, 10000);
r.chosen = { disk: await backgroundOnDisk(), chooserGone: !(await exists('[data-image-chooser]')), frame: await lastGround(from) };
await until(async () => (await groundOf()).image !== '');
r.imageGround = await groundOf();
// Every control opaque over it, an empty one included (k2 has no key): nothing of the background through a button.
r.controlsOpaque = await inEditor(`['k1', 'k2'].map((id) => { const k = document.querySelector('.grid[data-deck="${KEY}"] [data-key="' + id + '"]'); const c = getComputedStyle(k).backgroundColor; const m = c.match(/rgba?\\(([^)]+)\\)/); const parts = m ? m[1].split(',').map(Number) : []; return { color: c, opaque: parts.length === 3 || parts[3] === 1 }; })`);
if (process.env.DECKHAND_BACKGROUND_SHOT) {
  await sleep(500);
  console.log(`shot: ${(await capture(editor, process.env.DECKHAND_BACKGROUND_SHOT)) ? 'saved' : 'FAILED'}`);
}
// Fit, then the image removed.
from = (await frames()).length;
await click('[data-background-fit="fit"]');
await until(async () => (await backgroundOnDisk())?.fit === 'fit');
await until(async () => (await lastGround(from))?.w === 1920, 10000);
r.fit = { disk: await backgroundOnDisk(), frame: await lastGround(from), ground: await groundOf() };
await click('[data-background-remove]');
await until(async () => (await backgroundOnDisk())?.image === undefined);
r.removed = await backgroundOnDisk();

// ---- CLOSING ----
await keyOn('[data-background-panel]', 'Escape');
await until(async () => !(await panelOpen()), 3000);
r.escClosed = { closed: !(await panelOpen()), lit: await attr(icon(KEY), 'aria-pressed') };
await openPanel();
await inEditor(`(() => { const w = document.querySelector('.well'); const b = w.getBoundingClientRect(); const t = document.elementFromPoint(b.left + 6, b.bottom - 6) ?? w; t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: b.left + 6, clientY: b.bottom - 6 })); return true; })()`);
r.outsideClosed = await until(async () => !(await panelOpen()), 3000);

// ---- EACH PAGE ITS OWN ----
await tab('Big');
await until(async () => (await groundOf())?.opacity === 100);
r.otherPage = { icon: await exists(icon(KEY)), ground: await groundOf(), disk: await backgroundOnDisk('big') };
await openPanel();
r.otherPanelNames = await attr('[data-background-panel]', 'data-background-panel');
await keyOn('[data-background-panel]', 'Escape');
// A new page starts black.
await click('.tab-add');
await until(() => exists('.add-menu-wrap .tab-menu-item'));
await click('.add-menu-wrap .tab-menu-item');
await until(() => exists('.add-page input'));
await typeInto('.add-page input', 'Fresh');
await click('[data-add-page-submit]');
await until(async () => Object.values((await onDisk()).profiles.default.layouts[KEY].pages).some((p) => p.name === 'Fresh'));
const fresh = Object.values((await onDisk()).profiles.default.layouts[KEY].pages).find((p) => p.name === 'Fresh');
r.newPage = { background: fresh.background ?? null };
// New page goes to the page it made: wait for that before going back, or it lands after.
await mustSee('the new page shown', async () => !['main', 'big'].includes(await inEditor(`document.querySelector('[data-deck-panel="${KEY}"] .deck-panel-page [data-dropdown]')?.dataset.value`)));
r.newPageGround = await groundOf();
await tab('Main');

// ---- BLACK, FILL AND 100%: nothing stored ----
await openPanel();
await click('[data-background-swatch]');
await until(() => exists('[data-background-chip="#000000"]'));
await click('[data-background-chip="#000000"]');
await pressKey('[data-background-panel] [role=slider]', 'End');
await until(async () => (await backgroundOnDisk()) === null);
r.plain = { disk: await pageOnDisk('main') };
// A background for Edit layout to show.
await typeInto('[data-background-hex]', '#0a3020');
await until(async () => (await backgroundOnDisk())?.color === '#0a3020');
await keyOn('[data-background-panel]', 'Escape');

// ---- EDIT LAYOUT: the icon dimmed, the background behind the controls ----
r.headerBeforeMode = await inEditor(`[...document.querySelectorAll('[data-deck-panel="${KEY}"] .deck-panel-header button')].map((b) => b.className + (b.disabled ? ':disabled' : ''))`);
await mustSee('Edit layout on the custom page', () => exists(`[data-deck-panel="${KEY}"] [data-edit-layout]`));
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(() => exists('[data-mode-bar]'));
await sleep(200);
r.mode = {
  iconDisabled: await inEditor(`document.querySelector(${JSON.stringify(icon(KEY))})?.disabled ?? null`),
  ground: await inEditor(`(() => { const g = document.querySelector('.layout-canvas [data-page-ground], .layout-screen [data-page-ground]'); return g ? g.dataset.groundColor : null; })()`),
  behind: await inEditor(`(() => { const c = document.querySelector('.layout-canvas [data-key="k1"]'); const g = document.querySelector('.layout-canvas [data-page-ground]'); if (!c || !g) return null; const b = c.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-page-ground]') === null; })()`),
};
await click('[data-done]');
await until(async () => !(await exists('[data-mode-bar]')));

// ---- GNOME: the full-screen window says so ----
await fs.writeFile(surfaceFile, 'fullscreen-window\n');
const helperPid = (await frames()).filter((f) => f.type === 'start').at(-1).pid;
process.kill(helperPid, 'SIGUSR1');
await sleep(300);
// A page change makes the daemon report its state again, the surface with it.
await tab('Big');
await tab('Main');
await openPanel();
await pressKey('[data-background-panel] [role=slider]', 'Home');
await until(() => exists('[data-background-line]'));
r.gnome = await until(() => exists('[data-background-gnome]'), 5000);

editor.child.kill();
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

// ---- RESULTS ----
check('the background icon is on the virtual deck\'s header, not the Stream Deck\'s; only a virtual deck\'s page draws a background', () =>
  assert.deepEqual(r.icons, { virtual: true, streamDeck: false, xlGround: false }));
check('an existing page with no background is drawn black and opaque, no checker', () =>
  assert.deepEqual(r.startGround && { color: r.startGround.color, opacity: r.startGround.opacity, checker: r.startGround.checker }, { color: '#000000', opacity: 100, checker: false }));
check('the icon opens the panel for the page shown, named, and is lit', () => assert.deepEqual(r.opened, { page: 'Main', lit: 'true' }));
check('a swatch: saved on the page, sent to the deck, drawn behind the keys', () => {
  assert.deepEqual(r.swatch.disk, { color: '#2b2350' });
  assert.equal(r.swatch.frame.alpha, 255);
  assert.equal(r.swatch.ground.color, '#2b2350');
});
check('typed hex: saved', () => assert.deepEqual(r.hex, { color: '#102030' }));
check('at 100%, no see-through line', () => assert.equal(r.noLineAt100, true));
check('fully clear: saved as 0, sent with alpha 0, the one line, a checker behind it; no GNOME note on a layer-shell screen', () => {
  assert.equal(r.clear.disk.opacity, 0);
  assert.equal(r.clear.alpha, 0);
  assert.equal(r.clear.line, 'Whatever is on that screen behind the deck shows through, and can’t be touched.');
  assert.equal(r.clear.gnome, false);
  assert.equal(r.clear.ground.checker, true);
  assert.equal(r.clear.ground.layerOpacity, '0');
});
check('opacity moved: shown on the page while it moves, saved only when let go', () => {
  assert.equal(r.whileMoving.ground, 60, 'the page shows 60%');
  assert.equal(r.whileMoving.disk, 0, 'not saved yet');
  assert.equal(r.afterMove.disk, 60);
  assert.equal(r.afterMove.ground.layerOpacity, '0.6');
});
check('the image chooser lists the pictures; one over 10 MB and one over 4096 px are refused with their reasons, dimmed, and not chosen', () => {
  assert.deepEqual([...r.chooserTiles].sort(), ['dusk.png', 'mural.png', 'poster.png']);
  assert.equal(r.tooBig.message, 'poster.png is too big: 12.0 MB. The limit is 10 MB.');
  assert.equal(r.tooBig.dimmed, true);
  assert.equal(r.tooLarge, 'mural.png is too large: 5000 × 10 px. The limit is 4096 px on the longer side.');
  assert.equal(r.refusedNotChosen, null);
});
check('a picture chosen: its path saved (never copied), the chooser closed, the deck sent a picture the screen\'s size, the editor drawing it', () => {
  assert.equal(r.chosen.disk.image, '~/Pictures/dusk.png');
  assert.equal(r.chosen.chooserGone, true);
  assert.equal(r.chosen.frame.h, 720);
  assert.equal(r.chosen.frame.samples['0,0'].join(), '255,0,0,153');
  assert.equal(r.imageGround.image, '~/Pictures/dusk.png');
});
check('every control on the page is opaque over the background, an empty one included', () =>
  assert.deepEqual(r.controlsOpaque.map((c) => c.opaque), [true, true], JSON.stringify(r.controlsOpaque)));
check('Fit: saved, sent with the colour either side, drawn as contain', () => {
  assert.equal(r.fit.disk.fit, 'fit');
  assert.equal(r.fit.frame.samples['10,360'].join(), '16,32,48,153');
  assert.equal(r.fit.ground.fit, 'fit');
});
check('✕ removes the image and its fit', () => assert.deepEqual(r.removed, { color: '#102030', opacity: 60 }));
check('Esc closes the panel, the icon no longer lit; a click outside closes it', () => {
  assert.deepEqual(r.escClosed, { closed: true, lit: 'false' });
  assert.equal(r.outsideClosed, true);
});
check('each page its own: a grid page has the icon, its own black background, and its own panel', () => {
  assert.equal(r.otherPage.icon, true);
  assert.equal(r.otherPage.ground.color, '#000000');
  assert.equal(r.otherPage.disk, null);
  assert.equal(r.otherPanelNames, 'Big');
});
check('a new page starts black: no background stored, drawn black', () => {
  assert.deepEqual(r.newPage, { background: null });
  assert.deepEqual([r.newPageGround.color, r.newPageGround.opacity], ['#000000', 100]);
});
check('black, Fill and 100% store nothing: the page as before backgrounds', () => assert.equal('background' in r.plain.disk, false));
check('in Edit layout the icon is dimmed and the page\'s background stays visible behind the controls', () =>
  assert.deepEqual(r.mode, { iconDisabled: true, ground: '#0a3020', behind: true }));
check('on GNOME\'s full-screen window, below 100% the panel says see-through may not work', () => assert.equal(r.gnome, true));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
