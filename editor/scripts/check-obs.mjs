// OBS in the editor, end to end in real Electron: Settings › Integrations › OBS.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus, against the control harness's daemon (the real socket commands and
// services/obs.ts) and scripts/test/fake-obs.mjs — never a real OBS. What is
// checked from outside the page: credentials.json in the daemon's state
// directory, and config.json.
//
// Usage: npm run check:obs   (builds first; run `npm run build:ts` at the root after changing src/)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_OBS_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-obs-'));
const configDir = path.join(scratch, 'config');
const editorState = path.join(scratch, 'state');
// The daemon's state directory, where credentials.json lives: read when the
// harness is imported, so set first.
const daemonState = path.join(scratch, 'daemon-state');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_STATE_DIR = daemonState;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { startFakeObs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-obs.mjs')).href);
const obs = await import(pathToFileURL(path.join(repoRoot, 'dist/services/obs.js')).href);
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

const PASSWORD = 'correct horse battery staple';
const XL = 'OBS-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { action: { type: 'obs.stream' } }, 1: { label: 'Plain' } } } } } },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);
const fake = await startFakeObs({ password: PASSWORD });

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: editorState,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

const credentialsFile = path.join(daemonState, 'credentials.json');
const credentials = async () => {
  try {
    return JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
  } catch {
    return {};
  }
};
/** A port nothing listens on: taken, then let go. */
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const type = (field, value) =>
  `(() => { const i = document.querySelector('[data-obs-field=${field}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const section = (editor) =>
  inPage(
    editor,
    'settings',
    `(() => { const s = document.querySelector('#settings-obs'); return s && {
      state: s.dataset.obsSection ?? null,
      status: s.querySelector('[data-obs-status]')?.dataset.obsStatus ?? null,
      statusText: s.querySelector('[data-obs-status]')?.textContent ?? null,
      message: s.querySelector('[data-obs-message]')?.textContent ?? null,
      messageKind: s.querySelector('[data-obs-message]')?.dataset.obsMessage ?? null,
      host: s.querySelector('[data-obs-field=host]')?.value ?? null,
      port: s.querySelector('[data-obs-field=port]')?.value ?? null,
      password: s.querySelector('[data-obs-field=password]')?.value ?? null,
      placeholder: s.querySelector('[data-obs-field=password]')?.placeholder ?? null,
      confirm: s.querySelector('[data-obs-confirm]')?.textContent ?? null,
      removable: s.querySelector('[data-obs=remove]') !== null,
      busy: s.querySelector('[data-obs=save]')?.disabled ?? null,
    }; })()`,
  );
/** Click an OBS button, and wait for its answer: the buttons are disabled while it runs. */
async function press(editor, button) {
  await inPage(editor, 'settings', clickIn(`[data-obs=${button}]`));
  await sleep(100);
  await until(async () => (await section(editor))?.busy === false, 10_000);
}
const messageAfter = async (editor, button) => {
  await press(editor, button);
  return (await section(editor)).message;
};

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);

// --- The editor while OBS is not set up -----------------------------------------
const configJson = async () => JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
const buttonsNow = async () => (await configJson()).profiles.default.layouts[XL].pages.main.buttons;
const editorFace = () =>
  inPage(
    editor,
    'editor',
    `(() => {
      const row = (t) => document.querySelector('.library-entry[data-action-type="' + t + '"]');
      const key0 = document.querySelector('.key[data-key-index="0"]');
      return {
        obsRows: ['obs.stream', 'obs.record', 'obs.recordPause'].map((t) => row(t)?.dataset.notSetUp === 'true'),
        obsTitle: row('obs.record')?.title ?? null,
        hotkeyBlocked: row('hotkey')?.dataset.notSetUp ?? null,
        keyUnset: key0?.classList.contains('key-unset') ?? null,
        keyBadge: key0?.querySelector('.key-unset-badge') !== null,
        keyFailedBadge: key0?.querySelector('.key-failed:not(.key-unset-badge)') !== null,
        callout: document.querySelector('.inspector [data-not-set-up=obs]')?.textContent ?? null,
      };
    })()`,
  );
/**
 * Drag a library row onto a key, as checks.ts does: pointer events at the row
 * and the key's centres. The row is scrolled into view first — off-screen,
 * elementFromPoint finds nothing and the press never reaches it — and the
 * drag refuses to run unless the press would land on that row. Resolves true,
 * or with why not. (No // comments in the page script: inPage joins it onto
 * one line.)
 */
const dragRow = (type, to) =>
  inPage(
    editor,
    'editor',
    `(async () => {
      const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      const pointer = (kind, x, y) => (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true }));
      const row = document.querySelector('.library-entry[data-action-type="${type}"]');
      row.scrollIntoView({ block: 'center' });
      const a = centre(row);
      const pressed = document.elementFromPoint(a.x, a.y)?.closest('[data-action-type]')?.dataset.actionType;
      if (pressed !== '${type}') return 'the press would land on ' + pressed + ', not the ${type} row';
      const b = centre(document.querySelector('.key[data-key-index="${to}"]'));
      pointer('pointerdown', a.x, a.y);
      pointer('pointermove', a.x + 10, a.y + 10);
      pointer('pointermove', b.x, b.y);
      await new Promise((r) => setTimeout(r, 50));
      pointer('pointerup', b.x, b.y);
      return true;
    })()`,
  );

await until(async () => (await editorFace()).obsRows.every(Boolean));
await inPage(editor, 'editor', clickIn('.key[data-key-index="0"]'));
await until(async () => (await editorFace()).callout !== null);
r.notSetUpFace = await editorFace();
// A drag of an OBS action places nothing; a Hotkey dragged the same way does — the control.
r.obsDragStarted = await dragRow('obs.record', 2);
await sleep(600);
r.obsDragged = (await buttonsNow())['2'] ?? null;
r.hotkeyDragStarted = await dragRow('hotkey', 3);
r.hotkeyDragged = await until(async () => (await buttonsNow())['3']?.action?.type === 'hotkey');
// A click on it, with a key selected, does not retarget the key: it opens Settings at OBS.
await inPage(editor, 'editor', clickIn('.key[data-key-index="1"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="obs.record"]'));
r.clickOpensSettings = await until(async () => (await stateOf(editor)).settingsOpen);
await sleep(400);
r.clickedKey1 = (await buttonsNow())['1'] ?? null;

// The editor window opens Settings at the OBS section: the deep link a not-set-up action uses.
await inPage(editor, 'editor', "window.deckhand.openSettings('obs').then(() => true)");
await until(async () => (await stateOf(editor)).settingsOpen);
await until(async () => (await section(editor))?.state != null);
r.opened = await section(editor);
r.deepLink = await inPage(
  editor,
  'settings',
  `(() => { const s = document.querySelector('#settings-obs').getBoundingClientRect(); return { inView: s.top >= 0 && s.top < window.innerHeight, focused: document.activeElement?.dataset.obsField ?? null, headings: [...document.querySelectorAll('.settings-heading')].map((h) => h.textContent) }; })()`,
);

// Test connection: says which thing is wrong, and saves nothing.
r.testNoPassword = await messageAfter(editor, 'test');
await inPage(editor, 'settings', type('port', String(fake.port)));
r.testNoPasswordRightPort = await messageAfter(editor, 'test');
await inPage(editor, 'settings', type('password', 'wrong'));
r.testWrong = await messageAfter(editor, 'test');
await inPage(editor, 'settings', type('password', PASSWORD));
r.testRight = await messageAfter(editor, 'test');
r.afterTest = { section: await section(editor), credentials: await credentials() };

// Save with OBS there: set up, connected, and the password never comes back.
r.saved = await messageAfter(editor, 'save');
r.afterSave = { section: await section(editor), credentials: await credentials() };
r.statusHasNoSecret = !JSON.stringify(await inPage(editor, 'settings', 'window.deckhand.obsStatus()')).includes(PASSWORD);
r.pageHasNoSecret = !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(PASSWORD);

// The editor window cannot save, test or remove: Settings only.
r.editorCannotSave = await inPage(editor, 'editor', `window.deckhand.obsSave({ port: 1 }).then((x) => x.ok === false)`);
r.editorCannotRemove = await inPage(editor, 'editor', `window.deckhand.obsRemove().then((x) => x.ok === false)`);
r.portUntouched = (await credentials()).obs?.port === fake.port;

// Save with OBS not there: saved, and says the keys will connect once it runs.
const closedPort = await freePort();
const realObs = await obs.obsIsRunning();
await inPage(editor, 'settings', type('port', String(closedPort)));
r.savedOff = await messageAfter(editor, 'save');
r.savedOffSetUp = (await credentials()).obs?.port === closedPort && (await credentials()).obs?.password === PASSWORD;
// A process named obs and nothing listening: the server is off, and where to turn it on.
const obsBin = path.join(scratch, 'obs');
await fs.copyFile('/usr/bin/sleep', obsBin);
await fs.chmod(obsBin, 0o755);
const obsProcess = spawn(obsBin, ['30'], { stdio: 'ignore' });
await sleep(100);
r.testServerOff = await messageAfter(editor, 'test');
obsProcess.kill();
await inPage(editor, 'settings', type('port', String(fake.port)));
await press(editor, 'save');

// Remove: asks first, saying what it costs; Keep keeps it.
await inPage(editor, 'settings', clickIn('[data-obs=remove]'));
r.confirm = (await section(editor)).confirm;
await inPage(editor, 'settings', clickIn('[data-obs=keep]'));
r.kept = { section: await section(editor), credentials: await credentials() };
await inPage(editor, 'settings', clickIn('[data-obs=remove]'));
await press(editor, 'confirm-remove');
r.removed = { section: await section(editor), credentials: await credentials() };
r.removedFace = (await until(async () => (await editorFace()).keyUnset === true)) && (await editorFace());
r.keysKept = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')).profiles.default.layouts[XL].pages.main.buttons[0]?.action?.type;

// Set up again: the section follows.
await inPage(editor, 'settings', type('password', PASSWORD));
await press(editor, 'save');
r.setUpAgain = await section(editor);
// Set up: every OBS key and row comes back, with nothing else done.
r.backFace = (await until(async () => (await editorFace()).keyUnset === false)) && (await editorFace());

editor.child.kill();
await until(() => editor.exited !== null, 10_000);

check('not set up: the library shows the OBS actions but marks them, saying why on hover; other actions are untouched', () => {
  assert.deepEqual(r.notSetUpFace.obsRows, [true, true, true]);
  assert.match(r.notSetUpFace.obsTitle, /OBS needs connecting in Deckhand's Settings.*Click to set it up/);
  assert.equal(r.notSetUpFace.hotkeyBlocked, null);
});
check('not set up: an OBS key in the grid is dimmed with the not-set-up badge, not the failed one', () => {
  assert.equal(r.notSetUpFace.keyUnset, true);
  assert.equal(r.notSetUpFace.keyBadge, true);
  assert.equal(r.notSetUpFace.keyFailedBadge, false);
});
check('not set up: the inspector says so for a selected OBS key, with the way to Settings', () => assert.match(r.notSetUpFace.callout, /OBS is not set up.*Set up OBS/));
check('not set up: an OBS action dragged onto a key places nothing (a Hotkey dragged the same way does)', () => {
  assert.deepEqual([r.obsDragStarted, r.hotkeyDragStarted], [true, true], 'both presses landed on their rows');
  assert.equal(r.obsDragged, null);
  assert.equal(r.hotkeyDragged, true, 'the control: the drag itself works');
});
check('not set up: clicking an OBS action opens Settings, and does not retarget the selected key', () => {
  assert.equal(r.clickOpensSettings, true);
  assert.deepEqual(r.clickedKey1, { label: 'Plain' });
});
check('removed: the OBS key goes back to its not-set-up face, live', () => assert.equal(r.removedFace?.keyUnset, true));
check('set up again: the key, its library row and the inspector come back by themselves', () => {
  assert.equal(r.backFace?.keyUnset, false);
  assert.deepEqual(r.backFace?.obsRows, [false, false, false]);
  assert.equal(r.backFace?.callout, null);
});
check('the editor opens Settings at the OBS section, under INTEGRATIONS, in view, the host focused', () => {
  assert.ok(r.deepLink.headings.includes('INTEGRATIONS'), JSON.stringify(r.deepLink.headings));
  assert.equal(r.deepLink.inView, true);
  assert.equal(r.deepLink.focused, 'host');
});
check('with nothing saved: not set up, on the defaults, no password saved', () => {
  assert.equal(r.opened.state, 'not-set-up');
  assert.match(r.opened.statusText, /Not set up/);
  assert.deepEqual([r.opened.host, r.opened.port, r.opened.placeholder], ['127.0.0.1', '4455', 'None saved']);
  assert.equal(r.opened.removable, false, 'nothing to remove');
});
check(`Test, nothing on the port: ${realObs ? 'a real OBS runs here, so its server is off' : 'OBS is not running'}`, () =>
  assert.match(r.testNoPassword, realObs ? /WebSocket server is off/ : /OBS is not running/),
);
check('Test, no password where OBS asks for one: says so, and where to find it', () => assert.match(r.testNoPasswordRightPort, /asks for a password.*Show Connect Info/));
check('Test, a wrong password: says so', () => assert.match(r.testWrong, /refused the password/));
check('Test, the right values: connected, naming OBS — and nothing saved', () => {
  assert.match(r.testRight, /Connected to OBS 32\.1\.1-fake/);
  assert.equal(r.afterTest.section.state, 'not-set-up');
  assert.deepEqual(r.afterTest.credentials, {});
});
check('Save with OBS there: set up, connected, saved with the password — which the field then hides', () => {
  assert.match(r.saved, /^Saved\. Connected to OBS 32\.1\.1-fake/);
  assert.equal(r.afterSave.section.state, 'set-up');
  assert.deepEqual(r.afterSave.credentials.obs, { host: '127.0.0.1', port: fake.port, password: PASSWORD });
  assert.equal(r.afterSave.section.password, '');
  assert.match(r.afterSave.section.placeholder, /Saved/);
});
check('the password never reaches the settings page, through the bridge or the page', () => {
  assert.equal(r.statusHasNoSecret, true);
  assert.equal(r.pageHasNoSecret, true);
});
check('the editor window cannot save or remove OBS through the bridge', () => {
  assert.equal(r.editorCannotSave, true);
  assert.equal(r.editorCannotRemove, true);
  assert.equal(r.portUntouched, true);
});
check(`Save with OBS not there: saved, ${realObs ? '(a real OBS runs here) saying its server is off' : '"Keys will connect once OBS is running."'}`, () => {
  assert.equal(r.savedOffSetUp, true, 'saved, password kept');
  if (realObs) assert.match(r.savedOff, /^Saved, but: OBS is running, but its WebSocket server is off/);
  else assert.equal(r.savedOff, 'Saved. Keys will connect once OBS is running.');
});
check('OBS running with nothing listening: its WebSocket server is off, and where to turn it on', () =>
  assert.match(r.testServerOff, /WebSocket server is off.*Tools › WebSocket Server Settings/),
);
check('Remove asks first: the keys stop working, stay where they are, and no backup brings the password back', () => {
  assert.match(r.confirm, /Every OBS key stops working/);
  assert.match(r.confirm, /keys stay where they are/);
  assert.match(r.confirm, /backups never include it/);
});
check('Keep keeps it', () => {
  assert.equal(r.kept.section.state, 'set-up');
  assert.ok(r.kept.credentials.obs);
});
check('Remove: credentials deleted, not set up — and the OBS key stays in config.json', () => {
  assert.equal(r.removed.section.state, 'not-set-up');
  assert.equal('obs' in r.removed.credentials, false);
  assert.match(r.removed.section.message, /Removed/);
  assert.equal(r.keysKept, 'obs.stream');
});
check('set up again from the same form: set up', () => assert.equal(r.setUpAgain.state, 'set-up'));

await fake.stop();
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
