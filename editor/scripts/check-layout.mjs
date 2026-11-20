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
// - A page's kind for its whole life (Ryan, 2026-11-20): Edit layout only on a
//   custom page's header, Change layout… only on a grid page's (header and
//   tab menu), offering only the fixed grids. The mode: lit button, Discard
//   changes and Done beside it on the deck's header — Done seen on screen at
//   the window's normal size, near the deck, in the accent colour — the mode
//   bar for crumbs and tabs, Controls palette, the Page ▾ dimmed, only the
//   deck being edited shown, zoom.
// - In the mode: moving and resizing by dragging (stopped at the canvas's
//   edges, saved on release), typed values, shape and corners, Lock
//   proportions, the very-small warning, overlap and its marker and line,
//   Bring to front and Send to back, Duplicate (Ctrl+D) with its key, Delete
//   warning for a key and not for an empty control, the palette.
// - Leaving: Discard changes puts the page back, deleted keys included; every
//   control deleted puts it back and shows it empty, never saved empty;
//   Blank from New page is shown empty and saved only at a first control; Done,
//   a profile change and a deck key changing page all leave; Change layout…
//   from one grid to another.
// - Keys onto a custom page only onto controls; whole-page copies refused
//   whenever either side is a custom page.
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
    // A custom page: Medium's controls, made custom in 2a's way (a page's kind is now fixed for its life).
    main: { name: 'Main', panel: { ...structuredClone(MEDIUM), preset: 'free' }, buttons: { k1: { label: 'Mic', action: { type: 'noop' } }, k2: { label: 'Two' } } },
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
 * moves sent to the layout canvas as its pointer capture would. Shift held, so
 * neither the grid nor snapping moves it: these steps are about moving.
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
    const at = (tx, ty) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: tx, clientY: ty, shiftKey: true });
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
const tabMenu = async (tab) => {
  await inEditor(`(() => { const t = [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === ${JSON.stringify(tab)}); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
  await until(() => exists('.tab-menu'));
  const items = await inEditor("[...document.querySelectorAll('.tab-menu .tab-menu-item')].map((b) => b.textContent.trim())");
  await inEditor("(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); return true; })()");
  await until(async () => !(await exists('.tab-menu')), 2000);
  return items;
};
const showTab = async (tab, keys) => {
  await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === ${JSON.stringify(tab)}).click(); return true; })()`);
  await until(async () => (await count('.well [data-key]')) === keys);
};

// ---- A PAGE'S KIND: Edit layout on a custom page only, Change layout… on a grid page only ----
r.sizeCustomPage = await text(`[data-deck-panel="${KEY}"] .deck-panel-size`);
r.editOnCustom = await exists(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.noChangeOnCustom = !(await exists(`[data-deck-panel="${KEY}"] .deck-panel-change-layout`));
r.tabMenuCustom = await tabMenu('Main');
await showTab('Big', 10);
r.sizePreset = await text(`[data-deck-panel="${KEY}"] .deck-panel-size`);
r.noEditOnGrid = !(await exists(`[data-deck-panel="${KEY}"] [data-edit-layout]`));
r.tabMenuGrid = await tabMenu('Big');
await click(`[data-deck-panel="${KEY}"] .deck-panel-change-layout`);
await until(() => exists('[data-change-layout] [data-vd-size=small] input'));
r.changeChoices = await inEditor("[...document.querySelectorAll('[data-change-layout] [data-vd-size]')].map((e) => e.dataset.vdSize)");
r.changeNoTemplates = !(await exists('[data-change-layout] [data-template]'));
await inEditor(`(() => { [...document.querySelectorAll('[data-change-layout] button')].find((b) => b.textContent === 'Cancel').click(); return true; })()`);
await until(async () => !(await exists('[data-change-layout]')));
await showTab('Main', 24);
await shot('1-custom-page');

// ---- ENTERING ----
r.entryPage = await page('Main');
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.inMode = await until(inMode);
r.lit = await inEditor(`document.querySelector('[data-deck-panel="${KEY}"] [data-edit-layout]')?.getAttribute('aria-pressed')`);
// Done: on the deck's header, beside the lit button, seen — on screen at the window's normal size, not covered — and the accent colour.
await sleep(300);
r.done = await inEditor(`(() => {
  const d = document.querySelector('[data-done]');
  if (!d) return null;
  const panel = document.querySelector('[data-deck-panel="${KEY}"]');
  const b = d.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  const lit = panel.querySelector('[data-edit-layout]').getBoundingClientRect();
  const discard = panel.querySelector('[data-discard-changes]')?.getBoundingClientRect() ?? null;
  const canvas = panel.querySelector('.layout-canvas').getBoundingClientRect();
  const probe = document.createElement('span');
  probe.style.background = 'var(--accent)';
  document.body.append(probe);
  const accent = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    window: [innerWidth, innerHeight],
    size: [b.width, b.height],
    onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
    notCovered: hit === d || d.contains(hit),
    inDeckHeader: d.closest('[data-deck-panel="${KEY}"] .deck-panel-header') !== null,
    besideLit: discard !== null && discard.left >= lit.right && discard.left - lit.right < 24 && b.left >= discard.right && b.left - discard.right < 24 && Math.abs(b.top - lit.top) < 4,
    aboveDeck: canvas.top - b.bottom,
    accent: getComputedStyle(d).backgroundColor === accent && accent !== 'rgba(0, 0, 0, 0)',
    notInModeBar: document.querySelector('[data-mode-bar] [data-done], [data-mode-bar] [data-discard-changes]') === null,
  };
})()`);
r.palette = await exists('[data-controls-palette] [data-palette=button]');
r.noLibrary = !(await exists('.library:not(.controls-palette)'));
r.noTabs = !(await exists('.tabs'));
r.modeBarText = await text('[data-mode-bar] .mode-bar-where');
r.pageLocked = await inEditor(`[...document.querySelectorAll('[data-deck-panel="${KEY}"] .deck-panel-page button')].every((b) => b.disabled) && !document.querySelector('[data-deck-panel="${KEY}"] .deck-panel-change-layout')`);
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
r.discarded = await until(async () => JSON.stringify(await page('Main')) === JSON.stringify(r.entryPage));
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
r.lastPutBack = await until(async () => JSON.stringify(await page('Main')) === JSON.stringify(r.entryPage));
r.neverEmptyOnDisk = (await controlsOf('Main')).length > 0;
await shot('7-emptied');
await click('[data-done]');
r.doneLeft = await until(async () => !(await inMode()));
r.afterEmptyDone = await page('Main');
void savesBefore;

// ---- PRECISION (round 2b): snap, Shift, the grid, nudging, several selected ----
/** A point on the layout canvas, in canvas pixels, as client coordinates. */
const canvasPoint = (x, y) => `(() => { const s = document.querySelector('.layout-canvas'); const r = s.getBoundingClientRect(); const [w, h] = s.dataset.layoutSize.split('x').map(Number); return [r.left + (${x} / w) * r.width, r.top + (${y} / h) * r.height]; })()`;
/** Press and release on a control's face, Ctrl held or not: a click in the mode. */
const pressOn = (id, opts = {}) =>
  inEditor(`(() => {
    const el = document.querySelector('.layout-canvas [data-key="${id}"]');
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ctrlKey: ${!!opts.ctrl} };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    document.querySelector('.layout-canvas').dispatchEvent(new PointerEvent('pointerup', at));
    return true;
  })()`);
/** A drag of a control by dx, dy canvas pixels, Shift held or not: the snap guides drawn before the release, then released. */
const dragSeen = (id, dx, dy, opts = {}) =>
  inEditor(`(async () => {
    const el = document.querySelector('.layout-canvas [data-key="${id}"]');
    const surface = document.querySelector('.layout-canvas');
    const scale = surface.getBoundingClientRect().width / Number(surface.dataset.layoutSize.split('x')[0]);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const at = (tx, ty) => ({ bubbles: true, cancelable: true, pointerId: 12, button: 0, clientX: tx, clientY: ty, shiftKey: ${!!opts.shift} });
    el.dispatchEvent(new PointerEvent('pointerdown', at(x, y)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(x + (${dx} * scale) / 2, y + (${dy} * scale) / 2)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(x + ${dx} * scale, y + ${dy} * scale)));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const seen = [...document.querySelectorAll('[data-snap-guide]')].map((g) => g.dataset.snapGuide);
    surface.dispatchEvent(new PointerEvent('pointerup', at(x + ${dx} * scale, y + ${dy} * scale)));
    return seen;
  })()`);
/** A marquee over empty canvas from one canvas point to another. */
const marqueeOver = (from, to, opts = {}) =>
  inEditor(`(async () => {
    const surface = document.querySelector('.layout-canvas');
    const a = ${canvasPoint(from[0], from[1])};
    const b = ${canvasPoint(to[0], to[1])};
    const at = (p) => ({ bubbles: true, cancelable: true, pointerId: 13, button: 0, clientX: p[0], clientY: p[1], ctrlKey: ${!!opts.ctrl} });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(a)));
    surface.dispatchEvent(new PointerEvent('pointermove', at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])));
    surface.dispatchEvent(new PointerEvent('pointermove', at(b)));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const drawn = document.querySelector('[data-marquee]') !== null;
    surface.dispatchEvent(new PointerEvent('pointerup', at(b)));
    return drawn;
  })()`);
const selectedNow = () => inEditor("[...document.querySelectorAll('[data-selected-control]')].map((e) => e.dataset.selectedControl).sort()");
const switchOn = (id, on) => inEditor(`(() => { const i = document.getElementById('${id}'); if (i.checked !== ${on}) i.click(); return i.checked; })()`);
const arrow = (k) => inEditor(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: '${k}', key: '${k}' })); return true; })()`);

await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(inMode);
r.guidesBar = await inEditor("(() => { const b = document.querySelector('[data-guides-bar]'); return b ? [document.getElementById('layout-grid').checked, document.getElementById('layout-snap').checked, b.querySelector('.dropdown-trigger')?.textContent.replace('▾', '').trim()] : null; })()");
r.noGridLines = !(await exists('[data-layout-grid]'));
// The marquee: from empty canvas at the top-left over the first row's first two keys.
r.marqueeDrawn = await marqueeOver([3, 3], [470, 120]);
r.marqueeSelected = await selectedNow();
// Ctrl-click adds k9 and takes k2 out.
await pressOn('k9', { ctrl: true });
await pressOn('k2', { ctrl: true });
r.ctrlSelected = await selectedNow();
r.severalTitle = await text('[data-layout-inspector=several] .inspector-title');
await key('Escape', { key: 'Escape' });
r.escapeNone = (await selectedNow()).length === 0;

// Snap: k1 dragged right by 236 lands with its left edge on 255 (k2's), the guide naming what it met.
const k1at = await controlOf('Main', 'k1');
r.snapGuides = await dragSeen('k1', 236, 0);
r.snapped = await until(async () => (await controlOf('Main', 'k1'))?.x === 255);
r.snappedAt = await controlOf('Main', 'k1');
// Shift: free to the pixel — the same drag back by 236 from 255 lands on 19, no guide.
r.shiftGuides = await dragSeen('k1', -236, 0, { shift: true });
r.shifted = await until(async () => (await controlOf('Main', 'k1'))?.x === 19);
// Snap off, the grid on at 40: a drag lands the left and top edges on its lines; the lines drawn.
await switchOn('layout-snap', false);
await switchOn('layout-grid', true);
r.gridLines = await until(async () => (await inEditor("document.querySelector('[data-layout-grid]')?.dataset.layoutGrid ?? null")) === '40');
await dragSeen('k1', 103, 61);
r.onGrid = await until(async () => {
  const c = await controlOf('Main', 'k1');
  return c?.x === 120 && c?.y === 80;
});
r.onGridAt = await controlOf('Main', 'k1');
// The pitch from the shared dropdown, remembered in the editor's preferences.
await click('[data-guides-bar] .dropdown-trigger');
await until(() => exists('[data-dropdown-menu]'));
await inEditor(`(() => { [...document.querySelectorAll('[data-dropdown-menu] [role=option]')].find((o) => o.textContent.trim() === '60 px').click(); return true; })()`);
r.pitch60 = await until(async () => (await inEditor("document.querySelector('[data-layout-grid]')?.dataset.layoutGrid ?? null")) === '60');
r.pitchKept = await inEditor('window.deckhand.layoutGuides()');
// Nudging: one grid step with the grid on, 1 px with it off.
await pressOn('k1');
await arrow('ArrowRight');
r.nudgedGrid = await until(async () => (await controlOf('Main', 'k1'))?.x === 180);
await switchOn('layout-grid', false);
await arrow('ArrowDown');
r.nudgedPixel = await until(async () => (await controlOf('Main', 'k1'))?.y === 81);
await switchOn('layout-snap', true);

// Several: k2, k3, k4 (the first row), moved together, aligned, distributed, matched — k3 first set apart, smaller.
await pressOn('k3');
await typeAndLeave('[data-layout-field=W]', '150');
await typeAndLeave('[data-layout-field=H]', '150');
await typeAndLeave('[data-layout-field=X]', '540');
await typeAndLeave('[data-layout-field=Y]', '60');
await until(async () => (await controlOf('Main', 'k3'))?.y === 60);
await pressOn('k2');
await pressOn('k3', { ctrl: true });
await pressOn('k4', { ctrl: true });
const row = async () => Promise.all(['k2', 'k3', 'k4'].map((id) => controlOf('Main', id)));
const rowBefore = await row();
await dragSeen('k3', 0, 333, { shift: true });
r.movedTogether = await until(async () => (await row()).every((c, i) => c.y === rowBefore[i].y + 333 && c.x === rowBefore[i].x));
const shiftedRow = await row();
await typeAndLeave('[data-layout-field=Y]', '100');
// The bounds' top (the highest of the three) to 100: every one moved by the same amount.
const top = Math.min(...shiftedRow.map((c) => c.y));
r.typedGroupY = await until(async () => (await row()).every((c, i) => c.y === shiftedRow[i].y - (top - 100)));
await inEditor(`(() => { document.querySelector('[data-align=top]').click(); return true; })()`);
r.alignedTop = await until(async () => (await row()).every((c) => c.y === 100));
await inEditor(`(() => { document.querySelector('[data-align=bottom]').click(); return true; })()`);
r.alignedBottom = await until(async () => new Set((await row()).map((c) => c.y + c.h)).size === 1);
await inEditor(`(() => { document.querySelector('[data-distribute=across]').click(); return true; })()`);
r.distributed = await (async () => {
  await sleep(400);
  const [a, b, c] = await row();
  return [b.x - (a.x + a.w), c.x - (b.x + b.w)];
})();
await inEditor(`(() => { document.querySelector('[data-match=w]').click(); return true; })()`);
await until(async () => (await controlOf('Main', 'k3'))?.w === 211);
r.matched = await row();
// Duplicate with several: a copy of each, one grid step on, the copies selected.
const nBefore = (await controlsOf('Main')).length;
await key('KeyD', { ctrl: true, key: 'd' });
r.duplicatedSeveral = await until(async () => (await controlsOf('Main')).length === nBefore + 3);
r.copiesSelected = (await selectedNow()).length;
// Delete with several, one of them keyed (k2, "Two" — its copy): asks once, naming it.
await pressOn('k1');
await pressOn('k2', { ctrl: true });
await pressOn('k5', { ctrl: true });
await key('Delete');
r.deleteSeveralAsked = await until(() => exists('[data-delete-control]'));
r.deleteSeveralText = await text('[data-delete-control]');
await inEditor(`(() => { [...document.querySelectorAll('[data-delete-control] button')].find((b) => b.textContent === 'Cancel').click(); return true; })()`);
await shot('10-several');
// Back as it was: Discard changes.
await click('[data-discard-changes]');
await until(() => exists('[data-discard-confirm]'));
await click('[data-discard-confirm]');
r.precisionDiscarded = await until(async () => JSON.stringify(await page('Main')) === JSON.stringify(r.entryPage));
void k1at;

// ---- TEMPLATES (round 2b) ----
const templatesOnDisk = async () => (await onDisk()).templates ?? [];
const openNewPage = async () => {
  await click('.tab-add');
  await until(() => exists('.add-menu-wrap .tab-menu-item'));
  await click('.add-menu-wrap .tab-menu-item');
  await until(() => exists('[data-add-page=virtual] [data-vd-size=blank] input'));
  await sleep(200);
};
const saveTemplate = async (name) => {
  await click('[data-save-template]');
  await until(() => exists('[data-template-name]'));
  await typeInto('[data-template-name]', name);
  await click('[data-template-save]');
};
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(inMode);
// Moved first, so Discard changes has something to put back — and must leave the template alone.
await drag('.layout-canvas [data-key="k8"]', -40, 0);
await until(async () => (await controlOf('Main', 'k8'))?.x === r.entryPage.panel.controls[7].x - 40);
await saveTemplate('Mixer');
r.templateSaved = await until(async () => (await templatesOnDisk()).length === 1);
r.templateOnDisk = (await templatesOnDisk())[0];
r.savedSays = await until(async () => (await text('[data-save-template]')) === 'Saved');
r.stillInMode = await inMode();
// The same name, any case: it offers to replace, and replacing keeps one template.
await saveTemplate('MIXER');
r.clash = await until(() => exists('[data-template-clash]'));
r.clashText = await text('[data-template-clash]');
r.replaceLabel = await text('[data-template-save]');
await click('[data-template-save]');
r.replaced = await until(async () => {
  const t = await templatesOnDisk();
  return t.length === 1 && t[0].name === 'MIXER';
});
await click('[data-discard-changes]');
await until(() => exists('[data-discard-confirm]'));
await click('[data-discard-confirm]');
await until(async () => !(await inMode()));
r.templateAfterDiscard = (await templatesOnDisk()).map((t) => t.name);
// New page: the template listed after Blank, with its number of controls; a page made from it is custom, every control empty.
await openNewPage();
r.pickerRow = await inEditor(`(() => { const row = document.querySelector('[data-template="MIXER"]'); return row ? [row.textContent, !!row.querySelector('.template-preview'), [...document.querySelectorAll('[data-add-page] [data-vd-size], [data-add-page] [data-template]')].map((e) => e.dataset.vdSize ?? 'template:' + e.dataset.template)] : null; })()`);
await click('[data-template="MIXER"] input[type=radio]');
await typeInto('[data-add-page] input[aria-label="New page name"]', 'From mix');
await sleep(100);
r.useLabel = await text('[data-add-page-submit]');
await click('[data-add-page-submit]');
r.fromTemplate = await until(async () => (await page('From mix')).panel?.preset === 'free');
r.fromTemplatePage = await page('From mix');
r.fromTemplateNotMode = !(await inMode());
// The last choice remembered: the next New page has the template chosen.
await openNewPage();
r.lastTemplate = await inEditor("document.querySelector('[data-template] input:checked')?.closest('[data-template]').dataset.template ?? null");
// Rename from its … menu, in place.
await click('[data-template="MIXER"] [data-template-more]');
await until(() => exists('.vd-template-menu'));
await inEditor(`(() => { [...document.querySelectorAll('.vd-template-menu .tab-menu-item')].find((b) => b.textContent === 'Rename').click(); return true; })()`);
await until(() => exists('[data-template-rename]'));
await typeInto('[data-template-rename]', 'Desk');
await inEditor(`(() => { document.querySelector('[data-template-rename]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
r.renamed = await until(async () => (await templatesOnDisk())[0]?.name === 'Desk');
// A template saved on a wider screen: listed as made for it; a page from it keeps its own canvas.
await inEditor(`window.deckhand.apply({ kind: 'saveTemplate', name: 'Wide', replace: false, panel: { size: { width: 2560, height: 720 }, preset: 'free', controls: [{ id: 'c1', x: 100, y: 100, w: 400, h: 400, shape: 'round' }, { id: 'c2', x: 2060, y: 100, w: 400, h: 400 }] } })`);
await until(() => exists('[data-template="Wide"]'));
r.wideSub = await text('[data-template="Wide"] .vd-template-choice .muted');
r.newestFirst = await inEditor("[...document.querySelectorAll('[data-add-page] [data-template]')].map((e) => e.dataset.template)");
// Delete…: asks once; the page made from it is not changed.
const fromMixBefore = JSON.stringify(await page('From mix'));
await click('[data-template="Desk"] [data-template-more]');
await until(() => exists('.vd-template-menu'));
await inEditor(`(() => { [...document.querySelectorAll('.vd-template-menu .tab-menu-item')].find((b) => b.textContent.startsWith('Delete')).click(); return true; })()`);
r.deleteAsks = await until(() => exists('[data-template-delete]'));
r.deleteAskText = await text('[data-template-delete]');
await click('[data-template-delete-confirm]');
r.deletedTemplate = await until(async () => (await templatesOnDisk()).every((t) => t.name !== 'Desk'));
r.pageUnchanged = JSON.stringify(await page('From mix')) === fromMixBefore;
await click('[data-template="Wide"] input[type=radio]');
await typeInto('[data-add-page] input[aria-label="New page name"]', 'Wide one');
await sleep(100);
await click('[data-add-page-submit]');
r.widePage = await until(async () => (await page('Wide one')).panel?.size?.width === 2560);
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Wide one');
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await until(inMode);
r.madeFor = await until(() => exists('[data-made-for="2560x720"]'));
r.madeForText = await text('[data-made-for]');
r.layoutScreen = await inEditor(`(() => { const s = document.querySelector('[data-layout-screen]'); const c = document.querySelector('.layout-canvas'); if (!s || !c) return null; const a = s.getBoundingClientRect(); const b = c.getBoundingClientRect(); return { screen: s.dataset.layoutScreen, ratio: Math.round((a.width / a.height) * 100) / 100, centred: Math.abs((b.left - a.left) - (a.right - b.right)) < 2 && Math.abs((b.top - a.top) - (a.bottom - b.bottom)) < 2, dashed: getComputedStyle(c).outlineStyle }; })()`);
await shot('11-made-for');
await click('[data-done]');
await until(async () => !(await inMode()));
r.noChipOutside = !(await exists('[data-made-for]'));
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Main').click(); return true; })()`);
await until(async () => (await count('.well [data-key]')) === 24);

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
r.saveDimmedEmpty = await inEditor("document.querySelector('[data-save-template]')?.disabled ?? null");
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

// ---- A PROFILE CHANGE ACTS AS DONE ---- on Pads, custom since its first control.
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Pads');
const padsBefore = await page('Pads');
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
r.padsMode = await until(inMode);
await daemon.profiles.switchTo('second', daemon.sessions);
r.profileLeft = await until(async () => !(await inMode()), 5000);
r.padsAfter = JSON.stringify(await page('Pads')) === JSON.stringify(padsBefore);

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

// ---- CHANGE LAYOUT… FROM ONE GRID TO ANOTHER ----
await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Big', 5000);
await click(`[data-deck-panel="${KEY}"] .deck-panel-change-layout`);
await until(() => exists('[data-change-layout] [data-vd-size=small] input'));
r.gridPreselected = await inEditor("document.querySelector('[data-change-layout] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
await click('[data-change-layout] [data-vd-size=small] input');
await click('[data-change-layout-apply]');
r.bigSmall = await until(async () => (await page('Big')).panel?.preset === 'small');
r.bigSmallKeys = (await page('Big')).buttons;

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

// ---- KEYS ONTO A CUSTOM PAGE: only onto a control that exists (Ryan, 2026-11-20) ----
// A custom page written to disk (the editor reloads it, having nothing unsaved): a round control
// first, so its box's corner is a point inside the deck with no control under it; c4 smaller, on
// c2 at the same x and y — the same row and column, so only the control itself tells them apart.
await sleep(1000);
{
  const c = await onDisk();
  c.profiles.default.layouts[KEY].pages.shapes = {
    name: 'Shapes',
    panel: { size: { width: 1920, height: 720 }, preset: 'free', controls: [{ id: 'c1', x: 100, y: 100, w: 300, h: 300, shape: 'round' }, { id: 'c2', x: 500, y: 100, w: 300, h: 300 }, { id: 'c3', x: 900, y: 100, w: 300, h: 300 }, { id: 'c4', x: 500, y: 100, w: 150, h: 150 }] },
    buttons: { c1: { label: 'Src', action: { type: 'noop' } } },
  };
  await fs.writeFile(configFile, JSON.stringify(c, null, 2) + '\n');
}
const shapes = async () => (await pageOnDisk('Shapes')) ?? {};
await until(async () => (await inEditor(`[...document.querySelectorAll('.tabs [data-tab]')].some((t) => t.dataset.tab === 'Shapes')`)) === true, 8000);
// The daemon must have the page before the tab asks the deck to show it, or the deck stays on Narrow — also four keys — and the editor follows it back there.
await until(() => daemon.state.config?.profiles.default.layouts[KEY].pages.shapes !== undefined, 8000);
await inEditor(`(() => { [...document.querySelectorAll('.tabs [data-tab]')].find((t) => t.dataset.tab === 'Shapes').click(); return true; })()`);
await until(async () => daemon.sessions.get(KEY)?.currentPage() === 'shapes' && (await exists(`.grid[data-deck="${KEY}"] [data-key="c4"]`)), 8000);
const bulkMessage = () => text('.bulk-message');
const clickKey = (deck, id) => inEditor(`(() => { document.querySelector('.grid[data-deck="${deck}"] [data-key="${id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
// Paste: onto the selected control.
await clickKey(KEY, 'c1');
await key('KeyC', { key: 'c', ctrl: true });
await clickKey(KEY, 'c3');
await key('KeyV', { key: 'v', ctrl: true });
r.pastedOnControl = await until(async () => (await shapes()).buttons?.c3?.label === 'Src');
r.pastedOnlyThere = JSON.stringify(Object.keys((await shapes()).buttons).sort());
// Nothing selected: nothing lands, and it says why.
await key('Escape');
await until(async () => (await count('.key-selected')) === 0);
const beforeEmptyPaste = JSON.stringify((await shapes()).buttons);
await key('KeyV', { key: 'v', ctrl: true });
await sleep(500);
r.noSelectionPaste = [JSON.stringify((await shapes()).buttons) === beforeEmptyPaste, await bulkMessage()];
// Both decks shown, for Copy to device and a drag from the Stream Deck.
await click('.show-in-editor-trigger');
await until(() => exists(`[data-show-deck="${XL}"]`));
await inEditor(`(() => { const row = document.querySelector('[data-show-deck="${XL}"]'); const box = row.querySelector('input[type=checkbox]'); if (box && !box.checked) box.click(); return true; })()`);
await click('.show-in-editor-trigger');
await until(async () => (await count('.grid[data-deck]')) === 2, 5000);
// Copy to device onto a custom page: refused, with a short message.
await clickKey(XL, '0');
await inEditor(`(() => { const k = document.querySelector('.grid[data-deck="${XL}"] [data-key="0"]'); const b = k.getBoundingClientRect(); k.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 })); return true; })()`);
await until(() => exists('.key-menu'));
await inEditor(`(() => { [...document.querySelectorAll('.key-menu-item')].find((b) => b.textContent.startsWith('Copy to device')).click(); return true; })()`);
await sleep(200);
const beforeCopyTo = JSON.stringify((await shapes()).buttons);
r.copyToOffered = await inEditor(`(() => { const item = [...document.querySelectorAll('.key-menu-item')].find((b) => b.textContent.trim() === 'Shapes'); if (!item) return false; item.click(); return true; })()`);
await sleep(500);
r.copyToRefused = [JSON.stringify((await shapes()).buttons) === beforeCopyTo, await bulkMessage()];
// And from a custom page onto a grid: refused as well (either side, Ryan, 2026-11-20).
const xlBefore = JSON.stringify((await onDisk()).profiles.default.layouts[XL]);
await clickKey(KEY, 'c1');
await inEditor(`(() => { const k = document.querySelector('.grid[data-deck="${KEY}"] [data-key="c1"]'); const b = k.getBoundingClientRect(); k.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 })); return true; })()`);
await until(() => exists('.key-menu'));
await inEditor(`(() => { [...document.querySelectorAll('.key-menu-item')].find((b) => b.textContent.startsWith('Copy to device')).click(); return true; })()`);
await sleep(200);
r.copyFromOffered = await inEditor(`(() => { const item = [...document.querySelectorAll('.key-menu-item')].find((b) => b.textContent.trim() === 'Main'); if (!item) return false; item.click(); return true; })()`);
await sleep(500);
r.copyFromRefused = [JSON.stringify((await onDisk()).profiles.default.layouts[XL]) === xlBefore, await bulkMessage()];
// A drag from the Stream Deck: onto c2, it lands there; onto the round control's empty corner, nothing.
const dragKey = (fromDeck, fromId, target) =>
  inEditor(`(() => {
    const from = document.querySelector('.grid[data-deck="${fromDeck}"] [data-key="${fromId}"]');
    const f = from.getBoundingClientRect();
    const t = (${target})();
    const at = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y });
    from.dispatchEvent(new PointerEvent('pointerdown', at(f.x + f.width / 2, f.y + f.height / 2)));
    window.dispatchEvent(new PointerEvent('pointermove', at(t.x, t.y)));
    window.dispatchEvent(new PointerEvent('pointermove', at(t.x + 1, t.y + 1)));
    window.dispatchEvent(new PointerEvent('pointerup', at(t.x + 1, t.y + 1)));
    return [t.x, t.y];
  })()`);
await dragKey(XL, '0', `() => { const b = document.querySelector('.grid[data-deck="${KEY}"] [data-key="c4"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }`);
r.draggedOnControl = await until(async () => (await shapes()).buttons?.c4?.label === 'XL');
r.notTheOneUnder = (await shapes()).buttons?.c2 ?? null;
const beforeCornerDrop = JSON.stringify((await shapes()).buttons);
r.cornerTarget = await dragKey(XL, '0', `() => { const b = document.querySelector('.grid[data-deck="${KEY}"] [data-key="c1"]').getBoundingClientRect(); return { x: b.x + 2, y: b.y + 2 }; }`);
r.cornerUnder = await inEditor(`(() => { const [x, y] = ${JSON.stringify(r.cornerTarget)}; return document.elementFromPoint(x + 1, y + 1)?.closest('[data-key]')?.dataset.key ?? null; })()`);
await sleep(500);
r.cornerNothing = JSON.stringify((await shapes()).buttons) === beforeCornerDrop;

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
check('the header: columns × rows on a grid page, the screen\'s resolution on a custom page', () => {
  assert.equal(r.sizePreset, '5 × 2');
  assert.equal(r.sizeCustomPage, '1920 × 720');
  assert.equal(r.sizeCustom, '1920 × 720');
});
check('a page\'s kind is fixed: Edit layout only on a custom page, Change layout… only on a grid page, offering only the fixed grids', () => {
  assert.equal(r.editOnCustom, true);
  assert.equal(r.noChangeOnCustom, true);
  assert.deepEqual(r.tabMenuCustom, ['Delete page…']);
  assert.equal(r.noEditOnGrid, true);
  assert.deepEqual(r.tabMenuGrid, ['Change layout…', 'Delete page…']);
  assert.deepEqual(r.changeChoices, ['small', 'medium', 'large', 'custom']);
  assert.equal(r.changeNoTemplates, true);
  assert.equal(r.inMode, true);
});
check('Done is seen: on the deck\'s header beside the lit Edit layout and Discard changes, on screen at the normal window size, not covered, in the accent colour', () => {
  assert.ok(r.done, 'no Done');
  assert.deepEqual(r.done.window, [1400, 900], 'the window is not its normal size');
  assert.ok(r.done.size[0] >= 40 && r.done.size[1] >= 20, JSON.stringify(r.done));
  assert.equal(r.done.onScreen, true, JSON.stringify(r.done));
  assert.equal(r.done.notCovered, true, JSON.stringify(r.done));
  assert.equal(r.done.inDeckHeader, true, JSON.stringify(r.done));
  assert.equal(r.done.besideLit, true, JSON.stringify(r.done));
  assert.ok(r.done.aboveDeck >= 0 && r.done.aboveDeck < 48, `${r.done.aboveDeck} px above the deck`);
  assert.equal(r.done.accent, true, JSON.stringify(r.done));
  assert.equal(r.done.notInModeBar, true);
});
check('the mode: the button lit, the mode bar for crumbs and tabs, the palette for the library, the Page ▾ dimmed', () => {
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
  assert.deepEqual(r.afterEmptyDone, r.entryPage);
});
check('the grid and snapping: separate switches at the canvas\'s foot, the grid off and Snap on to start, 40 px', () => {
  assert.deepEqual(r.guidesBar, [false, true, '40 px']);
  assert.equal(r.noGridLines, true);
});
check('snap: a drag lands on another control\'s edge within reach, with a dashed guide naming it; Shift ignores it', () => {
  assert.equal(r.snapped, true, JSON.stringify(r.snappedAt));
  // k1 and k2 are the same width, so its left edge and its centre meet Key 2's at once: either names it.
  assert.ok(r.snapGuides.some((g) => /^(left edge|centre) of Key (2|10)$/.test(g)), JSON.stringify(r.snapGuides));
  assert.equal(r.shifted, true);
  assert.deepEqual(r.shiftGuides, []);
});
check('the grid: lines drawn at its pitch, a drag lands on them, the pitch chosen from the dropdown and remembered', () => {
  assert.equal(r.gridLines, true);
  assert.equal(r.onGrid, true, JSON.stringify(r.onGridAt));
  assert.equal(r.pitch60, true);
  assert.deepEqual(r.pitchKept, { grid: true, pitch: 60, snap: false });
});
check('the arrow keys nudge one grid step with the grid on, 1 px with it off', () => {
  assert.equal(r.nudgedGrid, true);
  assert.equal(r.nudgedPixel, true);
});
check('several: a marquee takes what it touches, Ctrl-click adds and removes, Escape none; the inspector says how many', () => {
  assert.equal(r.marqueeDrawn, true, JSON.stringify([r.marqueeDrawn, r.marqueeSelected, r.ctrlSelected, r.severalTitle, r.escapeNone]));
  assert.deepEqual(r.marqueeSelected, ['k1', 'k2']);
  assert.deepEqual(r.ctrlSelected, ['k1', 'k9']);
  assert.equal(r.severalTitle, '3 controls'.replace('3', '2'));
  assert.equal(r.escapeNone, true);
});
check('several move together, take a typed Y together, align, distribute with equal gaps, and match the first one\'s width', () => {
  assert.equal(r.movedTogether, true, JSON.stringify([r.movedTogether, r.typedGroupY, r.alignedTop, r.alignedBottom, r.distributed, r.matched]));
  assert.equal(r.typedGroupY, true, JSON.stringify([r.typedGroupY, r.alignedTop, r.alignedBottom, r.distributed, r.matched]));
  assert.equal(r.alignedTop, true);
  assert.equal(r.alignedBottom, true);
  // k3 (150 wide, at 540) between k2 (255–466) and k4 (735–946): gaps of 74 and 45 become two of 59.5, in whole pixels.
  assert.deepEqual([...r.distributed].sort(), [59, 60]);
  assert.deepEqual(r.matched.map((c) => c.w), [211, 211, 211]);
});
check('Duplicate and Delete with several: a copy of each, selected; one warning naming every key lost', () => {
  assert.equal(r.duplicatedSeveral, true);
  assert.equal(r.copiesSelected, 3);
  assert.equal(r.deleteSeveralAsked, true);
  assert.match(r.deleteSeveralText, /Delete 3 controls\?.*Their keys go with them:.*Mic.*Two/);
  assert.equal(r.precisionDiscarded, true);
});
check('Save as template: the layout only, saved under its name, the button saying so, the mode still open', () => {
  assert.equal(r.templateSaved, true);
  assert.equal(r.templateOnDisk.name, 'Mixer');
  assert.equal(r.templateOnDisk.panel.preset, 'free');
  assert.equal(r.templateOnDisk.panel.controls.length, 24);
  assert.ok(r.templateOnDisk.panel.controls.every((c) => Object.keys(c).every((k) => ['id', 'x', 'y', 'w', 'h', 'shape', 'radius', 'keepRatio'].includes(k))), JSON.stringify(r.templateOnDisk));
  assert.equal(r.templateOnDisk.buttons, undefined);
  assert.equal(r.savedSays, true);
  assert.equal(r.stillInMode, true);
  assert.equal(r.saveDimmedEmpty, true, 'Save as template is dimmed with no controls');
});
check('a name in use offers to replace that template; Discard changes does not undo a save', () => {
  assert.equal(r.clash, true);
  assert.match(r.clashText, /There is already a template called Mixer\./);
  assert.equal(r.replaceLabel, 'Replace it');
  assert.equal(r.replaced, true);
  assert.deepEqual(r.templateAfterDiscard, ['MIXER']);
});
check('New page lists templates after Blank, newest first, with a preview and their controls; one makes a custom page, every control empty, remembered as the last choice', () => {
  assert.ok(r.pickerRow, 'no template row');
  assert.match(r.pickerRow[0], /MIXER.*24 controls/);
  assert.equal(r.pickerRow[1], true);
  assert.deepEqual(r.pickerRow[2], ['small', 'medium', 'large', 'custom', 'blank', 'template:MIXER']);
  assert.equal(r.useLabel, 'Use MIXER');
  assert.equal(r.fromTemplate, true);
  assert.equal(r.fromTemplatePage.panel.controls.length, 24);
  assert.deepEqual(r.fromTemplatePage.buttons, {});
  assert.equal(r.fromTemplateNotMode, true);
  assert.equal(r.lastTemplate, 'MIXER');
  assert.deepEqual(r.newestFirst, ['Wide', 'Desk']);
});
check('rename in place and Delete… from the picker; the page made from it unchanged', () => {
  assert.equal(r.renamed, true);
  assert.equal(r.deleteAsks, true);
  assert.match(r.deleteAskText, /Delete Desk\? Pages made from it are not changed\./);
  assert.equal(r.deletedTemplate, true);
  assert.equal(r.pageUnchanged, true);
});
check('a template from another screen size: "Made for", its own canvas kept, the mode drawing the screen whole with the layout dashed and centred, and the chip', () => {
  assert.equal(r.wideSub, 'Made for 2560 × 720');
  assert.equal(r.widePage, true);
  assert.equal(r.madeFor, true);
  assert.match(r.madeForText, /Made for 2560 × 720\s*shown at 75%, centred/);
  assert.equal(r.layoutScreen?.screen, '1920x720', JSON.stringify(r.layoutScreen));
  assert.ok(Math.abs(r.layoutScreen.ratio - 1920 / 720) < 0.05, JSON.stringify(r.layoutScreen));
  assert.equal(r.layoutScreen.centred, true);
  assert.equal(r.layoutScreen.dashed, 'dashed');
  assert.equal(r.noChipOutside, true);
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
check('a profile change while the mode is open acts as Done, the page as it was', () => {
  assert.equal(r.padsMode, true);
  assert.equal(r.profileLeft, true);
  assert.equal(r.padsAfter, true);
});
check('a deck key changing the page while the mode is open acts as Done', () => {
  assert.equal(r.reentered, true);
  assert.equal(r.deckKeyLeft, true);
});
check('Change layout… from one fixed grid to another: its own grid preselected, keys kept by row and column', () => {
  assert.equal(r.gridPreselected, 'large');
  assert.equal(r.bigSmall, true);
  assert.deepEqual(r.bigSmallKeys, { k1: { label: 'Large one' } });
});
check('keys onto a custom page land only on a control: pasted onto the one selected, none selected none, Copy to device refused either way, a drag onto the control dropped on, and onto no control nothing', () => {
  assert.equal(r.pastedOnControl, true);
  assert.equal(r.pastedOnlyThere, '["c1","c3"]');
  assert.equal(r.noSelectionPaste[0], true);
  assert.match(r.noSelectionPaste[1] ?? '', /Nothing pasted: on a custom layout, select the controls to paste onto/);
  assert.equal(r.copyToOffered, true);
  assert.equal(r.copyToRefused[0], true);
  assert.match(r.copyToRefused[1] ?? '', /Not copied: “Shapes” has a custom layout\. Drag or paste keys one at a time instead/);
  assert.equal(r.copyFromOffered, true);
  assert.equal(r.copyFromRefused[0], true, 'copied from a custom page onto a grid');
  assert.match(r.copyFromRefused[1] ?? '', /Not copied: “Shapes” has a custom layout/);
  assert.equal(r.draggedOnControl, true);
  assert.equal(r.notTheOneUnder, null, 'the control under it, at the same row and column, untouched');
  assert.equal(r.cornerUnder, null, 'the round control\'s box corner is not the control');
  assert.equal(r.cornerNothing, true);
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
