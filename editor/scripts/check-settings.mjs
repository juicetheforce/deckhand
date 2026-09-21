// Ship piece 3: the settings window, end to end in real Electron.
//
// Driven like check-tray.mjs (scripts/lib/drive-editor.mjs), on a private bus.
// The settings window is opened by clicking the editor's gear, and every
// setting is changed by using its control in the settings window's page. What
// is checked from outside the page: preferences.json on disk, the accent on
// the editor's root element, how many windows exist, and whether closing the
// editor quits.
//
// The config lists the V2 before the XL, as the maintainer's does, so Automatic opens
// on the V2 — the reason the Default deck setting exists.
//
// Usage: npm run check:settings   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_SETTINGS_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-settings-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const prefsFile = path.join(stateDir, 'editor', 'preferences.json');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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

const XL = 'SETTINGS-XL';
const V2 = 'SETTINGS-V2';
const page = { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } };
const CONFIG = {
  decks: { [V2]: { name: 'Deck V2' }, [XL]: { name: 'Deck XL' } },
  profiles: { default: { name: 'Default', layouts: { [V2]: page, [XL]: page } } },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Stream Deck' }));
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;
const startEditor = () => startEditorAt(electronPath, editorRoot, env);

const prefs = async () => {
  try {
    return JSON.parse(await fs.readFile(prefsFile, 'utf8'));
  } catch {
    return {};
  }
};
/** The deck the editor has open: the toolbar's Device dropdown, once it is connected and has followed the deck. */
async function openDeck(editor) {
  await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);
  await sleep(300);
  return inPage(editor, 'editor', "document.querySelectorAll('.toolbar select')[1].value");
}
const editorAccent = (editor) => inPage(editor, 'editor', "document.documentElement.dataset.accent ?? 'blue'");
const clickGear = (editor) => inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
const setSelect = (value) =>
  `(() => { const s = document.querySelector('#settings-default-deck'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const clickButton = (text) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); return true; })()`;
async function openSettings(editor) {
  await clickGear(editor);
  await until(async () => (await stateOf(editor)).settingsOpen);
  await until(async () => (await inPage(editor, 'settings', "document.querySelector('.settings-footer') !== null")) === true);
}

const r = {};
const editor = startEditor();
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);

// Automatic: the first connected deck with a layout — the V2.
r.automaticOpensOn = await openDeck(editor);

// The gear opens the settings window; clicking it again brings that one forward.
await openSettings(editor);
await clickGear(editor);
await sleep(300);
r.windowsWithSettings = (await stateOf(editor)).windows;
r.shown = await inPage(
  editor,
  'settings',
  `({
    deckOptions: [...document.querySelectorAll('#settings-default-deck option')].map((o) => o.textContent),
    deckValue: document.querySelector('#settings-default-deck').value,
    closeToTray: document.querySelector('#settings-close-to-tray').checked,
    subtitle: document.querySelector('#settings-close-to-tray').closest('.settings-row').querySelector('.settings-sub').textContent,
    accentChecked: document.querySelector('[role=radio][aria-checked=true]').dataset.accentSwatch,
    title: document.title,
  })`,
);

// The editor window cannot change settings, even through the bridge.
// Read back from main, not preferences.json: the file is written 400 ms after
// a change, so reading it straight away passed whatever the guard did.
r.editorRefused = await inPage(editor, 'editor', "window.deckhand.setAppSettings({ accent: 'teal' }).then(() => window.deckhand.appSettings()).then((s) => s.accent)");

// Default deck → the XL; purple accent — each saved at once, the accent live in the editor.
await inPage(editor, 'settings', setSelect(XL));
r.deckSaved = await until(async () => (await prefs()).defaultDeck === XL);
await inPage(editor, 'settings', clickIn('[data-accent-swatch=purple]'));
r.accentSaved = await until(async () => (await prefs()).accent === 'purple');
r.accentLiveInEditor = await until(async () => (await editorAccent(editor)) === 'purple');
r.accentInSettings = await inPage(editor, 'settings', "document.documentElement.dataset.accent ?? 'blue'");
r.editorStillOnV2 = await openDeck(editor); // a setting changes the next opening, not this one

// Closing the editor takes the settings window with it; reopening opens on the XL, still purple.
editor.send('close');
r.closedToTray = await until(async () => {
  const s = await stateOf(editor);
  return !s.windowOpen && !s.holding && !s.settingsOpen;
});
r.windowsInTray = (await stateOf(editor)).windows;
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.reopensOn = await openDeck(editor);
r.accentAfterReopen = await editorAccent(editor);

// Unplug the XL. The setting still names it — unplugging must not lose the
// choice — but the list offers only what is plugged in, and until the XL is
// back the editor opens as Automatic would. Plugged back in, it opens on the XL.
await daemon.sessions.get(XL).close();
daemon.sessions.delete(XL);
daemon.events.state();
r.unpluggedMovesToV2 = await until(async () => (await openDeck(editor)) === V2);
await openSettings(editor);
r.unpluggedShown = await inPage(
  editor,
  'settings',
  `({ options: [...document.querySelectorAll('#settings-default-deck option')].map((o) => o.textContent), value: document.querySelector('#settings-default-deck').value })`,
);
r.unpluggedStillSaved = (await prefs()).defaultDeck;
await inPage(editor, 'settings', clickButton('Done'));
await until(async () => !(await stateOf(editor)).settingsOpen);
editor.send('close');
await until(async () => !(await stateOf(editor)).windowOpen);
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.unpluggedReopensOn = await openDeck(editor);
await daemon.attach(XL, new FakeDeck());
editor.send('close');
await until(async () => !(await stateOf(editor)).windowOpen);
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.replugReopensOn = await until(async () => (await openDeck(editor)) === XL);

// Reset to defaults: all three back, the accent gone from the editor.
await openSettings(editor);
await inPage(editor, 'settings', clickButton('Reset to defaults'));
r.reset = await until(async () => {
  const p = await prefs();
  return p.defaultDeck === null && p.closeToTray === true && p.accent === 'blue';
});
r.accentAfterReset = await until(async () => (await editorAccent(editor)) === 'blue');
r.resetShown = await inPage(editor, 'settings', "[document.querySelector('#settings-default-deck').value, document.querySelector('#settings-close-to-tray').checked]");

// Done closes the settings window and leaves the editor open.
await inPage(editor, 'settings', clickButton('Done'));
r.doneCloses = await until(async () => {
  const s = await stateOf(editor);
  return !s.settingsOpen && s.windowOpen;
});

// Close to system tray, unticked: closing the editor now quits.
await openSettings(editor);
await inPage(editor, 'settings', clickIn('#settings-close-to-tray'));
r.trayOffSaved = await until(async () => (await prefs()).closeToTray === false);
editor.send('close');
r.quitWhenOff = await until(() => editor.exited !== null);
r.quitCode = editor.exited?.code ?? null;
if (editor.exited === null) editor.child.kill();

check('Automatic opens on the first connected deck with a layout (the V2, first in config)', () => assert.equal(r.automaticOpensOn, V2));
check('the gear opens one settings window; a second click brings it forward rather than opening another', () => assert.equal(r.windowsWithSettings, 2));
check('the settings window shows every deck by name, Automatic, close-to-tray on, blue, and the corrected subtitle', () => {
  assert.deepEqual(r.shown.deckOptions, ['Automatic', 'Deck V2', 'Deck XL']);
  assert.equal(r.shown.deckValue, '');
  assert.equal(r.shown.closeToTray, true);
  assert.equal(r.shown.accentChecked, 'blue');
  assert.match(r.shown.subtitle, /system tray/);
  assert.doesNotMatch(r.shown.subtitle, /keys/i, 'the keys run whatever the editor does');
  assert.equal(r.shown.title, 'Deckhand Settings');
});
check('the editor window cannot change settings through the bridge', () => assert.notEqual(r.editorRefused, 'teal'));
check('each change is saved at once; the accent reaches the editor behind it live, and the settings window too', () => {
  assert.equal(r.deckSaved, true);
  assert.equal(r.accentSaved, true);
  assert.equal(r.accentLiveInEditor, true);
  assert.equal(r.accentInSettings, 'purple');
});
check('changing Default deck does not move the editor that is open', () => assert.equal(r.editorStillOnV2, V2));
check('closing the editor closes the settings window with it', () => {
  assert.equal(r.closedToTray, true);
  assert.equal(r.windowsInTray, 0);
});
check('reopened, the editor opens on the Default deck (the XL), in the chosen accent', () => {
  assert.equal(r.reopensOn, XL);
  assert.equal(r.accentAfterReopen, 'purple');
});
check('with the XL unplugged the setting still names it, but the list offers only the V2 and shows Automatic', () => {
  assert.equal(r.unpluggedMovesToV2, true);
  assert.deepEqual(r.unpluggedShown, { options: ['Automatic', 'Deck V2'], value: '' });
  assert.equal(r.unpluggedStillSaved, XL);
});
check('reopened with the XL unplugged it opens on the first connected deck; with the XL back, on the XL', () => {
  assert.equal(r.unpluggedReopensOn, V2);
  assert.equal(r.replugReopensOn, true);
});
check('Reset to defaults puts all three back, on disk, in the window and in the editor', () => {
  assert.equal(r.reset, true);
  assert.equal(r.accentAfterReset, true);
  assert.deepEqual(r.resetShown, ['', true]);
});
check('Done closes the settings window and leaves the editor open', () => assert.equal(r.doneCloses, true));
check('with Close to system tray unticked, closing the editor quits', () => {
  assert.equal(r.trayOffSaved, true);
  assert.equal(r.quitWhenOff, true);
  assert.equal(r.quitCode, 0);
});

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
