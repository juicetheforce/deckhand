// Sliders and dials (scope §7, round 5), end to end in real Electron: the
// main window with a virtual deck connected through the real virtual driver
// and scripts/test/fake-panel.mjs as its display helper, beside a fake Stream
// Deck, with scripts/test/fake-pactl.mjs as pactl (no real device is touched).
// What is checked from outside the page: config.json on disk.
//
// - Edit layout's palette: Button, Slider, Dial. A slider added at about
//   14 × 60 mm, a dial at about 25 mm, a rectangle with no shape choice (its
//   Corners only); the layout inspector's Direction (turning the box) and
//   Touch for a slider; Save as template keeps them.
// - Normal use, a slider selected: its own inspector; the library dims every
//   action that sets no level, and a click on one writes nothing; Volume
//   clicked is written at once. A Hotkey dragged over the slider is refused
//   in the air, "Needs an action with a value", and dropping it changes
//   nothing; over a button it is the usual drop target.
// - Volume's Device: Default output, Default input, every output and every
//   input; Default input stored as `input` alone, an input chosen with its
//   node. Brightness on the dial: the deck targets, 5 to 100.
// - The grid draws each control at the deck's level (status `values`, from
//   the fake pactl's 40%).
// - The Icon tab: chips for Background, Track, Fill and Thumb; the fill
//   switched off and on, and its colour; a background image chosen and None
//   again; a track image chosen; a thumb image chosen, drawn in the grid
//   keeping its proportions; a 5000 px image refused with its reason and not
//   saved; the knob's angles.
// - A slider's key dragged onto a button is refused; onto the dial it moves.
// - One Clear empties a slider; the Stream Deck shows none of it.
//
// Usage: npm run check:values   (builds first)
// DECKHAND_VALUES_SHOT=<file.png> also saves the window once the slider shows its level, to look at.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, inPage, onPrivateBus, startEditor, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_VALUES_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-values-'));
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
await fs.mkdir(path.join(scratch, 'bin'));
await fs.writeFile(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_PICTURES_DIR="$HOME/Pictures"\n');
await fs.symlink(path.join(repoRoot, 'scripts/test/fake-pactl.mjs'), path.join(scratch, 'bin', 'pactl'));
await fs.writeFile(path.join(scratch, 'pactl.json'), '{}');

const { createRequire } = await import('node:module');
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');
await sharp({ create: { width: 60, height: 240, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toFile(path.join(pictures, 'cap.png'));
await sharp({ create: { width: 5000, height: 10, channels: 3, background: '#808080' } }).png().toFile(path.join(pictures, 'mural.png'));

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
  FAKE_PANEL_INPUT_DIR: socks,
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { createVirtualDriver } = await import(pathToFileURL(path.join(repoRoot, 'dist/drivers/virtual.js')).href);
const audio = await import(pathToFileURL(path.join(repoRoot, 'dist/services/audio.js')).href);
const { mmToPx } = await import(pathToFileURL(path.join(repoRoot, 'dist/panel-presets.js')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

const XL = 'VAL-CHECK-XL';
const KEY = 'GRA-6e4e';
const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const HEADSET_MIC = 'alsa_input.usb-Example_Headset-00.mono-fallback';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' }, [KEY]: { name: 'Touch', virtual: { output: 'DP-4' } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'XL' } } } } },
        [KEY]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              panel: { size: { width: 1920, height: 720 }, preset: 'free', controls: [{ id: 'b1', x: 1500, y: 300, w: 200, h: 200 }] },
              buttons: { b1: { label: 'Mic', action: { type: 'hotkey', keys: 'ctrl+m' } } },
            },
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
const daemon = await startDaemon(scratch, CONFIG, { virtual: virtualDriver, audioState: () => audio.cachedState() });
daemonRef = daemon;
const stopAudio = audio.subscribe(() => {
  for (const s of daemon.sessions.values()) s.invalidateByType(['audio.volume']);
  daemon.events.audio();
});
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
const pageOnDisk = async () => (await onDisk()).profiles.default.layouts[KEY].pages.main;
const controlOnDisk = async (id) => (await pageOnDisk()).panel.controls.find((c) => c.id === id) ?? null;
const keyOnDisk = async (id) => (await pageOnDisk()).buttons[id] ?? null;

const editor = startEditor(electronPath, editorRoot, env);
const inEditor = (expr) => inPage(editor, 'editor', expr);
const exists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const text = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const click = (selector) =>
  inEditor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const mustSee = async (what, fn, ms = 10000) => {
  if (!(await until(fn, ms))) throw new Error(`never saw ${what}`);
};
/** A press on the palette's entry and its release with no move: a click, which adds the control in the middle. */
const paletteClick = (kind) =>
  inEditor(`(() => { const e = document.querySelector('[data-palette=${kind}]'); const b = e.getBoundingClientRect(); const at = { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: b.left + 5, clientY: b.top + 5 }; e.dispatchEvent(new PointerEvent('pointerdown', at)); window.dispatchEvent(new PointerEvent('pointerup', at)); return true; })()`);
/** A library row pressed, moved over a key and let go: a drag, as a hand does it. Returns what the grid drew while over it. */
const dragAction = (type, key) =>
  inEditor(`(async () => {
    const row = document.querySelector('.library [data-action-type="${type}"]');
    const target = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${key}"]');
    const r = row.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const at = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y });
    row.dispatchEvent(new PointerEvent('pointerdown', at(r.left + 10, r.top + 10)));
    window.dispatchEvent(new PointerEvent('pointermove', at(r.left + 40, r.top + 40)));
    window.dispatchEvent(new PointerEvent('pointermove', at(t.left + t.width / 2, t.top + t.height / 2)));
    await new Promise((res) => setTimeout(res, 300));
    const el = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${key}"]');
    const seen = { refused: el.classList.contains('key-drop-refused'), target: el.classList.contains('key-drop-target'), line: el.querySelector('[data-drop-refused]')?.textContent ?? null };
    window.dispatchEvent(new PointerEvent('pointerup', at(t.left + t.width / 2, t.top + t.height / 2)));
    return seen;
  })()`);
/** A key of the grid pressed and dragged onto another: as useKeyDrag sees it. */
const dragKey = (from, to) =>
  inEditor(`(async () => {
    const a = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${from}"]');
    const b = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${to}"]');
    const r = a.getBoundingClientRect();
    const t = b.getBoundingClientRect();
    const at = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: x, clientY: y });
    a.dispatchEvent(new PointerEvent('pointerdown', at(r.left + r.width / 2, r.top + r.height / 2)));
    window.dispatchEvent(new PointerEvent('pointermove', at(r.left + r.width / 2 + 20, r.top + r.height / 2 + 20)));
    window.dispatchEvent(new PointerEvent('pointermove', at(t.left + t.width / 2, t.top + t.height / 2)));
    await new Promise((res) => setTimeout(res, 300));
    const el = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${to}"]');
    const seen = { refused: el.classList.contains('key-drop-refused'), line: el.querySelector('[data-drop-refused]')?.textContent ?? null };
    window.dispatchEvent(new PointerEvent('pointerup', at(t.left + t.width / 2, t.top + t.height / 2)));
    return seen;
  })()`);
const selectKey = (key) => click(`.grid[data-deck="${KEY}"] [data-key="${key}"]`);

const r = {};
let stopping = false;
const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  const gone = new Promise((resolve) => (editor.child.exitCode !== null ? resolve() : editor.child.once('exit', resolve)));
  editor.child.kill();
  await Promise.race([gone, sleep(5000)]);
  stopAudio();
  stopWatching?.();
  await daemon.stop().catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  process.exit(code);
};
process.on('uncaughtException', (err) => {
  console.log(`FAIL  the run stopped: ${err.message}\n      recorded so far: ${JSON.stringify(r)}`);
  void stop(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`FAIL  the run stopped: ${err?.message ?? err}\n      recorded so far: ${JSON.stringify(r)}`);
  void stop(1);
});

await until(async () => (await inEditor("document.querySelector('.toolbar .pill-connected') !== null")) === true, 15000);
await mustSee('Show in editor', () => exists('.show-in-editor-trigger'), 15000);
await click('.show-in-editor-trigger');
await mustSee('the virtual deck in Show in editor', () => exists(`[data-show-deck="${KEY}"] .show-in-editor-name`));
await click(`[data-show-deck="${KEY}"] .show-in-editor-name`);
await mustSee('the virtual deck alone', () => exists(`[data-deck-panel="${KEY}"] .deck-panel-header`));
await mustSee('the custom page', () => exists(`[data-deck-panel="${KEY}"] [data-edit-layout]`));

// ---- EDIT LAYOUT: THE PALETTE ----
await click(`[data-deck-panel="${KEY}"] [data-edit-layout]`);
await mustSee('the palette', () => exists('[data-controls-palette]'));
r.palette = await inEditor(`[...document.querySelectorAll('[data-controls-palette] [data-palette]')].map((p) => p.dataset.palette + ':' + p.textContent.trim())`);
check('the palette: Button, Slider and Dial', JSON.stringify(r.palette) === JSON.stringify(['button:Button', 'slider:Slider', 'dial:Dial']), JSON.stringify(r.palette));
await paletteClick('slider');
await mustSee('a slider on disk', async () => (await pageOnDisk()).panel.controls.some((c) => c.kind === 'slider'));
const slider = (await pageOnDisk()).panel.controls.find((c) => c.kind === 'slider');
const mm = (v) => mmToPx(SCREEN, v);
check('a slider is added at about 14 × 60 mm, upright', Math.abs(slider.w - mm(14)) <= 1 && Math.abs(slider.h - mm(60)) <= 1, JSON.stringify(slider));
r.sliderInspector = { title: await text('[data-layout-inspector] .inspector-title'), slider: await exists('[data-inspector-section=slider]') };
check('the layout inspector names it a Slider, with Direction and Touch', r.sliderInspector.title === 'Slider' && r.sliderInspector.slider, JSON.stringify(r.sliderInspector));
await inEditor(`(() => { [...document.querySelectorAll('[data-inspector-section=slider] button')].find((b) => b.textContent === 'Horizontal').click(); return true; })()`);
await mustSee('the slider turned', async () => (await controlOnDisk(slider.id))?.direction === 'horizontal');
const turned = await controlOnDisk(slider.id);
check('Horizontal turns the box about its centre: wide now', turned.w === slider.h && turned.h === slider.w && Math.abs(turned.x + turned.w / 2 - (slider.x + slider.w / 2)) <= 1, JSON.stringify(turned));
await inEditor(`(() => { [...document.querySelectorAll('[data-inspector-section=slider] button')].find((b) => b.textContent === 'Vertical').click(); return true; })()`);
await mustSee('the slider upright again', async () => (await controlOnDisk(slider.id))?.direction === undefined);
await inEditor(`(() => { [...document.querySelectorAll('[data-inspector-section=slider] button')].find((b) => b.textContent === 'Jump to touch').click(); return true; })()`);
await mustSee('Jump to touch saved', async () => (await controlOnDisk(slider.id))?.touch === 'jump');
check('Touch: Jump to touch is the control\'s own', (await controlOnDisk(slider.id))?.touch === 'jump');
await paletteClick('dial');
await mustSee('a dial on disk', async () => (await pageOnDisk()).panel.controls.some((c) => c.kind === 'dial'));
const dial = (await pageOnDisk()).panel.controls.find((c) => c.kind === 'dial');
check('a dial is added at about 25 mm, a square rectangle', Math.abs(dial.w - mm(25)) <= 1 && dial.w === dial.h && dial.shape === undefined && dial.keepRatio === true, JSON.stringify(dial));
r.dialShape = await inEditor(`({ shape: !!document.querySelector('[data-layout-inspector] [aria-label=Shape]') || [...document.querySelectorAll('[data-layout-inspector] button')].some((b) => b.textContent === 'Round' || b.textContent === 'Hexagon'), corners: !!document.querySelector('[data-layout-inspector] [aria-label=Corners]') })`);
check('…and offers no shape, only its corners', !r.dialShape.shape && r.dialShape.corners, JSON.stringify(r.dialShape));
// Move the dial off the slider, so each is its own target.
await inEditor(`(() => { const i = document.querySelector('[data-layout-field=X]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '300'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
await mustSee('the dial moved', async () => (await controlOnDisk(dial.id))?.x === 300);
// Save as template keeps the slider and the dial.
if (await exists('[data-save-template]')) {
  await click('[data-save-template]');
  await mustSee('the template name field', () => exists('[data-template-name]'));
  await inEditor(`(() => { const i = document.querySelector('[data-template-name]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Mixer'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await click('[data-template-save]');
  await mustSee('the template on disk', async () => ((await onDisk()).templates ?? []).some((t) => t.name === 'Mixer'));
  const t = (await onDisk()).templates.find((x) => x.name === 'Mixer');
  check('Save as template keeps a slider with its touch, and a dial', t.panel.controls.some((c) => c.kind === 'slider' && c.touch === 'jump') && t.panel.controls.some((c) => c.kind === 'dial'), JSON.stringify(t.panel.controls));
} else {
  check('Save as template is offered in the mode', false, 'no [data-save-template]');
}
await click('[data-done]');
await mustSee('the mode left', async () => !(await exists('[data-controls-palette]')));

// ---- NORMAL USE: A SLIDER SELECTED ----
await mustSee('the slider in the grid', () => exists(`.grid[data-deck="${KEY}"] [data-key="${slider.id}"][data-control-kind=slider]`));
await selectKey(slider.id);
await mustSee('the slider\'s inspector', () => exists('[data-value-inspector=slider]'));
r.dimmed = await inEditor(`({ hotkey: document.querySelector('.library [data-action-type="hotkey"]')?.dataset.dimmed === 'true', volume: document.querySelector('.library [data-action-type="audio.volume"]')?.dataset.dimmed === 'true', brightness: document.querySelector('.library [data-action-type="brightness"]')?.dataset.dimmed === 'true', title: document.querySelector('.library [data-action-type="hotkey"]')?.title })`);
check('the library dims an action that sets no level, and not Volume or Brightness', r.dimmed.hotkey && !r.dimmed.volume && !r.dimmed.brightness && /Needs an action with a value/.test(r.dimmed.title), JSON.stringify(r.dimmed));
await click('.library [data-action-type="hotkey"]');
await sleep(400);
check('a click on a dimmed action writes nothing', (await keyOnDisk(slider.id)) === null, JSON.stringify(await keyOnDisk(slider.id)));
// A drag starts from a row that is not dimmed: with a button selected, as on board 26e.
await selectKey('b1');
await mustSee('the button\'s inspector', async () => !(await exists('[data-value-inspector]')));
r.dragRefused = await dragAction('hotkey', slider.id);
await sleep(400);
check('a Hotkey dragged over the slider is refused in the air: soft red outline and the line', r.dragRefused.refused && !r.dragRefused.target && r.dragRefused.line === 'Needs an action with a value', JSON.stringify(r.dragRefused));
check('…and letting go drops nothing', (await keyOnDisk(slider.id)) === null, JSON.stringify(await keyOnDisk(slider.id)));
r.dragButton = await dragAction('hotkey', 'b1');
check('…over a button the same drag is the usual drop target', r.dragButton.target && !r.dragButton.refused, JSON.stringify(r.dragButton));
await selectKey(slider.id);
await mustSee('the slider\'s inspector again', () => exists('[data-value-inspector=slider]'));
await click('.library [data-action-type="audio.volume"]');
await mustSee('Volume on the slider', async () => (await keyOnDisk(slider.id))?.action?.type === 'audio.volume');
check('Volume clicked with the slider selected is written at once', (await keyOnDisk(slider.id))?.action?.type === 'audio.volume');
await mustSee('the Device dropdown', () => exists('[data-value-form="audio.volume"] [data-dropdown]'));
await click('[data-value-form="audio.volume"] [data-dropdown]');
await mustSee('the device list', () => exists('[role=listbox] [role=option]'));
r.devices = await inEditor(`[...document.querySelectorAll('[role=listbox] [role=option]')].map((o) => o.textContent)`);
check('Device: Default output and Default input first, then outputs and inputs', /^Default output/.test(r.devices[0] ?? '') && /^Default input/.test(r.devices[1] ?? '') && r.devices.some((d) => /Headset Mono Mic/.test(d) && /input/.test(d)) && r.devices.some((d) => /Example Headset Analog Stereo/.test(d) && /output/.test(d)), JSON.stringify(r.devices));
await inEditor(`(() => { [...document.querySelectorAll('[role=listbox] [role=option]')].find((o) => /^Default input/.test(o.textContent)).click(); return true; })()`);
await mustSee('Default input on disk', async () => (await keyOnDisk(slider.id))?.action?.input === true);
r.defaultInput = (await keyOnDisk(slider.id))?.action;
check('Default input is stored as input alone: no node, following the default', r.defaultInput?.input === true && r.defaultInput?.node === undefined, JSON.stringify(r.defaultInput));
await click('[data-value-form="audio.volume"] [data-dropdown]');
await mustSee('the device list again', () => exists('[role=listbox] [role=option]'));
await inEditor(`(() => { [...document.querySelectorAll('[role=listbox] [role=option]')].find((o) => /Headset Mono Mic/.test(o.textContent)).click(); return true; })()`);
await mustSee('the input on disk', async () => (await keyOnDisk(slider.id))?.action?.node === HEADSET_MIC);
check('an input chosen is stored by its node, with input', (await keyOnDisk(slider.id))?.action?.input === true, JSON.stringify(await keyOnDisk(slider.id)));

// The grid draws the deck's level: the fake headset mic has no volume until one is set — set it outside Deckhand.
const pactlState = path.join(scratch, 'pactl.json');
await fs.writeFile(pactlState, JSON.stringify({ volumes: { [HEADSET_MIC]: 40 } }));
await mustSee('the slider\'s level in the grid', async () => (await inEditor(`document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-face]')?.dataset.value`)) === '40', 12000).catch((e) => (r.levelError = e.message));
check('the grid draws the deck\'s level (40%, set outside Deckhand)', (await inEditor(`document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-face]')?.dataset.value`)) === '40', r.levelError ?? '');

if (process.env.DECKHAND_VALUES_SHOT) {
  for (let i = 0; i < 6; i++) await inEditor(`(() => { const b = [...document.querySelectorAll('[data-zoom-bar] button')].find((x) => x.textContent.trim() === '+'); b?.click(); return true; })()`);
  await sleep(500);
  await inEditor(`(() => { document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"]').scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`);
  await sleep(300);
  console.log('layers:', JSON.stringify(await inEditor(`[...document.querySelectorAll('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-layer]')].map((l) => ({ layer: l.dataset.valueLayer, transform: getComputedStyle(l).transform, clip: getComputedStyle(l).clipPath, style: l.getAttribute('style'), box: l.getBoundingClientRect().height }))`)));
  console.log('device shown:', await inEditor(`document.querySelector('[data-value-form="audio.volume"] [data-dropdown]')?.dataset.value`), await text('[data-value-form="audio.volume"] [data-dropdown] .dropdown-shown'));
  await capture(editor, process.env.DECKHAND_VALUES_SHOT);
}

// ---- THE ICON TAB ----
await inEditor(`(() => { [...document.querySelectorAll('[data-value-inspector] .inspector-tab')].find((t) => t.textContent === 'Icon').click(); return true; })()`);
await mustSee('the layer chips', () => exists('[data-layer-chip=thumb]'));
r.chips = await inEditor(`[...document.querySelectorAll('[data-layer-chip]')].map((c) => c.dataset.layerChip + ':' + c.querySelector('.layer-chip-file').textContent)`);
check('chips for the background, the track, the fill and the thumb: no background image, built-in art, the fill drawn', JSON.stringify(r.chips) === JSON.stringify(['background:None', 'track:Built-in', 'level:Drawn', 'thumb:Built-in']), JSON.stringify(r.chips));
// The fill: drawn by Deckhand, switched off and on, and its colour.
await click('[data-layer-chip=level]');
await mustSee('the fill\'s form', () => exists('[data-level-form=slider] input[type=checkbox]'));
check('the fill offers no image: a switch and a colour', !(await exists('[data-layer-actions]')) && (await exists('[data-level-form=slider] [data-colour-picker=level-colour]')));
await click('[data-level-form=slider] input[type=checkbox]');
await mustSee('the fill off on disk', async () => (await keyOnDisk(slider.id))?.level?.show === false);
check('the fill switched off is stored, and the grid draws no fill', (await keyOnDisk(slider.id))?.level?.show === false && !(await exists(`.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-layer=level]`)));
await click('[data-level-form=slider] input[type=checkbox]');
await mustSee('the fill on again', async () => (await keyOnDisk(slider.id))?.level === undefined);
await inEditor(`(() => { const i = document.querySelector('[data-colour-picker=level-colour] [data-colour-hex]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '#ff8800'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await mustSee('the fill\'s colour on disk', async () => (await keyOnDisk(slider.id))?.level?.color === '#ff8800');
r.levelFill = await inEditor(`document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-layer=level]')?.innerHTML ?? ''`);
check('a colour chosen is stored, and the grid draws the fill in it', (await keyOnDisk(slider.id))?.level?.color === '#ff8800' && /#ff8800/i.test(r.levelFill), r.levelFill.slice(0, 200));
// The level's own swatches: bright and saturated, never the background palette.
{
  const { LEVEL_COLOURS } = await import(pathToFileURL(path.join(repoRoot, 'dist/value-controls.js')).href);
  await click('[data-colour-picker=level-colour] [data-colour-swatch]');
  await mustSee('the level\'s swatches', () => exists('[data-colour-picker=level-colour] [data-colour-chip="#00e5ff"]'), 5000).catch(() => undefined);
  r.levelChips = await inEditor(`[...document.querySelectorAll('[data-colour-picker=level-colour] [data-colour-chip]')].map((c) => c.dataset.colourChip)`);
  check('the level offers its own bright colours, its action\'s first, not the background swatches', JSON.stringify(r.levelChips) === JSON.stringify(['default', ...LEVEL_COLOURS]), JSON.stringify(r.levelChips));
  await click('[data-colour-picker=level-colour] [data-colour-chip="#00e5ff"]');
  await mustSee('the swatch on disk', async () => (await keyOnDisk(slider.id))?.level?.color === '#00e5ff');
  check('a swatch chosen is stored as the level\'s colour', (await keyOnDisk(slider.id))?.level?.color === '#00e5ff', JSON.stringify((await keyOnDisk(slider.id))?.level));
  await inEditor(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
}
// The background: no built-in, an image, and None again.
await click('[data-layer-chip=background]');
await mustSee('the background\'s picker', () => exists('[data-layer-none=background]'));
check('the background offers None, and no built-in', !(await exists('[data-layer-builtin=background]')));
await mustSee('the picker on Pictures (background)', () => exists(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`), 10000);
await click(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`);
await mustSee('the background on disk', async () => (await keyOnDisk(slider.id))?.layers?.background === '~/Pictures/cap.png');
// The control's own box is the key's outer edge (the deck fills its whole box): the image must cover exactly that, selected or not.
const backBox = () => inEditor(`(() => { const k = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"]'); const i = k.querySelector('[data-value-layer=background] img'); if (!i) return null; const K = k.getBoundingClientRect(); const b = i.getBoundingClientRect(); const d = (v) => Math.round(v * 10) / 10; return { fit: getComputedStyle(i).objectFit, dx: d(b.left - K.left), dy: d(b.top - K.top), dw: d(b.width - K.width), dh: d(b.height - K.height), selected: k.classList.contains('key-selected') }; })()`);
const covers = (b) => b && b.fit === 'fill' && [b.dx, b.dy, b.dw, b.dh].every((v) => Math.abs(v) < 0.5);
r.backImg = await backBox();
check('a background image chosen is stored, and drawn stretched over the control\'s whole box, as the deck draws it — selected', r.backImg?.selected && covers(r.backImg), JSON.stringify(r.backImg));
await click('[data-layer-none=background]');
await mustSee('no background on disk', async () => (await keyOnDisk(slider.id))?.layers?.background === undefined);
check('None: no background image stored', (await keyOnDisk(slider.id))?.layers?.background === undefined);
// The track: an image, as the thumb (on the first test only the thumb could be seen to change).
await click('[data-layer-chip=track]');
await mustSee('the track\'s picker', () => exists('[data-layer-builtin=track]'));
check('the track has no None', !(await exists('[data-layer-none=track]')));
await mustSee('the picker on Pictures (track)', () => exists(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`), 10000);
await click(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`);
await mustSee('the track on disk', async () => (await keyOnDisk(slider.id))?.layers?.track === '~/Pictures/cap.png');
r.trackImg = await inEditor(`(() => { const k = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"]'); const i = k.querySelector('[data-value-layer=track] img'); if (!i) return null; const K = k.getBoundingClientRect(); const b = i.getBoundingClientRect(); const d = (v) => Math.round(v * 10) / 10; return { fit: getComputedStyle(i).objectFit, dx: d(b.left - K.left), dy: d(b.top - K.top), dw: d(b.width - K.width), dh: d(b.height - K.height) }; })()`);
check('a track image chosen is stored, and the grid draws it stretched over the whole control (no label), as the deck does', (await keyOnDisk(slider.id))?.layers?.track === '~/Pictures/cap.png' && covers(r.trackImg), JSON.stringify(r.trackImg));
await click('[data-layer-builtin=track]');
await mustSee('the built-in track again', async () => (await keyOnDisk(slider.id))?.layers?.track === undefined);
await click('[data-layer-chip=thumb]');
await mustSee('the picker on Pictures', () => exists(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`), 10000);
await click(`.picker-item[data-path="${path.join(pictures, 'mural.png')}"]`);
await mustSee('the refusal', async () => /4096/.test((await text('.picker .field-error')) ?? ''));
r.refused = await text('.picker .field-error');
check('a 5000 px image is refused with its reason, and not saved', /4096/.test(r.refused ?? '') && (await keyOnDisk(slider.id))?.layers?.thumb === undefined, `${r.refused} / ${JSON.stringify(await keyOnDisk(slider.id))}`);
await click(`.picker-item[data-path="${path.join(pictures, 'cap.png')}"]`);
await mustSee('the thumb on disk', async () => (await keyOnDisk(slider.id))?.layers?.thumb === '~/Pictures/cap.png');
check('a thumb image chosen is stored as a path', (await keyOnDisk(slider.id))?.layers?.thumb === '~/Pictures/cap.png');
// cap.png is 60 × 240: in the thumb's area (the slider's width, as long as it is wide) it is fitted, never stretched.
r.thumbImg = await inEditor(`(() => { const s = document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-layer=thumb]'); const i = s?.querySelector('img'); if (!i) return null; const b = i.getBoundingClientRect(); const f = s.getBoundingClientRect(); return { fit: getComputedStyle(i).objectFit, across: Math.round(b.width - f.width), along: Math.round(b.height - f.height) }; })()`);
// Its travel is the deck's own rule, from cap.png's own size (60 × 240) fitted in the thumb's area.
{
  const { sliderTravel } = await import(pathToFileURL(path.join(repoRoot, 'dist/value-controls.js')).href);
  const c = await controlOnDisk(slider.id);
  const want = sliderTravel({ w: c.w, h: c.h }, c.direction, { customTrack: false, thumb: { w: 60, h: 240 } });
  const wantSaid = [want.start, want.end, want.thumb].map((n) => Math.round(n)).join(',');
  await mustSee('the thumb image loaded', async () => (await inEditor(`document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-face]')?.dataset.travel`)) === wantSaid, 5000).catch(() => undefined);
  r.travel = await inEditor(`document.querySelector('.grid[data-deck="${KEY}"] [data-key="${slider.id}"] [data-value-face]')?.dataset.travel`);
  check('a chosen thumb travels in the grid by the deck\'s rule: its own size fitted in its area', r.travel === wantSaid, `${r.travel} vs ${wantSaid}`);
}
check('the grid draws a chosen thumb keeping its proportions (contain), across the slider\'s width, not its length', r.thumbImg?.fit === 'contain' && r.thumbImg.across === 0 && r.thumbImg.along < 0, JSON.stringify(r.thumbImg));

// ---- THE DIAL: BRIGHTNESS AND ITS ANGLES ----
await selectKey(dial.id);
await mustSee('the dial\'s inspector', () => exists('[data-value-inspector=dial]'));
await click('.library [data-action-type="brightness"]');
await mustSee('Brightness on the dial', async () => (await keyOnDisk(dial.id))?.action?.type === 'brightness');
r.targets = await inEditor(`[...document.querySelectorAll('[data-value-form=brightness] [data-brightness-target] [data-deck]')].map((b) => b.dataset.deck)`);
check('Brightness on a dial: This deck and every connected deck', r.targets[0] === '' && r.targets.includes(XL) && r.targets.includes(KEY), JSON.stringify(r.targets));
r.brightnessSays = await text('[data-value-form=brightness] p');
check('…from 5 to 100, never dark', /from 5 to 100/.test(r.brightnessSays ?? '') && !/At 0/.test(r.brightnessSays ?? ''), r.brightnessSays);
await inEditor(`(() => { [...document.querySelectorAll('[data-value-inspector] .inspector-tab')].find((t) => t.textContent === 'Icon').click(); return true; })()`);
await mustSee('the knob chip', () => exists('[data-layer-chip=knob]'));
await click('[data-layer-chip=knob]');
await mustSee('the angles', () => exists('[data-knob-angle=start]'));
await inEditor(`(() => { const i = document.querySelector('[data-knob-angle=start]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '-90'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
await mustSee('the angles on disk', async () => (await keyOnDisk(dial.id))?.angles?.start === -90);
check('the knob\'s Start angle is stored with it', JSON.stringify((await keyOnDisk(dial.id))?.angles) === JSON.stringify({ start: -90, end: 135 }), JSON.stringify(await keyOnDisk(dial.id)));

// ---- KEYS MOVED BETWEEN CONTROLS ----
r.ontoButton = await dragKey(slider.id, 'b1');
await sleep(400);
check('a slider\'s key dragged onto a button is refused, saying why, and nothing moves', r.ontoButton.refused && /only on a slider or dial/.test(r.ontoButton.line ?? '') && (await keyOnDisk('b1'))?.action?.type === 'hotkey', JSON.stringify(r.ontoButton));
r.ontoDial = await dragKey(slider.id, dial.id);
await mustSee('the slider\'s key on the dial', async () => (await keyOnDisk(dial.id))?.action?.type === 'audio.volume');
check('a slider\'s key dragged onto the dial moves there, the dial\'s onto the slider', !r.ontoDial.refused && (await keyOnDisk(dial.id))?.action?.type === 'audio.volume' && (await keyOnDisk(slider.id))?.action?.type === 'brightness', JSON.stringify([await keyOnDisk(dial.id), await keyOnDisk(slider.id)]));

// ---- ONE CLEAR ----
await selectKey(slider.id);
await mustSee('the slider\'s inspector, Key tab', () => exists('[data-clear-value]'));
await click('[data-clear-value]');
await mustSee('the slider emptied', async () => (await keyOnDisk(slider.id)) === null);
check('Clear slider empties it: no key left', (await keyOnDisk(slider.id)) === null);

// ---- THE STREAM DECK ----
await click('.show-in-editor-trigger');
await mustSee('the XL in Show in editor', () => exists(`[data-show-deck="${XL}"] .show-in-editor-name`));
await click(`[data-show-deck="${XL}"] .show-in-editor-name`);
await mustSee('the XL alone', () => exists(`[data-deck-panel="${XL}"] .deck-panel-header`));
r.xl = await inEditor(`({ kinds: document.querySelectorAll('.grid[data-deck="${XL}"] [data-control-kind]').length, faces: document.querySelectorAll('[data-value-face]').length })`);
check('the Stream Deck has no slider or dial', r.xl.kinds === 0 && r.xl.faces === 0, JSON.stringify(r.xl));

console.log(failures === 0 ? '\ncheck:values — all passed' : `\ncheck:values — ${failures} failed`);
await stop(failures === 0 ? 0 : 1);
