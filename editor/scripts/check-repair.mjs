// A virtual deck whose pairing does not fit this computer — a config restored
// from another computer, or its touchscreen moved to another USB port — end to
// end in real Electron. Found by the maintainer, 2026-11-26: after importing an
// export made on another computer, the deck's panel showed but touch did not
// work, Settings named the other computer's connector and said its touchscreen
// was not connected (it was, on another port), and Tap again did nothing useful.
//
// The daemon is the control harness's, with the real virtual driver and a scan
// as the daemon's (a deck no longer listed is closed; one listed is opened),
// over a scratch /sys/class/drm and /sys/class/input: the panel's screen on
// DP-7 here, its touchscreen on this computer's own USB port. In the order it
// happened: the deck paired here, touch working; then a config from the other
// computer written over it, as an import writes it — the deck on DP-4, the
// touchscreen on that computer's port. The display helper is
// scripts/test/fake-panel.mjs, the root helper the real
// udev/deckhand-touch-access in its test mode, logind a fake.
//
// - The pairing from elsewhere: the panel stays on the screen it is on;
//   touch is "needs pairing on this computer", never "not connected" or broken;
//   Settings names the connector it is on now, and offers Tap again.
// - Tap again pairs on the screen the deck is on now, and repairs the deck in
//   place: the connector and the touchscreen stored afresh, the layouts and
//   everything else untouched; touch works, with no Remove and Add.
// - A restore on the same computer, its pairing fitting: touch works as
//   before, with nothing asked — no password, no pairing.
// - The touchscreen unplugged: "its touchscreen is not connected", as before.
//
// Usage: npm run check:repair   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_REPAIR_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-repair-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const socks = path.join(scratch, 'socks');
const panelLog = path.join(scratch, 'panel.log');
await fs.mkdir(configDir);
await fs.mkdir(socks);

const { edid, fakeSysfs, ILITEK } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-sysfs.mjs')).href);
const sysfs = fakeSysfs(scratch);
// HERE is this computer: the panel's screen on DP-7, its touchscreen (and the
// touchscreen's mouse twin) on a USB port of this computer's own. The config's
// pairing is ILITEK, on the other computer's port: the same model, elsewhere.
const HERE = 'DP-7';
const HERE_PATH = 'pci-0000:00:08.1-usb-0:4:1.0';
await sysfs.plug(HERE, 'connected', edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }), ['1920x720']);
await sysfs.plug('HDMI-A-1', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN', name: 'HP E243', widthMm: 527, heightMm: 296 }), ['1920x1080']);
await sysfs.usbDevice('pci0/usb1/1-4', '222a');
const TOUCH_NODES = [
  { event: 'event15', minor: 79, physical: 'pci0/usb1/1-4', parent: '1-4:1.0/0003:222A:0001.0005', input: 'input20', name: 'ILITEK Multi-Touch-V3000', vendor: '222a', product: '0001', direct: true, udev: { ID_INPUT: 1, ID_INPUT_TOUCHSCREEN: 1, ID_PATH: HERE_PATH } },
  { event: 'event16', minor: 80, physical: 'pci0/usb1/1-4', parent: '1-4:1.1/0003:222A:0001.0006', input: 'input21', name: 'ILITEK Multi-Touch-V3000 Mouse', vendor: '222a', product: '0001', abs: '3', readable: false, udev: { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_PATH: 'pci-0000:00:08.1-usb-0:4:1.1' } },
];
for (const node of TOUCH_NODES) await sysfs.inputNode(node);
assert.notEqual(ILITEK.path, HERE_PATH, 'the pairing in the config is another port');

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
  DECKHAND_PAIR_MS: '5000',
  // logind is a fake on this run's private bus, so touch can be "ready".
  DBUS_SYSTEM_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
});
const { startFakeLogind } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-logind.mjs')).href);
const logind = await startFakeLogind(process.env.DBUS_SESSION_BUS_ADDRESS);
const { connect, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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

const KEY = 'GRA-6e4e';
const panel = makePanel({ width: 1920, height: 720, widthMm: 243, heightMm: 91 }, 'medium');
// As the other computer saved it: its connector, its touchscreen's port.
const FROM_ELSEWHERE = {
  version: 2,
  decks: { [KEY]: { name: 'Panel', virtual: { output: 'DP-4', touch: ILITEK, panel } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [KEY]: { startPage: 'main', pages: { main: { name: 'Main', panel, buttons: { k1: { label: 'Kept' }, k24: { label: 'Also kept' } } } } } },
    },
  },
  startProfile: 'default',
};
// As it was before the import: paired on this computer, touch working.
const PAIRED_HERE = structuredClone(FROM_ELSEWHERE);
PAIRED_HERE.decks[KEY].virtual = { output: HERE, touch: { vendor: '222a', product: '0001', path: HERE_PATH }, panel };
PAIRED_HERE.profiles.default.layouts[KEY].pages.main.buttons = { k1: { label: 'Before the import' } };
const configFile = path.join(configDir, 'config.json');
await fs.writeFile(configFile, JSON.stringify(PAIRED_HERE, null, 2) + '\n');
const onDisk = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));

const daemon = await startDaemon(scratch, PAIRED_HERE, {});
const driver = createVirtualDriver(() => daemon.state.config);
daemon.deps.virtual = driver;
/** The daemon's scan, for the one virtual deck: a deck no longer listed is closed; one listed and not open is opened. */
let scanning = Promise.resolve();
const scan = () =>
  (scanning = scanning.then(async () => {
    const entry = (await driver.list()).find((f) => f.id === KEY);
    const session = daemon.sessions.get(KEY);
    if (!entry && session) {
      daemon.sessions.delete(KEY);
      await session.close();
      daemon.events.state();
    } else if (entry && !session) {
      const device = await entry.open();
      if (device) await daemon.attachDevice(KEY, device);
    } else daemon.events.state();
  }));
const stopDriverWatch = driver.watch(() => void scan());
// As src/index.ts: every reload is followed by a scan, which gives a running deck its pairing afresh.
const stopWatching = await reloadLikeTheDaemon(daemon, { onReload: () => void scan() });
await scan();

const socketClient = await connect(daemon.socket);
const touchNow = async () => (await socketClient.request('status')).result.decks.find((d) => d.serial === KEY)?.touch ?? null;

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

// The root helper's world, as check:virtual's: the panel's touchscreen, a keyboard, stand-ins for udevadm and the ACL tools.
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
await fs.writeFile(path.join(ht, 'pkexec'), script(`echo "\${@:2}" >> "${pkexecLog}"; exec env PKEXEC_UID="$(id -u)" DECKHAND_TOUCH_ACCESS_TEST="${ht}" bash "$@"`), { mode: 0o755 });
env.DECKHAND_TOUCH_ACCESS = path.join(repoRoot, 'udev/deckhand-touch-access');
env.DECKHAND_PKEXEC = path.join(ht, 'pkexec');
const pkexecRuns = async () => (await fs.readFile(pkexecLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);

// Every frame the fake helper logged, but not the idle probe Settings starts (`--idle-probe`, no output): only panels.
const frames = async () =>
  (await fs.readFile(panelLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((f) => f.type !== 'start' || !f.output.startsWith('/'));
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const exists = (selector) => inPage(editor, 'settings', `document.querySelector(${JSON.stringify(selector)}) !== null`);
const rowDetail = () => inPage(editor, 'settings', `document.querySelector('[data-vd-deck="${KEY}"] .sp-row-detail')?.textContent ?? null`);
const tapAgainButton = () => inPage(editor, 'settings', `(() => { const b = document.querySelector('[data-vd-deck="${KEY}"] [data-vd=tap-again]'); return b ? { disabled: b.disabled } : null; })()`);
const noticeText = () => inPage(editor, 'settings', "document.querySelector('[data-vd-notice]')?.textContent ?? null");
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
await until(() => exists(`[data-vd-deck="${KEY}"]`));

// PAIRED HERE: touch works.
r.beforeTouch = (await until(async () => (await touchNow()) === 'ready', 5000)) ? 'ready' : await touchNow();

// THE IMPORT: the other computer's config written over it, as an import writes it.
await fs.writeFile(configFile, JSON.stringify(FROM_ELSEWHERE, null, 2) + '\n');
await until(async () => JSON.stringify(daemon.state.config).includes('Also kept'));
await until(async () => !['ready', 'opening', null].includes(await touchNow()), 5000);
r.shownOn = (await frames()).filter((f) => f.type === 'start').map((f) => f.output);
r.elsewhereTouch = await touchNow();
await until(async () => /needs pairing/.test((await rowDetail()) ?? ''), 3000);
r.elsewhereRow = await rowDetail();
r.elsewhereButton = await tapAgainButton();

// TAP AGAIN.
const layoutsBefore = (await onDisk()).profiles;
const startsBefore = (await frames()).filter((f) => f.type === 'start').length;
const runsBefore = (await pkexecRuns()).length;
await inPage(editor, 'settings', clickIn(`[data-vd-deck="${KEY}"] [data-vd=tap-again]`));
// Either the "Tap this screen" panel on some connector, or a notice: whichever comes.
await until(async () => (await frames()).filter((f) => f.type === 'start').length > startsBefore || (await noticeText()) !== null, 10_000);
await sleep(300);
const startsAfter = (await frames()).filter((f) => f.type === 'start').slice(startsBefore);
r.tapPanelOn = startsAfter.map((f) => f.output);
r.tapPassword = (await pkexecRuns()).slice(runsBefore);
r.tapNoticeEarly = await noticeText();
if (r.tapPanelOn.includes(HERE)) {
  await tapOn(HERE, `${sysfs.dev}/event15`);
  r.repaired = await until(async () => (await onDisk()).decks[KEY].virtual.output === HERE, 8000);
  await until(async () => (await noticeText()) !== null);
  r.tapNotice = await noticeText();
  r.after = await onDisk();
  r.afterTouch = (await until(async () => (await touchNow()) === 'ready', 8000)) ? 'ready' : await touchNow();
  r.afterRow = (await until(async () => (await rowDetail()) === `${HERE} · touch works`, 5000)) ? `${HERE} · touch works` : await rowDetail();
  r.layoutsKept = JSON.stringify(r.after.profiles) === JSON.stringify(layoutsBefore);
}

// A RESTORE ON THE SAME COMPUTER: a config whose pairing fits — the one just
// repaired, with a key's label changed so it reloads — written whole, as a
// restore writes it. Touch works as before, and nothing is asked.
if (r.repaired) {
  const restored = structuredClone(r.after);
  restored.profiles.default.layouts[KEY].pages.main.buttons.k1.label = 'Restored';
  const runsBeforeRestore = (await pkexecRuns()).length;
  const startsBeforeRestore = (await frames()).filter((f) => f.type === 'start').length;
  await fs.writeFile(configFile, JSON.stringify(restored, null, 2) + '\n');
  await until(async () => JSON.stringify(daemon.state.config).includes('Restored'));
  await scan();
  await until(async () => (await touchNow()) === 'ready', 5000);
  r.restoreTouch = await touchNow();
  await until(async () => (await rowDetail()) === `${HERE} · touch works`, 5000);
  r.restoreRow = await rowDetail();
  r.restoreAsked = { password: (await pkexecRuns()).length - runsBeforeRestore, pairing: (await frames()).filter((f) => f.type === 'start').length - startsBeforeRestore };
  r.restorePairing = (await onDisk()).decks[KEY].virtual;

  // UNPLUGGED, with a pairing that fits: not connected, as before.
  for (const node of TOUCH_NODES) await sysfs.unplugNode(node.event);
  await scan();
  await until(async () => (await touchNow()) === 'missing', 3000);
  r.unpluggedTouch = await touchNow();
  await until(async () => /not connected/.test((await rowDetail()) ?? ''), 3000);
  r.unpluggedRow = await rowDetail();
}

check('paired here first: touch works', () => assert.equal(r.beforeTouch, 'ready'));
check('the pairing from elsewhere imported: the panel stays on the screen it is on, never restarted', () => assert.deepEqual(r.shownOn, [HERE]));
check('…touch says it needs pairing on this computer, never not connected or broken', () => assert.equal(r.elsewhereTouch, 'not-paired'));
check('…Settings names the connector it is on now, says it needs pairing on this computer, and offers Tap again', () => {
  assert.equal(r.elsewhereRow, `${HERE} · needs pairing with its touchscreen on this computer: Tap again`);
  assert.deepEqual(r.elsewhereButton, { disabled: false });
});
check('Tap again pairs on the screen the deck is on now, after the password', () => {
  assert.equal(r.tapNoticeEarly, null, `a notice instead: ${r.tapNoticeEarly}`);
  assert.deepEqual(r.tapPanelOn, [HERE]);
  assert.deepEqual(r.tapPassword, ['pair']);
});
check('…and repairs the deck in place: the connector and touchscreen stored afresh, nothing else changed', () => {
  assert.equal(r.repaired, true);
  assert.deepEqual(r.after.decks[KEY].virtual, { output: HERE, touch: { vendor: '222a', product: '0001', path: HERE_PATH }, panel });
  assert.equal(r.after.decks[KEY].name, 'Panel');
  assert.equal(r.layoutsKept, true, 'the layouts untouched');
  assert.match(r.tapNotice ?? '', /is paired with ILITEK Multi-Touch-V3000\./);
});
check('…touch works, and Settings says so on the connector it is on', () => {
  assert.equal(r.afterTouch, 'ready');
  assert.equal(r.afterRow, `${HERE} · touch works`);
});
check('a restore on the same computer, its pairing fitting: touch works, and no password or pairing is asked', () => {
  assert.equal(r.restoreTouch, 'ready');
  assert.equal(r.restoreRow, `${HERE} · touch works`);
  assert.deepEqual(r.restoreAsked, { password: 0, pairing: 0 });
  assert.deepEqual(r.restorePairing, { output: HERE, touch: { vendor: '222a', product: '0001', path: HERE_PATH }, panel });
});
check('the touchscreen unplugged, its pairing fitting: not connected, as before', () => {
  assert.equal(r.unpluggedTouch, 'missing');
  assert.equal(r.unpluggedRow, `${HERE} · its touchscreen is not connected`);
});

console.log(`\nrecorded: ${JSON.stringify({ ...r, after: undefined }, null, 0)}`);
editor.child.kill();
socketClient.close();
stopWatching();
stopDriverWatch();
await daemon.stop();
await logind.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
