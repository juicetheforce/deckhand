// Settings › Decks › Virtual decks, end to end in real Electron.
//
// The daemon is the control harness's, given the real virtual driver over a
// scratch /sys/class/drm (a 10.3" panel on DP-4, keyed GRA-6e4e by its EDID;
// an HP on HDMI-A-1), a scratch /sys/class/input and udev database (the
// panel's ILITEK and its mouse twin), and scripts/test/fake-panel.mjs as the
// display helper — whose socket the check writes the tap to. What is checked
// from outside the page: config.json on disk, the kept copy, and the helper's
// frames.
//
// - Add: the screens listed, one already a deck refused; the tap, cancelled
//   and then made; the sizes offered with their counts; the deck written
//   with its pairing and a Medium panel in the active profile only.
// - The list: the deck, its size in that profile.
// - A new size keeps keys by row and column; one with no place is named,
//   and dropped only once confirmed; nothing is added to the kept configurations.
// - Remove takes the pairing only; the layouts stay.
//
// Usage: npm run check:virtual   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_VIRTUAL_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-vcheck-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const socks = path.join(scratch, 'socks');
const panelLog = path.join(scratch, 'panel.log');
await fs.mkdir(configDir);
await fs.mkdir(socks);

const { edid, fakeSysfs, ILITEK, ILITEK_NODES } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }));
await sysfs.plug('HDMI-A-1', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN', name: 'HP E243', widthMm: 527, heightMm: 296 }));
await sysfs.usbDevice('pci0/usb3/3-2.3', '222a');
for (const node of ILITEK_NODES) await sysfs.inputNode(node);

// Read by the daemon's modules when they load: set before the harness is imported.
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
  // No logind: a virtual deck's touch would be "unknown". Nothing here touches.
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { createVirtualDriver } = await import(pathToFileURL(path.join(repoRoot, 'dist/drivers/virtual.js')).href);
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

const XL = 'VIRTUAL-CHECK-XL';
const KEY = 'GRA-6e4e';
const page = { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } };
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: { default: { name: 'Default', layouts: { [XL]: page } }, second: { name: 'Second', layouts: { [XL]: page } } },
  startProfile: 'default',
};
const configFile = path.join(configDir, 'config.json');
await fs.writeFile(configFile, JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG, { virtual: createVirtualDriver(() => null) });
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

const onDisk = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));
const frames = async () => (await fs.readFile(panelLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const exists = (editor, selector) => inPage(editor, 'settings', `document.querySelector(${JSON.stringify(selector)}) !== null`);
/** The fake helper on a connector says what the real one would when a touchscreen is tapped. */
async function tapOn(connector, device) {
  const sock = path.join(socks, `${connector}.sock`);
  return until(
    () =>
      new Promise((resolve) => {
        const c = net.connect(sock, () => c.end(JSON.stringify({ ev: 'tap', device }) + '\n', () => resolve(true)));
        c.on('error', () => resolve(false));
      }),
  );
}

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);
await inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
await until(async () => (await stateOf(editor)).settingsOpen);
await until(async () => (await inPage(editor, 'settings', "document.querySelector('.settings-footer') !== null")) === true);
await inPage(editor, 'settings', clickIn('[data-settings-nav=decks]'));
await sleep(200);
r.empty = { group: await exists(editor, '[data-settings-group=virtual-decks]'), rows: await inPage(editor, 'settings', "document.querySelectorAll('[data-vd-deck]').length"), add: await exists(editor, '[data-vd=add]') };

// ADD — the screens.
await inPage(editor, 'settings', clickIn('[data-vd=add]'));
await until(() => exists(editor, '[data-vd-screen=DP-4] button'));
r.screens = await inPage(editor, 'settings', "[...document.querySelectorAll('[data-vd-screen]')].map((li) => li.dataset.vdScreen + ' ' + li.querySelector('button').textContent + (li.querySelector('button').disabled ? ' disabled' : ''))");

// Cancelled: the helper is quit, and the flow closes.
await inPage(editor, 'settings', clickIn('[data-vd-screen=DP-4] button'));
await until(() => exists(editor, '[data-vd-step=tap]'));
await until(async () => (await frames()).some((f) => f.type === 'T' && f.mode === 2));
await inPage(editor, 'settings', clickIn('[data-vd=cancel-tap]'));
r.cancelled = { closed: await until(() => exists(editor, '[data-vd=add]')), quit: await until(async () => (await frames()).some((f) => f.type === 'Q')) };

// The tap, for real this time.
const startsBefore = (await frames()).filter((f) => f.type === 'start').length;
await inPage(editor, 'settings', clickIn('[data-vd=add]'));
await until(() => exists(editor, '[data-vd-screen=DP-4] button'));
await inPage(editor, 'settings', clickIn('[data-vd-screen=DP-4] button'));
await until(async () => (await frames()).filter((f) => f.type === 'start').length > startsBefore);
const pairFrame = (await frames()).findLast((f) => f.type === 'T');
r.pairMode = pairFrame?.mode;
r.tapSent = await tapOn('DP-4', `${sysfs.dev}/event15`);
r.sizeStep = await until(() => exists(editor, '[data-vd-step=size]'));
r.sizes = await inPage(editor, 'settings', "[...document.querySelectorAll('[data-vd-size]')].map((l) => l.dataset.vdSize + ': ' + l.querySelector('.muted').textContent)");
r.pairedLine = await inPage(editor, 'settings', "document.querySelector('[data-vd-step=size] .sp-row-title').textContent");
await inPage(editor, 'settings', clickIn('[data-vd=finish-add]'));
r.written = await until(async () => (await onDisk()).decks?.[KEY]?.virtual !== undefined);
r.config = await onDisk();
r.notice = await inPage(editor, 'settings', "document.querySelector('[data-vd-notice]')?.textContent ?? null");

// THE LIST.
await until(() => exists(editor, `[data-vd-deck="${KEY}"]`));
r.row = await inPage(editor, 'settings', `(() => { const d = document.querySelector('[data-vd-deck="${KEY}"]'); return { text: d.querySelector('.sp-row-title').textContent.trim(), detail: d.querySelector('.sp-row-detail').textContent, size: d.querySelector('[data-vd-layout=default] .sp-row-detail').textContent }; })()`);

// RESIZE — a key at k1 (row 0, column 0) and one at k24 (row 2, column 7):
// Large is 2 × 5, so k1 stays where it is and k24 has no place.
const withKeys = await onDisk();
withKeys.profiles.default.layouts[KEY].pages[withKeys.profiles.default.layouts[KEY].startPage].buttons = { k1: { label: 'Stays' }, k24: { label: 'Corner' } };
await fs.writeFile(configFile, JSON.stringify(withKeys, null, 2) + '\n');
await until(async () => JSON.stringify(daemon.state.config).includes('Corner'));
await sleep(300);
await inPage(editor, 'settings', clickIn(`[data-vd-deck="${KEY}"] [data-vd=resize]`));
await until(() => exists(editor, '[data-vd-layout=default] [data-vd-size=large] input'));
await inPage(editor, 'settings', clickIn('[data-vd-layout=default] [data-vd-size=large] input'));
await sleep(100);
await inPage(editor, 'settings', clickIn('[data-vd-layout=default] [data-vd=apply-size]'));
r.droppedNamed = await until(() => exists(editor, '[data-vd-dropped]'));
r.droppedText = await inPage(editor, 'settings', "document.querySelector('[data-vd-dropped]')?.textContent ?? null");
r.notYet = (await onDisk()).profiles.default.layouts[KEY].panel.controls.length;
await inPage(editor, 'settings', clickIn('[data-vd-layout=default] [data-vd=apply-size]'));
r.resized = await until(async () => (await onDisk()).profiles.default.layouts[KEY].panel.controls.length === 10);
const afterResize = (await onDisk()).profiles.default.layouts[KEY];
r.afterButtons = afterResize.pages[afterResize.startPage].buttons;
r.kept = (await fs.readdir(path.join(stateDir, 'backups')).catch(() => [])).filter((f) => f.startsWith('before-resize-'));

// REMOVE.
await until(() => exists(editor, `[data-vd-deck="${KEY}"] [data-vd=remove]`));
await inPage(editor, 'settings', clickIn(`[data-vd-deck="${KEY}"] [data-vd=remove]`));
await inPage(editor, 'settings', clickIn('[data-vd=confirm-remove]'));
r.removed = await until(async () => (await onDisk()).decks?.[KEY]?.virtual === undefined);
r.afterRemove = await onDisk();
r.rowGone = await until(async () => !(await exists(editor, `[data-vd-deck="${KEY}"]`)));

// ADD AGAIN: its layout was kept, so no size is asked, and it says so.
await inPage(editor, 'settings', clickIn('[data-vd=add]'));
await until(() => exists(editor, '[data-vd-screen=DP-4] button:not([disabled])'));
const startsAgain = (await frames()).filter((f) => f.type === 'start').length;
await inPage(editor, 'settings', clickIn('[data-vd-screen=DP-4] button'));
await until(async () => (await frames()).filter((f) => f.type === 'start').length > startsAgain);
await tapOn('DP-4', `${sysfs.dev}/event15`);
r.readded = await until(async () => (await onDisk()).decks?.[KEY]?.virtual !== undefined);
r.readdedNotice = await until(async () => /previous layout/.test((await inPage(editor, 'settings', "document.querySelector('[data-vd-notice]')?.textContent ?? ''")) ?? ''));
r.readdedAskedSize = await exists(editor, '[data-vd-step=size]');
r.readdedControls = (await onDisk()).profiles.default.layouts[KEY].panel.controls.length;

check('Settings › Decks has a Virtual decks group: none yet, and Add', () => assert.deepEqual(r.empty, { group: true, rows: 0, add: true }));
check('Add lists the connected screens by name', () => assert.deepEqual(r.screens, ['DP-4 HD Display', 'HDMI-A-1 HP E243']));
check('Cancel during the tap closes the flow and quits the helper', () => assert.deepEqual(r.cancelled, { closed: true, quit: true }));
check('the tap is read in pairing mode, and answered', () => {
  assert.equal(r.pairMode, 2);
  assert.equal(r.tapSent, true);
  assert.equal(r.sizeStep, true);
});
check('the sizes offered say what each gives on this screen (the 10.3" panel: 4 × 10, 3 × 8, 2 × 5; the key itself, 88% of the pitch)', () =>
  assert.deepEqual(r.sizes, ['small: 4 × 10 keys, about 20 mm', 'medium: 3 × 8 keys, about 27 mm', 'large: 2 × 5 keys, about 40 mm', 'custom: choose the rows']));
check('…and name the screen and the touchscreen tapped', () => assert.equal(r.pairedLine, 'HD Display, paired with ILITEK Multi-Touch-V3000. Key size?'));
check('Add writes the pairing, keyed by the screen, and a Medium panel in the active profile only', () => {
  assert.equal(r.written, true);
  assert.deepEqual(r.config.decks[KEY], { virtual: { output: 'DP-4', touch: ILITEK } });
  const layout = r.config.profiles.default.layouts[KEY];
  assert.equal(layout.panel.preset, 'medium');
  assert.equal(layout.panel.controls.length, 24);
  assert.deepEqual(layout.panel.size, { width: 1920, height: 720 });
  assert.equal(r.config.profiles.second.layouts[KEY], undefined, 'another profile gets its layout from the editor');
  assert.match(r.notice ?? '', /HD Display is a virtual deck, paired with ILITEK Multi-Touch-V3000\. Its keys are in the editor, in “Default”\./);
});
check('the list shows it, and its size in that profile', () => {
  assert.match(r.row.text, /GRA-6e4e|HD Display/);
  assert.match(r.row.detail, /^DP-4 · not connected$/);
  assert.equal(r.row.size, 'Medium, 3 × 8 keys');
});
check('a new size that drops a key names it, and changes nothing until confirmed', () => {
  assert.equal(r.droppedNamed, true);
  assert.match(r.droppedText ?? '', /1 key has no place at that size and will be removed: “Corner” \(key 24\) on “Main”\./);
  assert.equal(r.notYet, 24);
});
check('confirmed: keys keep their row and column, the one with no place goes; no kept configuration is added', () => {
  assert.equal(r.resized, true);
  assert.deepEqual(r.afterButtons, { k1: { label: 'Stays' } });
  assert.equal(r.kept.length, 0, JSON.stringify(r.kept));
});
check('Remove takes away the pairing only: the layouts stay', () => {
  assert.equal(r.removed, true);
  assert.equal(r.afterRemove.profiles.default.layouts[KEY]?.panel?.controls.length, 10);
  assert.equal(r.rowGone, true);
});

check('added again after Remove: no size asked, its kept layout used, and said so', () => {
  assert.equal(r.readded, true);
  assert.equal(r.readdedAskedSize, false);
  assert.equal(r.readdedNotice, true);
  assert.equal(r.readdedControls, 10, 'the 2 × 5 it had');
});

editor.child.kill();
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
