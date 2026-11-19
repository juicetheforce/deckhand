// Edit layout (scope §7, round 2a), end to end in real Electron: the main
// window with a virtual deck connected through the real virtual driver and
// scripts/test/fake-panel.mjs as its display helper, beside a fake Stream Deck.
// What is checked from outside the page: config.json on disk and the helper's
// frames.
//
// - Drawing: a virtual deck's page positioned (keys where its panel puts
//   them, their shapes); a Stream Deck's grid as it was. The header: columns
//   × rows on a preset page, the screen's resolution on a custom page; its
//   frame never narrower than its header.
// - Entering: Edit layout only on a virtual deck's header; on a preset it
//   asks once, Cancel changes nothing, Make it custom keeps every key. The
//   mode: lit button, mode bar for crumbs and tabs, Controls palette, the Page
//   ▾ and Change layout… dimmed, only the deck being edited shown, zoom.
// - In the mode: moving and resizing by dragging (stopped at the canvas's
//   edges, saved on release), typed values, shape and corners, Lock
//   proportions, the very-small warning, overlap and its marker and line,
//   Bring to front and Send to back, Duplicate (Ctrl+D) with its key, Delete
//   warning for a key and not for an empty control, the palette.
// - Leaving: Discard changes puts the page back, deleted keys included; every
//   control deleted puts it back and shows it empty, never saved empty;
//   Blank from New page and Change layout… are shown empty and saved only at a
//   first control; Done, a profile change and a deck key changing page all
//   leave; Change layout… from a custom page loses every key.
//
// Usage: npm run check:layout   (builds first)
// DECKHAND_LAYOUT_SHOTS=<dir> DECKHAND_LAYOUT_SHOT=<name> also saves the window as <dir>/<name>.png at the
// step of that name (shot() below), to look at: one per run, as only a hidden window's first capture resolves.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, inPage, onPrivateBus, startEditor, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_LAYOUT_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-layout-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const socks = path.join(scratch, 'socks');
const panelLog = path.join(scratch, 'panel.log');
const shots = process.env.DECKHAND_LAYOUT_SHOTS ?? null;
const shotAt = process.env.DECKHAND_LAYOUT_SHOT ?? null;
await fs.mkdir(configDir);
await fs.mkdir(socks);
if (shots) await fs.mkdir(shots, { recursive: true });

const { edid, fakeSysfs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);

Object.assign(process.env, {
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_INPUT_BIN: path.join(repoRoot, 'scripts/test/fake-input-helper.mjs'),
  DECKHAND_DRM_DIR: sysfs.drm,
  DECKHAND_INPUT_DIR: sysfs.input,
  DECKHAND_UDEV_DATA_DIR: sysfs.udev,
  DECKHAND_DEV_INPUT_DIR: sysfs.dev,
  DECKHAND_PANEL_BIN: path.join(repoRoot, 'scripts/test/fake-panel.mjs'),
  FAKE_PANEL_LOG: panelLog,
  FAKE_PANEL_INPUT_DIR: socks,
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { createVirtualDriver } = await import(pathToFileURL(path.join(repoRoot, 'dist/drivers/virtual.js')).href);
const { makePanel, newButtonSide } = await import(pathToFileURL(path.join(repoRoot, 'dist/panel-presets.js')).href);
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

const XL = 'LAYOUT-CHECK-XL';
const KEY = 'GRA-6e4e';
const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const MEDIUM = makePanel(SCREEN, 'medium');
const LARGE = makePanel(SCREEN, 'large');
const xlPage = { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'XL' } } } } };
const virtualLayout = () => ({
  startPage: 'main',
  pages: {
    main: { name: 'Main', panel: structuredClone(MEDIUM), buttons: { k1: { label: 'Mic', action: { type: 'noop' } }, k2: { label: 'Two' } } },
    big: { name: 'Big', panel: structuredClone(LARGE), buttons: { k1: { label: 'Large one' } } },
    // Grid Size 2 × 2: two columns, a frame of 214 px — far narrower than a virtual deck's header.
    narrow: { name: 'Narrow', panel: makePanel(SCREEN, 'custom', { rows: 2, columns: 2 }), buttons: {} },
  },
});
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' }, [KEY]: { name: 'Touch', virtual: { output: 'DP-4', panel: structuredClone(MEDIUM) } } },
  profiles: {
    default: { name: 'Default', layouts: { [XL]: xlPage, [KEY]: virtualLayout() } },
    second: { name: 'Second', layouts: { [XL]: xlPage, [KEY]: virtualLayout() } },
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
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

const onDisk = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));
const pageOnDisk = async (name, profile = 'default') => Object.values((await onDisk()).profiles[profile].layouts[KEY].pages).find((p) => p.name === name) ?? null;
const frames = async () => (await fs.readFile(panelLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;

const editor = startEditor(electronPath, editorRoot, env);
const inEditor = (expr) => inPage(editor, 'editor', expr);
const exists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const click = (selector) => inEditor(clickIn(selector));
const count = (selector) => inEditor(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const text = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const typeInto = (selector, value) =>
  inEditor(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
/** A typed value saved as leaving the field does: React listens for focusout (REFERENCE, traps). */
const typeAndLeave = async (selector, value) => {
  await typeInto(selector, value);
  await inEditor(`(() => { document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return true; })()`);
};
const key = (code, opts = {}) =>
  inEditor(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: ${JSON.stringify(code)}, key: ${JSON.stringify(opts.key ?? code)}, ctrlKey: ${!!opts.ctrl} })); return true; })()`);
/**
 * A pointer drag in the mode: down on `selector` (a control's face, or a
 * handle) at its middle, then moved by dx, dy canvas pixels and let go, the
 * moves sent to the layout canvas as its pointer capture would.
 */
const drag = (selector, dx, dy) =>
  inEditor(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no ' + ${JSON.stringify(selector)});
    const surface = document.querySelector('.layout-canvas');
    const scale = surface.getBoundingClientRect().width / Number(surface.dataset.layoutSize.split('x')[0]);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const at = (tx, ty) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: tx, clientY: ty });
    el.dispatchEvent(new PointerEvent('pointerdown', at(x, y)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(x + (${dx} * scale) / 2, y + (${dy} * scale) / 2)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(x + ${dx} * scale, y + ${dy} * scale)));
    surface.dispatchEvent(new PointerEvent('pointerup', at(x + ${dx} * scale, y + ${dy} * scale)));
    return true;
  })()`);
const select = (id) => drag(`.layout-canvas [data-key="${id}"]`, 0, 0);
const shot = async (name) => {
  if (shots && name === shotAt) console.log(`shot ${name}: ${(await capture(editor, path.join(shots, `${name}.png`))) ? 'saved' : 'FAILED'}`);
};
const page = async (name) => (await pageOnDisk(name)) ?? {};
const controlsOf = async (name) => (await page(name)).panel?.controls ?? [];
const controlOf = async (name, id) => (await controlsOf(name)).find((c) => c.id === id);
const inMode = () => exists('[data-mode-bar]');

const r = {};
// A step that throws ends the run: say how far it got, and what it had recorded, rather than only where.
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
// Two decks connected: show the virtual deck alone, as most of this is about it.
await until(() => exists('.show-in-editor-trigger'));
await click('.show-in-editor-trigger');
await until(() => exists(`[data-show-deck="${KEY}"] .show-in-editor-name`));
await click(`[data-show-deck="${KEY}"] .show-in-editor-name`);
await until(async () => (await count('.well [data-key]')) === 24);

// ---- DRAWING ----
r.positioned = await inEditor(`(() => { const g = document.querySelector('.grid[data-deck="${KEY}"]'); return g ? [g.classList.contains('grid-positioned'), document.querySelectorAll('.grid [data-key].key-placed').length] : null; })()`);
// Medium on 1920 × 720 is 3 rows of 8, 240 px apart: k2 sits right of k1, the same size, in proportion.
r.placed = await inEditor(`(() => { const k = (id) => document.querySelector('.grid [data-key="' + id + '"]').getBoundingClientRect(); const a = k('k1'); const b = k('k2'); const g = document.querySelector('.grid[data-deck="${KEY}"]').getBoundingClientRect(); return { sameTop: Math.abs(a.top - b.top) < 0.5, pitch: (b.left - a.left) / g.width, ratio: g.width / g.height }; })()`);
r.sizePreset = await text(`[data-deck-panel="${KEY}"] .deck-panel-size`);
r.editOnVirtual = await exists(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await shot('1-preset-page');

// ---- ENTERING, FROM A PRESET ----
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.asked = await until(() => exists('[data-make-custom]'));
r.askedText = await text('[data-make-custom]');
await shot('2-make-custom');
await inEditor(`(() => { [...document.querySelectorAll('[data-make-custom] button')].find((b) => b.textContent === 'Cancel').click(); return true; })()`);
r.cancelGone = await until(async () => !(await exists('[data-make-custom]')));
r.cancelNotMode = !(await inMode());
r.cancelUnchanged = (await page('Main')).panel.preset === 'medium';
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(() => exists('[data-make-custom-confirm]'));
await click('[data-make-custom-confirm]');
r.madeCustom = await until(async () => (await page('Main')).panel?.preset === 'free');
r.madeCustomKept = await page('Main');
r.inMode = await until(inMode);
r.lit = await inEditor(`document.querySelector('[data-deck-panel="${KEY}"] [data-edit-layout]')?.getAttribute('aria-pressed')`);
r.palette = await exists('[data-controls-palette] [data-palette=button]');
r.noLibrary = !(await exists('.library:not(.controls-palette)'));
r.noTabs = !(await exists('.tabs'));
r.modeBarText = await text('[data-mode-bar] .mode-bar-where');
r.pageLocked = await inEditor(`[...document.querySelectorAll('[data-deck-panel="${KEY}"] .deck-panel-page button, [data-deck-panel="${KEY}"] .deck-panel-change-layout')].every((b) => b.disabled)`);
r.onlyThisDeck = await inEditor(`[...document.querySelectorAll('[data-deck-panel]')].map((p) => p.dataset.deckPanel)`);
r.zoom = await exists('[data-zoom-bar]');
r.sizeCustom = await text(`[data-deck-panel="${KEY}"] .deck-panel-size`);
r.discardDimmed = await inEditor("document.querySelector('[data-discard-changes]').disabled");
r.title = await inEditor('document.title');
r.inspectorNone = await text('[data-layout-inspector=none]');
await shot('3-mode-open');

// ---- MOVING AND RESIZING ----
const before = await controlOf('Main', 'k1');
const framesBefore = (await frames()).length;
await drag('.layout-canvas [data-key="k1"]', 500, 37);
r.moved = await until(async () => (await controlOf('Main', 'k1'))?.x === before.x + 500);
r.movedTo = await controlOf('Main', 'k1');
r.movedKeys = (await page('Main')).buttons;
r.movedSelected = await exists('[data-selected-control="k1"]');
r.movedSentToDeck = await until(async () => (await frames()).slice(framesBefore).some((f) => f.type === 'I'));
await drag('.layout-canvas [data-key="k1"]', -5000, -5000);
r.stoppedAtEdge = await until(async () => {
  const c = await controlOf('Main', 'k1');
  return c?.x === 0 && c?.y === 0;
});
await drag('[data-handle=e]', 100, 0);
r.resized = await until(async () => (await controlOf('Main', 'k1'))?.w === before.w + 100);
r.resizedTo = await controlOf('Main', 'k1');
await typeAndLeave('[data-layout-field=X]', '5000');
r.typedX = await until(async () => (await controlOf('Main', 'k1'))?.x === 1920 - (before.w + 100));
await typeAndLeave('[data-layout-field=W]', '60');
await typeAndLeave('[data-layout-field=H]', '60');
r.small = await until(() => exists('[data-very-small="k1"]'));
r.smallText = await text('[data-very-small="k1"]');
await typeAndLeave('[data-layout-field=W]', '300');
await typeAndLeave('[data-layout-field=H]', '200');
await until(async () => (await controlOf('Main', 'k1'))?.h === 200);
r.notSmall = !(await exists('[data-very-small="k1"]'));
await typeAndLeave('[data-layout-field=X]', '100');
await until(async () => (await controlOf('Main', 'k1'))?.x === 100);
await inEditor(clickIn('.form-check input'));
r.locked = await until(async () => (await controlOf('Main', 'k1'))?.keepRatio === true);
await drag('[data-handle=e]', 150, 0);
r.lockedResize = await until(async () => (await controlOf('Main', 'k1'))?.w === 450);
r.lockedTo = await controlOf('Main', 'k1');

// ---- SHAPE ----
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] .segment')].find((b) => b.textContent === 'Round').click(); return true; })()`);
r.round = await until(async () => (await controlOf('Main', 'k1'))?.shape === 'round');
r.roundDrawn = await inEditor(`(() => { const k = document.querySelector('.layout-canvas [data-key="k1"]'); return [k.classList.contains('key-shaped'), getComputedStyle(k).borderTopLeftRadius]; })()`);
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] .segment')].find((b) => b.textContent === 'Hexagon').click(); return true; })()`);
r.hexagon = await until(async () => (await controlOf('Main', 'k1'))?.shape === 'hexagon');
r.hexDrawn = await inEditor(`getComputedStyle(document.querySelector('.layout-canvas [data-key="k1"]')).clipPath`);
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] .segment')].find((b) => b.textContent === 'Rectangle').click(); return true; })()`);
await until(async () => (await controlOf('Main', 'k1'))?.shape === 'rectangle');
await inEditor(`(() => { const i = document.querySelector('[data-layout-inspector] input[type=range]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '9999'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
r.pill = await until(async () => {
  const c = await controlOf('Main', 'k1');
  return c?.radius === Math.floor(Math.min(c.w, c.h) / 2);
});
await shot('4-shapes');

// ---- OVERLAP AND ORDER ---- k1, first in the panel's order, moved onto k2: k2 is on top of it.
const k2 = await controlOf('Main', 'k2');
await typeAndLeave('[data-layout-field=X]', String(k2.x));
await typeAndLeave('[data-layout-field=Y]', String(k2.y));
r.overlapMarker = await until(() => exists('[data-overlapped="k1"]'));
r.overlapNotOnTop = !(await exists('[data-overlapped="k2"]'));
r.overlapLine = await text('[data-overlap-line="k1"]');
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] button')].find((b) => b.textContent === 'Bring to front').click(); return true; })()`);
r.broughtToFront = await until(async () => (await controlsOf('Main')).at(-1)?.id === 'k1');
r.markerAfterFront = await until(() => exists('[data-overlapped="k2"]'));
r.lineAfterFront = await text('[data-overlap-line="k1"]');
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] button')].find((b) => b.textContent === 'Send to back').click(); return true; })()`);
r.sentToBack = await until(async () => (await controlsOf('Main'))[0]?.id === 'k1');
r.markerAfterBack = await until(() => exists('[data-overlapped="k1"]'));
await inEditor(`(() => { [...document.querySelectorAll('[data-layout-inspector] button')].find((b) => b.textContent === 'Bring to front').click(); return true; })()`);
await until(async () => (await controlsOf('Main')).at(-1)?.id === 'k1');
await shot('5-overlap');

// ---- DUPLICATE, DELETE, ADD ----
const n0 = (await controlsOf('Main')).length;
await key('KeyD', { ctrl: true, key: 'd' });
r.duplicated = await until(async () => (await controlsOf('Main')).length === n0 + 1);
const copy = (await controlsOf('Main')).at(-1);
r.duplicate = { id: copy.id, offset: [copy.x - (await controlOf('Main', 'k1')).x, copy.y - (await controlOf('Main', 'k1')).y], button: (await page('Main')).buttons[copy.id] };
r.duplicateSelected = await exists(`[data-selected-control="${copy.id}"]`);
await key('Delete');
r.deleteAsked = await until(() => exists('[data-delete-control]'));
r.deleteText = await text('[data-delete-control]');
await click('[data-delete-control-confirm]');
r.deleted = await until(async () => !(await controlsOf('Main')).some((c) => c.id === copy.id));
r.deletedKey = (await page('Main')).buttons[copy.id] ?? null;
await select('k5');
await key('Delete');
r.emptyDeleted = await until(async () => !(await controlsOf('Main')).some((c) => c.id === 'k5'));
r.emptyNotAsked = !(await exists('[data-delete-control]'));
await inEditor(`(() => { document.querySelector('[data-palette=button]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3, clientX: 10, clientY: 10 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientX: 10, clientY: 10 })); return true; })()`);
r.added = await until(async () => (await controlsOf('Main')).some((c) => c.id.startsWith('c')));
r.addedControl = (await controlsOf('Main')).find((c) => c.id.startsWith('c'));
r.addedSelected = await exists(`[data-selected-control="${r.addedControl?.id}"]`);
// Dragged from the palette onto the panel's top-left corner: it lands there, on the canvas.
await inEditor(`(() => { const s = document.querySelector('.layout-canvas').getBoundingClientRect(); const b = document.querySelector('[data-palette=button]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 4, clientX: 5, clientY: 5 })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 4, clientX: s.left + 3, clientY: s.top + 3 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4, clientX: s.left + 3, clientY: s.top + 3 })); return true; })()`);
r.dropped = await until(async () => (await controlsOf('Main')).some((c) => c.id.startsWith('c') && c.x === 0 && c.y === 0));
r.discardLit = await inEditor("!document.querySelector('[data-discard-changes]').disabled");
await shot('6-edited');

// ---- DISCARD CHANGES ----
await click('[data-discard-changes]');
r.discardAsked = await until(() => exists('[data-discard-card]'));
r.discardText = await text('[data-discard-card]');
await click('[data-discard-confirm]');
r.discarded = await until(async () => JSON.stringify(await page('Main')) === JSON.stringify(r.madeCustomKept));
r.discardLeft = await until(async () => !(await inMode()));
r.tabsBack = await exists('.tabs');

// ---- EVERY CONTROL DELETED: never saved empty ----
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(inMode);
const all = (await controlsOf('Main')).map((c) => c.id);
const savesBefore = (await frames()).length;
for (const id of all.slice(0, -1)) {
  await select(id);
  await key('Delete');
  if (await until(() => exists('[data-delete-control]'), 400)) await click('[data-delete-control-confirm]');
  await until(async () => !(await controlsOf('Main')).some((c) => c.id === id));
}
r.oneLeft = (await controlsOf('Main')).length;
await select(all.at(-1));
await key('Delete');
r.lastShownEmpty = await until(() => exists('.layout-empty'));
r.lastPutBack = await until(async () => JSON.stringify(await page('Main')) === JSON.stringify(r.madeCustomKept));
r.neverEmptyOnDisk = (await controlsOf('Main')).length > 0;
await shot('7-emptied');
await click('[data-done]');
r.doneLeft = await until(async () => !(await inMode()));
r.afterEmptyDone = await page('Main');
void savesBefore;

// ---- BLANK FROM NEW PAGE ----
await click('.tab-add');
await until(() => exists('.add-menu-wrap .tab-menu-item'));
await click('.add-menu-wrap .tab-menu-item');
await until(() => exists('[data-add-page=virtual] [data-vd-size=blank] input'));
await click('[data-add-page=virtual] [data-vd-size=blank] input');
await typeInto('[data-add-page] input[aria-label="New page name"]', 'Pads');
await sleep(100);
r.startBlankLabel = await text('[data-add-page-submit]');
await click('[data-add-page-submit]');
r.blankMode = await until(async () => (await inMode()) && (await exists('.layout-empty')));
r.blankOnDisk = await page('Pads');
await shot('8-blank');
await inEditor(`(() => { document.querySelector('[data-palette=button]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 5, clientX: 10, clientY: 10 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, clientX: 10, clientY: 10 })); return true; })()`);
r.blankFirst = await until(async () => (await controlsOf('Pads')).length === 1);
r.blankFirstPage = await page('Pads');
r.newButtonSide = newButtonSide(SCREEN);
r.blankStillOpen = await inMode();
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.litIsDone = await until(async () => !(await inMode()));
r.lastChoiceBlank = await (async () => {
  await click('.tab-add');
  await until(() => exists('.add-menu-wrap .tab-menu-item'));
  await click('.add-menu-wrap .tab-menu-item');
  await until(() => exists('[data-add-page=virtual] [data-vd-size=blank] input'));
  await sleep(200);
  const checked = await inEditor("document.querySelector('[data-add-page] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
  await key('Escape', { key: 'Escape' });
  await inEditor("(() => { document.querySelector('.tab-add')?.click(); return true; })()");
  return checked;
})();

// ---- BLANK FROM CHANGE LAYOUT…, LEFT EMPTY ----
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) !== null);
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Big').click(); return true; })()`);
await until(async () => (await count('.well [data-key]')) === 10);
const bigBefore = await page('Big');
await click(`[data-deck-panel="${KEY}"] .deck-panel-change-layout`);
await until(() => exists('[data-change-layout] [data-vd-size=blank] input'));
await click('[data-change-layout] [data-vd-size=blank] input');
r.blankWarning = await text('[data-change-loses-all]');
await click('[data-change-layout-apply]');
r.changeBlankMode = await until(async () => (await inMode()) && (await exists('.layout-empty')));
r.changeBlankUntouched = JSON.stringify(await page('Big')) === JSON.stringify(bigBefore);
// Left by a profile change: acts as Done; the page stays as it was.
await daemon.profiles.switchTo('second', daemon.sessions);
r.profileLeft = await until(async () => !(await inMode()), 5000);
r.bigAfter = JSON.stringify(await page('Big')) === JSON.stringify(bigBefore);

// ---- A DECK KEY CHANGING PAGE ACTS AS DONE ----
await daemon.profiles.switchTo('default', daemon.sessions);
await until(async () => (await inEditor("document.querySelector('[data-profile-crumb], .crumb')?.textContent ?? ''")) !== '');
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Main')?.click(); return true; })()`);
await until(async () => daemon.sessions.get(KEY)?.currentPage() === 'main', 5000);
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.reentered = await until(inMode);
await sleep(300);
await daemon.sessions.get(KEY).goToPage('big');
r.deckKeyLeft = await until(async () => !(await inMode()), 5000);

// ---- CHANGE LAYOUT… FROM A CUSTOM PAGE TO A FIXED GRID ----
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Big', 5000);
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Main').click(); return true; })()`);
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Main');
await click(`[data-deck-panel="${KEY}"] .deck-panel-change-layout`);
await until(() => exists('[data-change-layout] [data-vd-size=medium] input'));
r.customPreselected = await inEditor("document.querySelector('[data-change-layout] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
await click('[data-change-layout] [data-vd-size=medium] input');
r.customWarning = await text('[data-change-loses-all]');
await click('[data-change-layout-apply]');
r.backToGrid = await until(async () => (await page('Main')).panel?.preset === 'medium');
r.backToGridKeys = (await page('Main')).buttons;

// ---- A STREAM DECK ----
await click('.show-in-editor-trigger');
await until(() => exists(`[data-show-deck="${XL}"] .show-in-editor-name`));
await click(`[data-show-deck="${XL}"] .show-in-editor-name`);
await until(() => exists(`[data-deck-panel="${XL}"]`));
r.xlEdit = await exists(`[data-deck-panel="${XL}"] [data-edit-layout]`);
r.xlGrid = await inEditor(`(() => { const g = document.querySelector('.grid[data-deck="${XL}"]'); return g ? g.classList.contains('grid-positioned') : null; })()`);

// ---- THE HEADER NEVER WIDER THAN ITS FRAME ----
await click('.show-in-editor-trigger');
await until(() => exists(`[data-show-deck="${KEY}"] .show-in-editor-name`));
await click(`[data-show-deck="${KEY}"] .show-in-editor-name`);
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Narrow').click(); return true; })()`);
await until(async () => (await count('.well [data-key]')) === 4);
await sleep(300);
r.headerFits = await inEditor(`(() => { const p = document.querySelector('[data-deck-panel="${KEY}"]'); const pr = p.getBoundingClientRect(); const items = [...p.querySelectorAll('.deck-panel-header > *:not(.toolbar-spacer)')]; return items.map((i) => { const b = i.getBoundingClientRect(); return b.right <= pr.right + 0.5 && b.width > 0; }); })()`);
r.narrowCentred = await inEditor(`(() => { const p = document.querySelector('[data-deck-panel="${KEY}"]').getBoundingClientRect(); const g = document.querySelector('.grid[data-deck="${KEY}"]').getBoundingClientRect(); return Math.abs((g.left - p.left) - (p.right - g.right)) < 2; })()`);
await shot('9-narrow-header');

editor.child.kill();
stopWatching();
await daemon.stop();

// ---- RESULTS ----
const medium = MEDIUM.controls;
check('a virtual deck\'s page is drawn positioned: every key placed, at the panel\'s proportions', () => {
  assert.deepEqual(r.positioned, [true, 24]);
  assert.equal(r.placed.sameTop, true);
  assert.ok(Math.abs(r.placed.pitch - 240 / 1920) < 0.01, JSON.stringify(r.placed));
  assert.ok(Math.abs(r.placed.ratio - 1920 / 720) < 0.05, JSON.stringify(r.placed));
});
check('the header: columns × rows on a preset page, the screen\'s resolution on a custom page', () => {
  assert.equal(r.sizePreset, '8 × 3');
  assert.equal(r.sizeCustom, '1920 × 720');
});
check('Edit layout on a preset asks once; Cancel changes nothing', () => {
  assert.equal(r.editOnVirtual, true);
  assert.equal(r.asked, true);
  assert.match(r.askedText, /Make this page a custom layout\?.*Every key and its action is kept/);
  assert.equal(r.cancelGone, true);
  assert.equal(r.cancelNotMode, true);
  assert.equal(r.cancelUnchanged, true);
});
check('Make it custom: the same controls in the same places, every key kept, then straight into the mode', () => {
  assert.equal(r.madeCustom, true);
  assert.deepEqual(r.madeCustomKept.panel.controls, medium);
  assert.deepEqual(r.madeCustomKept.buttons, { k1: { label: 'Mic', action: { type: 'noop' } }, k2: { label: 'Two' } });
  assert.equal(r.inMode, true);
});
check('the mode: the button lit, the mode bar for crumbs and tabs, the palette for the library, the Page ▾ and Change layout… dimmed', () => {
  assert.equal(r.lit, 'true');
  assert.equal(r.palette, true);
  assert.equal(r.noLibrary, true);
  assert.equal(r.noTabs, true);
  assert.match(r.modeBarText, /Touch · 1920 × 720 › Default › Main/);
  assert.equal(r.pageLocked, true);
  assert.equal(r.title, 'Edit layout — Touch');
  assert.match(r.inspectorNone, /Touch.*1920 × 720 · 24 controls/);
});
check('…only the deck being edited is shown, with zoom; Discard changes dimmed until something changes', () => {
  assert.deepEqual(r.onlyThisDeck, [KEY]);
  assert.equal(r.zoom, true);
  assert.equal(r.discardDimmed, true);
});
check('a drag moves a control, saved on release, its key kept; the deck is sent the new layout', () => {
  assert.equal(r.moved, true, JSON.stringify(r.movedTo));
  assert.equal(r.movedTo.y, medium[0].y + 37);
  assert.deepEqual(r.movedKeys.k1, { label: 'Mic', action: { type: 'noop' } });
  assert.equal(r.movedSelected, true);
  assert.equal(r.movedSentToDeck, true);
});
check('controls cannot leave the canvas: a drag and a typed value stop at its edge', () => {
  assert.equal(r.stoppedAtEdge, true);
  assert.equal(r.typedX, true);
});
check('a handle resizes; Lock proportions keeps the box\'s shape', () => {
  assert.equal(r.resized, true, JSON.stringify(r.resizedTo));
  assert.equal(r.locked, true);
  assert.equal(r.lockedResize, true, JSON.stringify(r.lockedTo));
  assert.equal(r.lockedTo.h, 300);
});
check('the very-small warning under about 15 mm, with the figure, and gone above it', () => {
  assert.equal(r.small, true);
  assert.match(r.smallText, /Very small · about 8 mm\. Hard to press\./);
  assert.equal(r.notSmall, true);
});
check('shapes: round, hexagon and a rectangle\'s corners up to a full pill, drawn on their shape', () => {
  assert.equal(r.round, true);
  assert.deepEqual(r.roundDrawn, [true, '50%']);
  assert.equal(r.hexagon, true);
  assert.match(r.hexDrawn, /polygon/);
  assert.equal(r.pill, true);
});
check('overlap: the marker on the control underneath, the inspector\'s line, and the order changed by Send to back and Bring to front', () => {
  assert.equal(r.overlapMarker, true);
  assert.equal(r.overlapNotOnTop, true);
  assert.match(r.overlapLine, /^Under Key \d+/);
  assert.equal(r.broughtToFront, true);
  assert.equal(r.markerAfterFront, true);
  assert.match(r.lineAfterFront, /^On top of Key \d+/);
  assert.equal(r.sentToBack, true);
  assert.equal(r.markerAfterBack, true);
});
check('Ctrl+D duplicates the control with its key, one grid step on, selected', () => {
  assert.equal(r.duplicated, true);
  assert.deepEqual(r.duplicate.button, { label: 'Mic', action: { type: 'noop' } });
  assert.equal(r.duplicateSelected, true);
});
check('Delete asks when a key would be lost, naming it; an empty control goes at once', () => {
  assert.equal(r.deleteAsked, true);
  assert.match(r.deleteText, /Delete this control\?.*Its key goes with it.*Mic/);
  assert.equal(r.deleted, true);
  assert.equal(r.deletedKey, null);
  assert.equal(r.emptyDeleted, true);
  assert.equal(r.emptyNotAsked, true);
});
check('the palette adds a Button: about 30 mm, in the middle on a click, where it is dropped on a drag', () => {
  assert.equal(r.added, true);
  assert.equal(r.addedControl.w, r.newButtonSide);
  assert.equal(r.addedControl.x, Math.round(960 - r.newButtonSide / 2));
  assert.equal(r.addedSelected, true);
  assert.equal(r.dropped, true);
  assert.equal(r.discardLit, true);
});
check('Discard changes says what it puts back, then the layout is as the mode found it, deleted keys back, and the mode is closed', () => {
  assert.equal(r.discardAsked, true);
  assert.match(r.discardText, /Added.*removed.*Moved or resized.*put back.*Deleted.*1 control, returns with its key/);
  assert.equal(r.discarded, true);
  assert.equal(r.discardLeft, true);
  assert.equal(r.tabsBack, true);
});
check('every control deleted: shown empty, never saved empty — the page goes back as the mode found it, and Done leaves it so', () => {
  assert.equal(r.oneLeft, 1);
  assert.equal(r.lastShownEmpty, true);
  assert.equal(r.lastPutBack, true);
  assert.equal(r.neverEmptyOnDisk, true);
  assert.equal(r.doneLeft, true);
  assert.deepEqual(r.afterEmptyDone, r.madeCustomKept);
});
check('Blank from New page: the page made with the deck\'s default grid, shown empty in the mode; a first control saves it custom', () => {
  assert.equal(r.startBlankLabel, 'Start blank');
  assert.equal(r.blankMode, true);
  assert.deepEqual(r.blankOnDisk.panel.controls, medium);
  assert.equal(r.blankFirst, true);
  assert.equal(r.blankStillOpen, true, 'the first control\'s save closed the mode');
  assert.equal(r.blankFirstPage.panel.preset, 'free');
  assert.deepEqual(r.blankFirstPage.buttons, {});
  assert.equal(r.litIsDone, true);
  assert.equal(r.lastChoiceBlank, 'blank');
});
check('Blank from Change layout… warns, then leaves the page exactly as it was while it is empty; a profile change acts as Done', () => {
  assert.match(r.blankWarning, /starts again from Blank\. Every key on this page is lost/);
  assert.equal(r.changeBlankMode, true);
  assert.equal(r.changeBlankUntouched, true);
  assert.equal(r.profileLeft, true);
  assert.equal(r.bigAfter, true);
});
check('a deck key changing the page while the mode is open acts as Done', () => {
  assert.equal(r.reentered, true);
  assert.equal(r.deckKeyLeft, true);
});
check('Change layout… from a custom page to a fixed grid: warned, and every key is lost', () => {
  // A custom page is none of the fixed grids: Blank stands for its own choice (Claude's call).
  assert.equal(r.customPreselected, 'blank');
  assert.match(r.customWarning, /becomes a grid of buttons\. Every key on this page is lost, buttons included/);
  assert.equal(r.backToGrid, true);
  assert.deepEqual(r.backToGridKeys, {});
});
check('a Stream Deck: no Edit layout, and its grid as it was', () => {
  assert.equal(r.xlEdit, false);
  assert.equal(r.xlGrid, false);
});
check('a virtual deck\'s frame is never narrower than its header: every header item inside it on a two-column page, the panel centred', () => {
  assert.ok(r.headerFits.length >= 4 && r.headerFits.every(Boolean), JSON.stringify(r.headerFits));
  assert.equal(r.narrowCentred, true);
});

await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
