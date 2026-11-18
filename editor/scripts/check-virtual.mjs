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
//   and then made; the grids offered with their counts; the deck written
//   with its pairing, a Medium default, and a first page with that grid in
//   the active profile only.
// - The list: the deck, and no sizes — every page has its own layout,
//   changed on the page (2026-11-17).
// - Remove takes the pairing only; the layouts stay, each page with its grid.
// - The main window, with the deck connected through the real virtual driver
//   and the fake helper: Change layout… on a page names the keys it drops and
//   changes only that page once confirmed; New page offers the grids with the
//   last choice preselected; the deck re-lays out on a page change only when
//   the grid differs (the helper's frames); Change layout… is also a button in
//   the deck's header, beside its Page ▾, and focuses that deck when another
//   is being edited; a Stream Deck gets none of it.
// - Touchscreen access (touch-access.ts): the real root helper,
//   udev/deckhand-touch-access, run by a stand-in pkexec in its test mode
//   against a scratch /dev with ACLs kept as files — the password refused
//   (nothing paired), the temporary access dropped on a cancel and on a timed
//   out tap, the rule written for the paired touchscreen at Add, and
//   rewritten without it at Remove.
// - The screen list: name, size and resolution, the laptop's own screen
//   marked built-in, a screen already a deck left out; no touch on the screen
//   chosen says so.
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
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);
await sysfs.plug('HDMI-A-1', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN', name: 'HP E243', widthMm: 527, heightMm: 296 }), ['1920x1080', '1280x720']);
await sysfs.plug('eDP-1', 'connected', edid({ maker: 'SHP', product: '1515', numeric: 0, widthMm: 290, heightMm: 180 }), ['3840x2400']);
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
  // A tap not made within 5 s gives up, as the real one does after 30.
  DECKHAND_PAIR_MS: '5000',
  // No logind: a virtual deck's touch would be "unknown". Nothing here touches.
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(scratch, 'no-bus')}`,
});
const { FakeDeck, connect, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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
// The driver sees no virtual deck in the config until the main-window part,
// so nothing before it attaches one; then the check attaches it itself.
let virtualConfig = () => null;
const virtualDriver = createVirtualDriver(() => virtualConfig());
const daemon = await startDaemon(scratch, CONFIG, { virtual: virtualDriver });
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

// The root helper's world: a panel touchscreen (event15) and a keyboard
// (event3), stand-ins for udevadm and the ACL tools, and a pkexec that runs
// the real helper as this user, or refuses as a dismissed password does.
const ht = path.join(scratch, 'touch-access');
for (const d of ['sys/class/input/event15/device/id', 'sys/class/input/event3/device/id', 'dev/input', 'bin', 'acl', 'props', 'rules']) await fs.mkdir(path.join(ht, d), { recursive: true });
for (const [n, vendor, product] of [['event15', '222a', '0001'], ['event3', '1234', '5678']]) {
  await fs.writeFile(path.join(ht, 'sys/class/input', n, 'device/id/vendor'), `${vendor}\n`);
  await fs.writeFile(path.join(ht, 'sys/class/input', n, 'device/id/product'), `${product}\n`);
}
for (const n of ['event15', 'event3']) await fs.writeFile(path.join(ht, 'dev/input', n), '');
await fs.writeFile(path.join(ht, 'props/event15'), 'ID_INPUT_TOUCHSCREEN=1\n');
await fs.writeFile(path.join(ht, 'props/event3'), 'ID_INPUT_KEYBOARD=1\n');
const script = (body) => `#!/bin/bash\n${body}\n`;
await fs.writeFile(path.join(ht, 'bin/udevadm'), script(`[ "$1" = info ] && cat "${ht}/props/$(basename "\${@: -1}")"; exit 0`), { mode: 0o755 });
await fs.writeFile(path.join(ht, 'bin/setfacl'), script(`f="${ht}/acl/$(basename "$3")"; case "$1" in -m) echo "user:\${2#u:}" >> "$f" ;; -x) [ -f "$f" ] && sed -i "/^user:\${2#u:}:/d" "$f" ;; esac; exit 0`), { mode: 0o755 });
await fs.writeFile(path.join(ht, 'bin/getfacl'), script(`cat "${ht}/acl/$(basename "\${@: -1}")" 2>/dev/null; exit 0`), { mode: 0o755 });
const pkexecLog = path.join(ht, 'pkexec.log');
const refuse = path.join(ht, 'refuse');
await fs.writeFile(path.join(ht, 'pkexec'), script(`echo "\${@:2}" >> "${pkexecLog}"; [ -e "${refuse}" ] && exit 126; exec env PKEXEC_UID="$(id -u)" DECKHAND_TOUCH_ACCESS_TEST="${ht}" bash "$@"`), { mode: 0o755 });
env.DECKHAND_TOUCH_ACCESS = path.join(repoRoot, 'udev/deckhand-touch-access');
env.DECKHAND_PKEXEC = path.join(ht, 'pkexec');
const rules = path.join(ht, `rules/61-deckhand-touchscreens-${process.getuid()}.rules`);
const panelAcl = () => fs.readFile(path.join(ht, 'acl/event15'), 'utf8').catch(() => '');
const pkexecRuns = async () => (await fs.readFile(pkexecLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const bannerText = () => inPage(editor, 'settings', "document.querySelector('[data-vd-step=screen] .sp-banner, [data-vd-step=screen] [class*=banner]')?.textContent ?? ''");

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
r.screens = await inPage(editor, 'settings', "[...document.querySelectorAll('[data-vd-screen]')].map((li) => li.dataset.vdScreen + ' ' + li.querySelector('button').textContent + ' — ' + li.querySelector('[data-vd-screen-detail]').textContent)");

// The password refused: nothing is shown on the screen, nothing paired.
await fs.writeFile(refuse, '');
const startsRefused = (await frames()).filter((f) => f.type === 'start').length;
await inPage(editor, 'settings', clickIn('[data-vd-screen=DP-4] button'));
r.refused = await until(async () => /needs your password/.test(await bannerText()));
r.refusedNoPanel = (await frames()).filter((f) => f.type === 'start').length === startsRefused;
await fs.rm(refuse);

// Cancelled: the helper is quit, and the flow closes.
await inPage(editor, 'settings', clickIn('[data-vd-screen=DP-4] button'));
await until(() => exists(editor, '[data-vd-step=tap]'));
await until(async () => (await frames()).some((f) => f.type === 'T' && f.mode === 2));
r.accessDuringTap = await panelAcl();
await inPage(editor, 'settings', clickIn('[data-vd=cancel-tap]'));
r.cancelled = { closed: await until(() => exists(editor, '[data-vd=add]')), quit: await until(async () => (await frames()).some((f) => f.type === 'Q')) };
r.accessAfterCancel = (await until(async () => (await panelAcl()) === '')) && !(await fs.stat(rules).catch(() => null));

// No tap on the screen chosen: said, and another can be chosen.
await inPage(editor, 'settings', clickIn('[data-vd=add]'));
await until(() => exists(editor, '[data-vd-screen=HDMI-A-1] button'));
await inPage(editor, 'settings', clickIn('[data-vd-screen=HDMI-A-1] button'));
r.noTouch = await until(async () => /No touch was detected on HP E243\. It may not be the screen with the touchscreen: choose another\./.test(await bannerText()), 20_000);
r.noTouchBackToList = await exists(editor, '[data-vd-screen=DP-4] button');
r.accessAfterNoTouch = (await until(async () => (await panelAcl()) === '')) && !(await fs.stat(rules).catch(() => null));
await inPage(editor, 'settings', clickIn('[data-vd-step=screen] .sp-button-quiet'));
await until(() => exists(editor, '[data-vd=add]'));

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
r.sizeNames = await inPage(editor, 'settings', "[...document.querySelectorAll('[data-vd-size] .vd-size-name')].map((l) => l.textContent)");
r.pairedLine = await inPage(editor, 'settings', "document.querySelector('[data-vd-step=size] .sp-row-title').textContent");
// Custom: both fields, starting from the size picked before it; very small keys warned of.
await inPage(editor, 'settings', clickIn('[data-vd-step=size] [data-vd-size=custom] input'));
await sleep(100);
r.customFields = await inPage(editor, 'settings', "[document.querySelector('[data-vd-field=rows]')?.value, document.querySelector('[data-vd-field=columns]')?.value]");
await inPage(editor, 'settings', "(() => { const i = document.querySelector('[data-vd-field=rows]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
await sleep(100);
r.customWarned = await exists(editor, '[data-vd-warning=small]');
await inPage(editor, 'settings', clickIn('[data-vd-step=size] [data-vd-size=medium] input'));
await sleep(100);
await inPage(editor, 'settings', clickIn('[data-vd=finish-add]'));
r.written = await until(async () => (await onDisk()).decks?.[KEY]?.virtual !== undefined);
r.config = await onDisk();
r.notice = await inPage(editor, 'settings', "document.querySelector('[data-vd-notice]')?.textContent ?? null");
r.rulesAfterAdd = await fs.readFile(rules, 'utf8').catch(() => '');
r.accessAfterAdd = await panelAcl();

// A PROFILE MADE AFTER THE DECK (found on both machines, 2026-10-17: the deck
// got no panel there, "0 keys", and Settings could not size it). The call the
// toolbar's New profile makes, with both decks ticked — the harness cannot
// connect a virtual deck, so its form would not list it.
await inPage(editor, 'editor', `window.deckhand.apply({ kind: 'addProfile', name: 'Later', serials: ['${XL}', '${KEY}'], pageName: 'Main' }).then((x) => x.ok)`);
r.laterMade = await until(async () => Object.values((await onDisk()).profiles).some((p) => p.name === 'Later'));
const [laterId, later] = Object.entries((await onDisk()).profiles).find(([, p]) => p.name === 'Later');
r.laterLayout = later.layouts[KEY];
r.laterDefault = (await onDisk()).decks[KEY].virtual.panel;
await sleep(300);
r.sizeRows = await inPage(editor, 'settings', "document.querySelectorAll('[data-vd-layout], [data-vd-default], [data-vd=resize]').length");

// Added: the screen is not offered again.
await inPage(editor, 'settings', clickIn('[data-vd=add]'));
await until(() => exists(editor, '[data-vd-screen=HDMI-A-1] button'));
r.offeredAfterAdd = await inPage(editor, 'settings', "[...document.querySelectorAll('[data-vd-screen]')].map((li) => li.dataset.vdScreen)");
await inPage(editor, 'settings', clickIn('[data-vd-step=screen] .sp-button-quiet'));
await until(() => exists(editor, '[data-vd=add]'));

// THE LIST.
await until(() => exists(editor, `[data-vd-deck="${KEY}"]`));
r.row = await inPage(editor, 'settings', `(() => { const d = document.querySelector('[data-vd-deck="${KEY}"]'); return { text: d.querySelector('.sp-row-title').textContent.trim(), detail: d.querySelector('.sp-row-detail').textContent, rows: d.querySelectorAll('.sp-row').length }; })()`);

// TURN OFF AND ON — as a Virtual deck on/off key or `deckhand virtual off` does, then the row's button.
const powerButton = () => inPage(editor, 'settings', `(() => { const b = document.querySelector('[data-vd-deck="${KEY}"] [data-vd=power]'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()`);
const rowDetail = () => inPage(editor, 'settings', `document.querySelector('[data-vd-deck="${KEY}"] .sp-row-detail')?.textContent ?? null`);
r.powerWhileUnplugged = await powerButton();
const socketClient = await connect(daemon.socket);
await socketClient.request('virtual.power', { deck: KEY, on: false });
r.offShown = await until(async () => /turned off/.test((await rowDetail()) ?? '') && (await powerButton())?.text === 'Turn on');
r.offDetail = await rowDetail();
r.offButton = await powerButton();
await inPage(editor, 'settings', clickIn(`[data-vd-deck="${KEY}"] [data-vd=power]`));
r.onAgain = await until(async () => (await rowDetail()) === 'DP-4 · not connected');
r.onStatus = (await socketClient.request('status')).result.decks.find((d) => d.serial === KEY)?.off ?? 'not off';
socketClient.close();

// REMOVE.
await until(() => exists(editor, `[data-vd-deck="${KEY}"] [data-vd=remove]`));
await inPage(editor, 'settings', clickIn(`[data-vd-deck="${KEY}"] [data-vd=remove]`));
await inPage(editor, 'settings', clickIn('[data-vd=confirm-remove]'));
r.removed = await until(async () => (await onDisk()).decks?.[KEY]?.virtual === undefined);
r.afterRemove = await onDisk();
r.removeRun = (await pkexecRuns()).at(-1);
r.rulesAfterRemove = await fs.stat(rules).then(() => true, () => false);
r.accessAfterRemove = await panelAcl();
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
const readdedLayout = (await onDisk()).profiles.default.layouts[KEY];
r.readdedControls = readdedLayout.pages[readdedLayout.startPage].panel?.controls.length;
r.rulesAfterReadd = /222a/.test(await fs.readFile(rules, 'utf8').catch(() => ''));

check('Settings › Decks has a Virtual decks group: none yet, and Add (a touchscreen is connected)', () => assert.deepEqual(r.empty, { group: true, rows: 0, add: true }));
check('Add lists every connected screen by name, size and resolution; the laptop\'s own is marked built-in', () =>
  assert.deepEqual(r.screens, ['DP-4 HD Display — 10.2″ · 1920 × 720 · DP-4', 'HDMI-A-1 HP E243 — 23.8″ · 1920 × 1080 · HDMI-A-1', 'eDP-1 SHP-1515 — Built-in screen · 13.4″ · 3840 × 2400 · eDP-1']));
check('the password refused: said, and nothing shown on the screen or paired', () => {
  assert.equal(r.refused, true);
  assert.equal(r.refusedNoPanel, true);
});
check('during the tap the touchscreens are readable; a cancel drops it and writes no rule', () => {
  assert.match(r.accessDuringTap, /^user:\d+:r/);
  assert.equal(r.accessAfterCancel, true);
});
check('no touch on the screen chosen: says so, suggests another, back to the list, access dropped', () => {
  assert.equal(r.noTouch, true);
  assert.equal(r.noTouchBackToList, true);
  assert.equal(r.accessAfterNoTouch, true);
});
check('Add writes a rule for the paired touchscreen only — a file ACL for this user, never the uaccess tag — and it is readable at once', () => {
  const lines = r.rulesAfterAdd.split('\n').filter((l) => l.startsWith('SUBSYSTEM'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`ATTRS\\{id/vendor\\}=="222a", ATTRS\\{id/product\\}=="0001", RUN\\+=".*setfacl -m u:${process.getuid()}:r \\$devnode"$`));
  assert.doesNotMatch(lines[0], /uaccess/);
  assert.match(r.accessAfterAdd, new RegExp(`^user:${process.getuid()}:r`));
});
check('a screen that is a virtual deck already is not offered', () => assert.deepEqual(r.offeredAfterAdd, ['HDMI-A-1', 'eDP-1']));
check('Remove rewrites the rule without its touchscreen (none left: no rule file)', () => {
  assert.equal(r.removeRun.trim(), 'set', 'the helper run with no entries left');
  assert.equal(r.rulesAfterRemove, false);
  assert.equal(r.accessAfterRemove, '', 'and its ACL taken off at once');
});
check('Cancel during the tap closes the flow and quits the helper', () => assert.deepEqual(r.cancelled, { closed: true, quit: true }));
check('the tap is read in pairing mode, and answered', () => {
  assert.equal(r.pairMode, 2);
  assert.equal(r.tapSent, true);
  assert.equal(r.sizeStep, true);
});
check('the sizes offered say what each gives on this screen (the 10.3" panel: 4 × 10, 3 × 8, 2 × 5; the key itself, 88% of the pitch)', () =>
  assert.deepEqual(r.sizes, ['small: 4 × 10 keys, about 20 mm', 'medium: 3 × 8 keys, about 27 mm', 'large: 2 × 5 keys, about 40 mm', 'custom: set the rows and columns']));
check('…and name the screen and the touchscreen tapped', () => assert.equal(r.pairedLine, 'HD Display, paired with ILITEK Multi-Touch-V3000. Grid size?'));
check('the grids are Small, Medium, Large and Grid Size — today\'s Custom, renamed', () => assert.deepEqual(r.sizeNames, ['Small', 'Medium', 'Large', 'Grid Size']));
check('Grid Size sets both rows and columns, starting from the size before it, and warns of very small keys', () => {
  assert.deepEqual(r.customFields, ['3', '8']);
  assert.equal(r.customWarned, true);
});
check('Add writes the pairing, keyed by the screen, and a Medium panel in the active profile only', () => {
  assert.equal(r.written, true);
  const { panel, ...rest } = r.config.decks[KEY].virtual;
  assert.deepEqual(rest, { output: 'DP-4', touch: ILITEK });
  assert.equal(panel.preset, 'medium', 'the size chosen is the deck\'s default');
  assert.equal(panel.controls.length, 24);
  assert.deepEqual(panel.size, { width: 1920, height: 720 });
  const layout = r.config.profiles.default.layouts[KEY];
  assert.ok(layout, 'a layout in the active profile');
  assert.equal(layout.panel, undefined, 'no panel on the layout: pages have their own');
  assert.deepEqual(layout.pages[layout.startPage].panel, panel, 'its first page has the deck\'s default grid');
  assert.equal(r.config.profiles.second.layouts[KEY], undefined, 'another profile gets its layout from the editor');
  assert.match(r.notice ?? '', /HD Display is a virtual deck, paired with ILITEK Multi-Touch-V3000\. Its keys are in the editor, in “Default”\./);
});
check('a profile made after the deck: one blank page at the deck\'s default grid, never zero keys', () => {
  assert.equal(r.laterMade, true);
  assert.ok(r.laterLayout, 'the deck has a layout in it');
  assert.equal(r.laterLayout.panel, undefined);
  assert.deepEqual(Object.values(r.laterLayout.pages).map((p) => [Object.keys(p.buttons).length, p.panel?.controls.length]), [[0, 24]], 'one blank page, 24 keys');
  assert.equal(r.laterDefault.controls.length, 24);
});
check('Settings lists no sizes or layouts: every page has its own, changed on the page', () => assert.equal(r.sizeRows, 0));
check('the list shows it, with one row: no size rows', () => {
  assert.match(r.row.text, /GRA-6e4e|HD Display/);
  assert.match(r.row.detail, /^DP-4 · not connected$/);
  assert.equal(r.row.rows, 1);
});
check('Turn off and on: disabled with the screen not connected; turned off elsewhere, the row says so and offers Turn on, which turns it on', () => {
  assert.deepEqual(r.powerWhileUnplugged, { text: 'Turn off', disabled: true });
  assert.equal(r.offShown, true, `row: ${r.offDetail}`);
  assert.equal(r.offDetail, "DP-4 · turned off: its screen and touchscreen are the desktop's until it is turned on");
  assert.deepEqual(r.offButton, { text: 'Turn on', disabled: false });
  assert.equal(r.onAgain, true);
  assert.equal(r.onStatus, 'not off');
});
check('Remove takes away the pairing only: the layouts stay', () => {
  assert.equal(r.removed, true);
  const kept = r.afterRemove.profiles.default.layouts[KEY];
  assert.equal(kept?.pages[kept.startPage]?.panel?.controls.length, 24, 'its page keeps its grid');
  assert.equal(r.rowGone, true);
});

check('added again after Remove: no size asked, its kept layout used, and said so', () => {
  assert.equal(r.readded, true);
  assert.equal(r.readdedAskedSize, false);
  assert.equal(r.readdedNotice, true);
  assert.equal(r.readdedControls, 24, 'the 3 × 8 its page had');
  assert.equal(r.rulesAfterReadd, true, 'and its touchscreen\'s rule back');
});

// THE MAIN WINDOW, WITH THE DECK CONNECTED — through the real virtual driver
// and the fake helper, whose frames say what the deck was sent.
const inEditor = (expr) => inPage(editor, 'editor', expr);
const inEditorExists = (selector) => inEditor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const clickEditor = (selector) => inEditor(clickIn(selector));
const typeInto = (selector, value) =>
  inEditor(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const rightClickTab = (name) =>
  inEditor(`(() => { const t = document.querySelector('[data-tab=${JSON.stringify(name)}]'); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
const gridKeys = () => inEditor("document.querySelectorAll('.well [data-key]').length");
const pageOnDisk = async (name) => {
  const layout = (await onDisk()).profiles.default.layouts[KEY];
  const entry = Object.entries(layout.pages).find(([, p]) => (p.name ?? '') === name);
  return entry ? { id: entry[0], ...entry[1] } : null;
};
const panelSession = () => daemon.sessions.get(KEY);
/** What the deck was sent from frame `from` on: canvases and key images. */
const sentSince = async (from) => {
  const f = (await frames()).slice(from);
  return { canvases: f.filter((x) => x.type === 'K').length, images: f.filter((x) => x.type === 'I').length };
};

// Two keys on its first page: k1 (row 0, column 0) and k24 (row 2, column 7).
const withKeys = await onDisk();
const firstLayout = withKeys.profiles.default.layouts[KEY];
firstLayout.pages[firstLayout.startPage].buttons = { k1: { label: 'Stays' }, k24: { label: 'Corner' } };
await fs.writeFile(configFile, JSON.stringify(withKeys, null, 2) + '\n');
await until(async () => JSON.stringify(daemon.state.config).includes('Corner'));
const firstPageName = firstLayout.pages[firstLayout.startPage].name;

virtualConfig = () => daemon.state.config;
const panelEntry = (await virtualDriver.list()).find((f) => f.id === KEY);
const panelDevice = await panelEntry.open();
await daemon.attachDevice(KEY, panelDevice);
r.attachedKeys = panelSession().keyCount;
// Two decks connected: SHOW IN EDITOR; show the virtual deck only.
await until(() => inEditorExists('.show-in-editor-trigger'));
await clickEditor('.show-in-editor-trigger');
await until(() => inEditorExists(`[data-show-deck="${KEY}"] .show-in-editor-name`));
await clickEditor(`[data-show-deck="${KEY}"] .show-in-editor-name`);
r.gridAtFirst = await until(async () => (await gridKeys()) === 24);

// CHANGE LAYOUT… on that page: Large (2 × 5) keeps k1, has no place for k24.
await rightClickTab(firstPageName);
r.changeOffered = await until(() => inEditorExists('[data-menu=change-layout]'));
await clickEditor('[data-menu=change-layout]');
await until(() => inEditorExists('[data-change-layout] [data-vd-size=large] input'));
r.changePreselected = await inEditor("document.querySelector('[data-change-layout] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
await clickEditor('[data-change-layout] [data-vd-size=large] input');
r.changeDropped = await until(() => inEditorExists('[data-change-dropped]'));
r.changeDroppedText = await inEditor("document.querySelector('[data-change-dropped]')?.textContent ?? null");
r.changeNotYet = (await pageOnDisk(firstPageName)).panel.controls.length;
const beforeChange = (await frames()).length;
await clickEditor('[data-change-layout-apply]');
r.changed = await until(async () => (await pageOnDisk(firstPageName)).panel.controls.length === 10);
r.changedButtons = (await pageOnDisk(firstPageName)).buttons;
r.changedDefault = (await onDisk()).decks[KEY].virtual.panel.controls.length;
r.changedGrid = await until(async () => (await gridKeys()) === 10);
r.changedDeck = await until(async () => panelSession().keyCount === 10 && (await sentSince(beforeChange)).images >= 10);
r.changedSent = await sentSince(beforeChange);

// NEW PAGE: the grids, the last choice on this deck (Large) preselected; Small picked.
const addPage = async (name, size) => {
  await clickEditor('.tab-add');
  await until(() => inEditorExists('.add-menu-wrap .tab-menu-item'));
  await clickEditor('.add-menu-wrap .tab-menu-item');
  await until(() => inEditorExists('[data-add-page=virtual] [data-vd-size=small] input'));
  const preselected = await inEditor("document.querySelector('[data-add-page] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
  await clickEditor(`[data-add-page=virtual] [data-vd-size=${size}] input`);
  await typeInto('[data-add-page] input[aria-label="New page name"]', name);
  await sleep(100);
  await clickEditor('[data-add-page-submit]');
  await until(async () => (await pageOnDisk(name)) !== null);
  return preselected;
};
r.newPreselected = await addPage('Small page', 'small');
r.newPage = await pageOnDisk('Small page');
r.newSelected = await until(async () => (await inEditor("document.querySelector('.tab-selected')?.dataset.tab ?? null")) === 'Small page');
r.newGrid = await until(async () => (await gridKeys()) === 40);
// Shown on the deck: a page with another grid is a new canvas, then every key.
r.newOnDeck = await until(async () => panelSession().currentPage() === r.newPage.id && panelSession().keyCount === 40);
await sleep(400);
r.secondPreselected = await addPage('Large two', 'large');
r.largeTwo = await pageOnDisk('Large two');
await until(async () => panelSession().currentPage() === r.largeTwo.id);
await sleep(400);
// Between two pages of the same grid: no canvas — the screen is not cleared.
const beforeSame = (await frames()).length;
await clickEditor(`[data-tab="${firstPageName}"]`);
r.sameGridSwitch = await until(async () => panelSession().currentPage() === firstLayout.startPage);
await sleep(400);
r.sameGridSent = await sentSince(beforeSame);
// To the 4 × 10 page: one canvas, its 40 keys.
const beforeOther = (await frames()).length;
await clickEditor('[data-tab="Small page"]');
await until(async () => panelSession().currentPage() === r.newPage.id && (await sentSince(beforeOther)).images >= 40);
await sleep(400);
r.otherGridSent = await sentSince(beforeOther);

// CHANGE LAYOUT… FROM THE HEADER (the frame round, 2026-11-18): a button beside the
// Page ▾, opening the same card for the page the deck shows.
const headerChange = (serial) => `[data-deck-panel="${serial}"] .deck-panel-change-layout`;
const cancelChange = () => inEditor("[...document.querySelectorAll('[data-change-layout] button')].find((b) => b.textContent === 'Cancel')?.click(), true");
r.headerChangeOffered = await until(() => inEditorExists(headerChange(KEY)));
r.headerChangeBesidePage = await inEditor(
  `document.querySelector(${JSON.stringify(headerChange(KEY))})?.nextElementSibling?.classList.contains('deck-panel-page') ?? false`,
);
await clickEditor(headerChange(KEY));
r.headerChangeOpened = await until(() => inEditorExists('[data-change-layout="Small page"] [data-vd-size] input:checked'));
r.headerChangePreselected = await inEditor("document.querySelector('[data-change-layout] [data-vd-size] input:checked')?.closest('[data-vd-size]').dataset.vdSize ?? null");
await cancelChange();
await until(async () => !(await inEditorExists('[data-change-layout]')));
// Both decks shown, the Stream Deck focused: the virtual deck's button focuses it and opens its card.
await clickEditor('.show-in-editor-trigger');
await until(() => inEditorExists(`[data-show-deck="${XL}"] input`));
await clickEditor(`[data-show-deck="${XL}"] input`);
await inEditor("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true");
await until(() => inEditorExists(`[data-deck-panel="${XL}"] .deck-panel-name`));
await clickEditor(`[data-deck-panel="${XL}"] .deck-panel-name`);
await until(async () => (await inEditor("document.querySelector('.deck-panel-focused')?.dataset.deckPanel ?? null")) === XL);
r.xlHeaderChange = await inEditorExists(headerChange(XL));
await clickEditor(headerChange(KEY));
r.headerChangeFocused = await until(async () => (await inEditor("document.querySelector('.deck-panel-focused')?.dataset.deckPanel ?? null")) === KEY);
r.headerChangeOpenedOther = await until(() => inEditorExists('[data-change-layout="Small page"]'));
await cancelChange();
await until(async () => !(await inEditorExists('[data-change-layout]')));

// A STREAM DECK gets none of it: its page menu has no Change layout, New page no grids.
await clickEditor('.show-in-editor-trigger');
await until(() => inEditorExists(`[data-show-deck="${XL}"] .show-in-editor-name`));
await clickEditor(`[data-show-deck="${XL}"] .show-in-editor-name`);
await until(async () => (await inEditor("document.querySelector('.show-in-editor-trigger')?.dataset.deck ?? null")) === XL);
await rightClickTab('Main');
await until(() => inEditorExists('.tab-menu-item.danger'));
r.xlChangeOffered = await inEditorExists('[data-menu=change-layout]');
await inEditor("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true");
await clickEditor('.tab-add');
await until(() => inEditorExists('.add-menu-wrap .tab-menu-item'));
await clickEditor('.add-menu-wrap .tab-menu-item');
await until(() => inEditorExists('.add-page input'));
r.xlPicker = await inEditorExists('[data-add-page=virtual], .add-page [data-vd-size]');

check('connected: the deck attaches with its first page\'s grid, and the editor draws it', () => {
  assert.equal(r.attachedKeys, 24);
  assert.equal(r.gridAtFirst, true);
});
check('Change layout… is in a virtual deck\'s page menu, with the page\'s grid preselected', () => {
  assert.equal(r.changeOffered, true);
  assert.equal(r.changePreselected, 'medium');
});
check('…a grid that drops a key names it, and nothing changes until confirmed', () => {
  assert.equal(r.changeDropped, true);
  assert.match(r.changeDroppedText ?? '', /1 key has no place in that grid and will be removed from this page: “Corner” \(key 24\)\./);
  assert.equal(r.changeNotYet, 24);
});
check('…confirmed: only that page changes, keys by row and column; the deck\'s default is untouched; the deck re-lays out', () => {
  assert.equal(r.changed, true);
  assert.deepEqual(r.changedButtons, { k1: { label: 'Stays' } });
  assert.equal(r.changedDefault, 24);
  assert.equal(r.changedGrid, true, 'the editor draws the 2 × 5');
  assert.equal(r.changedDeck, true, 'the deck has its 10 keys');
  assert.equal(r.changedSent.canvases, 1, JSON.stringify(r.changedSent));
});
check('New page on a virtual deck offers the grids, the last choice on this deck preselected', () => {
  assert.equal(r.newPreselected, 'large', 'Change layout\'s Large');
  assert.equal(r.secondPreselected, 'small', 'then New page\'s Small');
  assert.equal(r.newPage?.panel?.controls.length, 40);
  assert.equal(r.newPage?.panel?.preset, 'small');
  assert.equal(r.largeTwo?.panel?.preset, 'large');
});
check('…the new page is selected, drawn at its own grid in the editor, and shown on the deck at it', () => {
  assert.equal(r.newSelected, true);
  assert.equal(r.newGrid, true);
  assert.equal(r.newOnDeck, true);
});
check('a page change between two pages of the same grid sends no canvas: the screen is not cleared', () => {
  assert.equal(r.sameGridSwitch, true);
  assert.equal(r.sameGridSent.canvases, 0, JSON.stringify(r.sameGridSent));
  assert.ok(r.sameGridSent.images <= 10, JSON.stringify(r.sameGridSent));
});
check('a page change to another grid: one canvas, then every key of the new page, once', () =>
  assert.deepEqual(r.otherGridSent, { canvases: 1, images: 40 }));
check('Change layout… is a button in the virtual deck\'s header, beside its Page ▾, opening the card for the page shown', () => {
  assert.equal(r.headerChangeOffered, true);
  assert.equal(r.headerChangeBesidePage, true);
  assert.equal(r.headerChangeOpened, true);
  assert.equal(r.headerChangePreselected, 'small');
});
check('…on a deck not being edited, it focuses that deck and opens its card; a Stream Deck\'s header has none', () => {
  assert.equal(r.xlHeaderChange, false);
  assert.equal(r.headerChangeFocused, true);
  assert.equal(r.headerChangeOpenedOther, true);
});
check('a Stream Deck\'s page menu has no Change layout, and its New page no grids', () => {
  assert.equal(r.xlChangeOffered, false);
  assert.equal(r.xlPicker, false);
});

// NO TOUCHSCREEN: unplugged, and the page shown afresh — no Add, and said so.
for (const node of ILITEK_NODES) await sysfs.unplugNode(node.event);
await inPage(editor, 'settings', clickIn('[data-settings-nav=general]'));
await sleep(200);
await inPage(editor, 'settings', clickIn('[data-settings-nav=decks]'));
r.noTouchscreen = await until(() => exists(editor, '[data-vd=look-again]'));
r.noTouchscreenAdd = await exists(editor, '[data-vd=add]');
check('no touchscreen connected: no Add, a note that none was found, and Look again', () => {
  assert.equal(r.noTouchscreen, true);
  assert.equal(r.noTouchscreenAdd, false);
});

editor.child.kill();
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
