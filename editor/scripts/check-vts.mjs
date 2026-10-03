// VTube Studio in the editor, end to end in real Electron: Settings ›
// Integrations › VTube Studio (Connect, VTS's window answered, Remove), and
// the Trigger hotkey key — its library row, its not-set-up face, its pickers.
//
// Driven like check-obs.mjs, on a private bus, against the control harness's
// daemon (the real socket commands and services/vts.ts) and
// scripts/test/fake-vts.mjs — never a real VTS: nothing here names VTS's own
// port, 8001, and the broadcast listener is pointed at a port of the
// check's. What is checked from outside the page: config.json.
//
// Usage: npm run check:vts   (builds first; run `npm run build:ts` at the root after changing src/)

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_VTS_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-vts-'));
const configDir = path.join(scratch, 'config');
const editorState = path.join(scratch, 'state');
// The daemon's state directory, where credentials.json lives: read when the harness is imported, so set first.
const daemonState = path.join(scratch, 'daemon-state');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_STATE_DIR = daemonState;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
// A real VTS on this machine broadcasts on 47779: listen elsewhere.
process.env.DECKHAND_VTS_BROADCAST_PORT = String(
  await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  }),
);
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { startFakeVts } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-vts.mjs')).href);
const vts = await import(pathToFileURL(path.join(repoRoot, 'dist/services/vts.js')).href);
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

const XL = 'VTS-XL';
const HEART = { type: 'vts.hotkey', model: 'm1', hotkey: 'hk-heart', modelName: 'Akari', hotkeyName: 'Heart Eyes' };
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { action: HEART }, 1: { label: 'Plain' } } } } } },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);
const fake = await startFakeVts({ approval: 'allow' });

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: editorState,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const credentials = async () => JSON.parse(await fs.readFile(path.join(daemonState, 'credentials.json'), 'utf8').catch(() => '{}'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const typePort = (value) =>
  `(() => { const i = document.querySelector('[data-vts-field=port]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const section = () =>
  inPage(
    editor,
    'settings',
    `(() => { const s = document.querySelector('#settings-vts'); return s && {
      state: s.dataset.vtsSection ?? null,
      status: s.querySelector('[data-vts-status]')?.dataset.vtsStatus ?? null,
      statusText: s.querySelector('[data-vts-status]')?.textContent ?? null,
      message: s.querySelector('[data-vts-message]')?.textContent ?? null,
      messageKind: s.querySelector('[data-vts-message]')?.dataset.vtsMessage ?? null,
      approval: s.querySelector('[data-vts-message]')?.dataset.vtsApproval ?? null,
      port: s.querySelector('[data-vts-field=port]')?.value ?? null,
      connect: s.querySelector('[data-vts=connect]')?.textContent ?? null,
      connectDisabled: s.querySelector('[data-vts=connect]')?.disabled ?? null,
      cancel: [...s.querySelectorAll('button')].some((b) => /cancel/i.test(b.textContent ?? '')),
      confirm: s.querySelector('[data-vts-confirm]')?.textContent ?? null,
      removable: s.querySelector('[data-vts=remove]') !== null,
    }; })()`,
  );
const configJson = async () => JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
const buttonsNow = async () => (await configJson()).profiles.default.layouts[XL].pages.main.buttons;

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);

const editorFace = () =>
  inPage(
    editor,
    'editor',
    `(() => {
      const row = document.querySelector('.library-entry[data-action-type="vts.hotkey"]');
      const key0 = document.querySelector('.key[data-key-index="0"]');
      const callout = document.querySelector('.inspector [data-not-set-up=vts]');
      return {
        rowBlocked: row?.dataset.notSetUp ?? null,
        rowTitle: row?.title ?? null,
        rowName: row?.textContent ?? null,
        modelRowBlocked: document.querySelector('.library-entry[data-action-type="vts.model"]')?.dataset.notSetUp ?? null,
        expressionRowBlocked: document.querySelector('.library-entry[data-action-type="vts.expression"]')?.dataset.notSetUp ?? null,
        group: [...document.querySelectorAll('.library-group')].some((g) => /VTube Studio/.test(g.textContent ?? '')),
        hotkeyBlocked: document.querySelector('.library-entry[data-action-type="hotkey"]')?.dataset.notSetUp ?? null,
        keyUnset: key0?.classList.contains('key-unset') ?? null,
        keyBadgeTitle: key0?.querySelector('.key-unset-badge')?.title ?? null,
        keyLabel: key0?.getAttribute('aria-label') ?? null,
        callout: callout?.textContent ?? null,
        calloutButton: callout?.querySelector('button') !== null && callout !== null,
      };
    })()`,
  );
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

// --- Not set up -------------------------------------------------------------------
await until(async () => (await editorFace()).rowBlocked === 'true');
await inPage(editor, 'editor', clickIn('.key[data-key-index="0"]'));
await until(async () => (await editorFace()).callout !== null);
r.notSetUp = await editorFace();
r.dragStarted = await dragRow('vts.hotkey', 2);
await sleep(600);
r.dragged = (await buttonsNow())['2'] ?? null;
await inPage(editor, 'editor', clickIn('.key[data-key-index="1"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="vts.hotkey"]'));
r.clickOpensSettings = await until(async () => (await stateOf(editor)).settingsOpen);
await sleep(400);
r.clickedKey1 = (await buttonsNow())['1'] ?? null;

// --- Settings › Integrations › VTube Studio ------------------------------------------
// The editor window opens Settings at the VTS section: the deep link a not-set-up action uses.
await inPage(editor, 'editor', "window.deckhand.openSettings('vts').then(() => true)");
await until(async () => (await section())?.state != null);
r.opened = await section();
r.deepLink = await inPage(
  editor,
  'settings',
  `(() => { const s = document.querySelector('#settings-vts').getBoundingClientRect(); return { inView: s.top >= 0 && s.top < window.innerHeight, focused: document.activeElement?.dataset.vtsField ?? null }; })()`,
);

// Connect with nothing there and no broadcast (the check's own broadcast port): not running. Never 8001.
await inPage(editor, 'settings', typePort(String(await freePort())));
await inPage(editor, 'settings', clickIn('[data-vts=connect]'));
r.notRunning = (await until(async () => (await section())?.approval === 'not-running', 15_000)) && (await section());
r.notRunningSaved = (await credentials()).vts ?? null;

// Connect to VTS: its window shows, and Settings says to answer it there — no Cancel.
fake.approval = 'hold';
await inPage(editor, 'settings', typePort(String(fake.port)));
await inPage(editor, 'settings', clickIn('[data-vts=connect]'));
r.waiting = (await until(async () => (await section())?.approval === 'waiting')) && (await section());
// The editor window cannot connect or remove: Settings only.
r.editorCannotConnect = await inPage(editor, 'editor', `window.deckhand.vtsConnect(${fake.port}).then((x) => x.ok === false)`);
r.editorCannotRemove = await inPage(editor, 'editor', `window.deckhand.vtsRemove().then((x) => x.ok === false)`);
r.tokenRequests = fake.tokenRequests.length;
fake.answer('allow');
r.approved = (await until(async () => (await section())?.approval === 'approved' && (await section())?.state === 'set-up')) && (await section());
r.savedPort = (await credentials()).vts?.port ?? null;
const token = (await credentials()).vts?.token ?? '';
r.tokenSaved = token.length > 0;
r.statusHasNoToken = !JSON.stringify(await inPage(editor, 'settings', 'window.deckhand.vtsStatus()')).includes(token);
r.pageHasNoToken = !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(token);
fake.approval = 'allow';

r.setUp = (await until(async () => (await editorFace()).rowBlocked === null && (await editorFace()).keyUnset === false)) && (await editorFace());

// --- The pickers: VTS's own lists, by ID, never typed ---------------------------------
const picker = (what) =>
  inPage(
    editor,
    'editor',
    `(() => { const ul = document.querySelector('.inspector [data-vts-picker=${what}]'); return ul && {
      ids: [...ul.querySelectorAll('[data-vts-id]')].map((b) => b.dataset.vtsId),
      names: [...ul.querySelectorAll('[data-vts-id] .target-name')].map((n) => n.textContent),
      selected: [...ul.querySelectorAll('.target-selected')].map((b) => b.dataset.vtsId),
      notes: [...ul.querySelectorAll('.target-note')].map((n) => n.textContent),
      unavailable: document.querySelector('.inspector [data-vts-list]')?.textContent ?? null,
      typed: document.querySelector('.inspector-section input[type=text], .inspector-section textarea') !== null,
    }; })()`,
  );
const pick = (what, id) => inPage(editor, 'editor', clickIn(`.inspector [data-vts-picker=${what}] [data-vts-id="${id}"]`));
await inPage(editor, 'editor', clickIn('.key[data-key-index="3"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="vts.hotkey"]'));
await until(async () => (await picker('model'))?.ids.length > 0);
r.modelPicker = await picker('model');
await pick('model', 'm1');
await until(async () => (await picker('hotkey'))?.ids.length > 0);
r.akariHotkeys = await picker('hotkey');
await pick('model', 'm2');
await until(async () => (await picker('hotkey'))?.ids.includes('hk-wave'));
await pick('hotkey', 'hk-wave');
r.saved = await until(async () => JSON.stringify((await buttonsNow())['3']?.action) === JSON.stringify({ type: 'vts.hotkey', model: 'm2', modelName: 'Hiyori', hotkey: 'hk-wave', hotkeyName: 'Wave' }));
r.savedAction = (await buttonsNow())['3']?.action ?? null;

// The Model key: one picker, VTS's models.
await inPage(editor, 'editor', clickIn('.key[data-key-index="4"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="vts.model"]'));
await until(async () => (await picker('model'))?.ids.length > 0);
r.modelKeyPicker = await picker('model');
r.modelKeyHotkeyPicker = await picker('hotkey');
await pick('model', 'm2');
r.modelSaved = await until(async () => JSON.stringify((await buttonsNow())['4']?.action) === JSON.stringify({ type: 'vts.model', model: 'm2', modelName: 'Hiyori' }));
r.modelSavedAction = (await buttonsNow())['4']?.action ?? null;

// The Toggle expression key: the model, then the loaded model's expressions — another model's, never.
await inPage(editor, 'editor', clickIn('.key[data-key-index="5"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="vts.expression"]'));
await until(async () => (await picker('model'))?.ids.length > 0);
r.expressionGap = await inPage(editor, 'editor', "document.querySelector('.inspector [data-vts-gap=stable]')?.textContent ?? null");
await pick('model', 'm2');
await until(async () => (await picker('expression'))?.unavailable != null);
r.expressionOtherModel = await picker('expression');
await pick('model', 'm1');
await until(async () => (await picker('expression'))?.ids.length > 0);
r.expressionPicker = await picker('expression');
await pick('expression', 'EyesLove.exp3.json');
r.expressionSaved = await until(
  async () =>
    JSON.stringify((await buttonsNow())['5']?.action) ===
    JSON.stringify({ type: 'vts.expression', model: 'm1', modelName: 'Akari', expression: 'EyesLove.exp3.json', expressionName: 'EyesLove' }),
);
r.expressionSavedAction = (await buttonsNow())['5']?.action ?? null;

// Deleted in VTS: the saved hotkey is kept, first, and marked.
const wave = fake.hotkeys.m2;
fake.hotkeys.m2 = [];
await inPage(editor, 'editor', clickIn('.key[data-key-index="1"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.key[data-key-index="3"]'));
await until(async () => (await picker('hotkey'))?.notes.includes('not in VTube Studio now'));
r.deletedPicker = await picker('hotkey');
fake.hotkeys.m2 = wave;

// VTS closed: nothing to pick from, and the saved choice still shown.
await fake.stop();
await inPage(editor, 'editor', clickIn('.key[data-key-index="1"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.key[data-key-index="3"]'));
await until(async () => (await picker('model'))?.unavailable !== null && (await picker('model'))?.unavailable !== undefined);
r.closedPicker = await picker('model');
r.keptAfterClose = (await buttonsNow())['3']?.action?.hotkey ?? null;

// Remove: asks first, saying what it costs; Keep keeps it. Works with VTS closed.
await inPage(editor, 'settings', clickIn('[data-vts=remove]'));
r.confirm = (await section()).confirm;
await inPage(editor, 'settings', clickIn('[data-vts=keep]'));
r.kept = { section: await section(), saved: (await credentials()).vts !== undefined };
await inPage(editor, 'settings', clickIn('[data-vts=remove]'));
await inPage(editor, 'settings', clickIn('[data-vts=confirm-remove]'));
r.removed = (await until(async () => (await section())?.state === 'not-set-up')) && { section: await section(), saved: (await credentials()).vts ?? null };
r.removedFace = (await until(async () => (await editorFace()).keyUnset === true)) && (await editorFace());
r.keysKept = (await buttonsNow())['0']?.action?.type ?? null;

editor.child.kill();
await until(() => editor.exited !== null, 10_000);

check('not set up: the library lists Trigger hotkey under VTube Studio, marked, saying how to set it up; other actions untouched', () => {
  assert.equal(r.notSetUp.group, true, 'a VTube Studio group');
  assert.match(r.notSetUp.rowName, /Trigger hotkey/);
  assert.equal(r.notSetUp.rowBlocked, 'true');
  assert.equal(r.notSetUp.modelRowBlocked, 'true', 'the Model row too');
  assert.equal(r.notSetUp.expressionRowBlocked, 'true', 'the Toggle expression row too');
  assert.match(r.notSetUp.rowTitle, /^VTube Studio is not set up\. Its keys do nothing until it is connected in Settings › Integrations\. Click to set it up\.$/);
  assert.equal(r.notSetUp.hotkeyBlocked, null);
});
check('not set up: the key is drawn dimmed with the not-set-up badge, naming VTube Studio, not OBS', () => {
  assert.equal(r.notSetUp.keyUnset, true);
  assert.match(r.notSetUp.keyBadgeTitle, /^VTube Studio is not set up/);
  assert.match(r.notSetUp.keyLabel, /VTube Studio is not set up/);
});
check('not set up: the inspector says so, with the way to Settings', () => {
  assert.match(r.notSetUp.callout, /VTube Studio is not set up\..*Settings › Integrations.*Set up VTube Studio/);
  assert.equal(r.notSetUp.calloutButton, true);
});
check('not set up: a drag places nothing, and a click opens Settings without retargeting the selected key', () => {
  assert.equal(r.dragStarted, true, String(r.dragStarted));
  assert.equal(r.dragged, null);
  assert.equal(r.clickOpensSettings, true);
  assert.deepEqual(r.clickedKey1, { label: 'Plain' });
});
check('Settings: a VTube Studio section under INTEGRATIONS, not set up, port 8001, opened at it in view with the port focused', () => {
  assert.equal(r.opened.state, 'not-set-up');
  assert.equal(r.opened.status, 'not-set-up');
  assert.match(r.opened.statusText, /^Not set up\./);
  assert.equal(r.opened.port, '8001');
  assert.equal(r.opened.connect, 'Connect');
  assert.equal(r.opened.removable, false, 'nothing to remove');
  assert.deepEqual(r.deepLink, { inView: true, focused: 'port' });
});
check('Connect with VTS not running: says so, as an error, and saves nothing', () => {
  assert.ok(r.notRunning, 'never not-running');
  assert.equal(r.notRunning.messageKind, 'error');
  assert.match(r.notRunning.message, /not running/);
  assert.equal(r.notRunningSaved, null);
});
check("Connect: while VTS's window waits, Settings says to answer it there; Connect is disabled and there is no Cancel", () => {
  assert.ok(r.waiting, 'never waiting');
  assert.match(r.waiting.message, /Allow Deckhand in VTube Studio's window/);
  assert.equal(r.waiting.messageKind, 'warn');
  assert.equal(r.waiting.connectDisabled, true);
  assert.equal(r.waiting.cancel, false);
  assert.equal(r.tokenRequests, 1);
});
check('the editor window cannot connect or remove: Settings only', () => {
  assert.equal(r.editorCannotConnect, true);
  assert.equal(r.editorCannotRemove, true);
});
check('allowed: set up, the port it was found on saved, the token saved and never shown or sent to the page', () => {
  assert.ok(r.approved, 'never approved');
  assert.match(r.approved.message, /^Allowed\./);
  assert.equal(r.approved.messageKind, 'ok');
  assert.equal(r.approved.connect, 'Connect again');
  assert.equal(r.approved.removable, true);
  assert.equal(r.savedPort, fake.port);
  assert.equal(r.tokenSaved, true);
  assert.equal(r.statusHasNoToken, true);
  assert.equal(r.pageHasNoToken, true);
});
check('allowed: the key, its library row and the inspector come back by themselves', () => {
  assert.ok(r.setUp, 'not ungated');
  assert.equal(r.setUp.callout, null);
});
check("the model picker lists VTS's models by ID, with their names; nothing is typed", () => {
  assert.deepEqual(r.modelPicker.ids, ['m1', 'm2']);
  assert.deepEqual(r.modelPicker.names, ['Akari', 'Hiyori']);
  assert.equal(r.modelPicker.typed, false);
});
check("the hotkey picker lists that model's hotkeys, a nameless one by its file, each with what kind it is", () => {
  assert.deepEqual(r.akariHotkeys.ids, ['hk-heart', 'hk-shake', 'hk-unnamed']);
  assert.deepEqual(r.akariHotkeys.names, ['Heart Eyes', 'Anim Shake', 'Shock.motion3.json']);
  assert.deepEqual(r.akariHotkeys.notes, ['expression', 'animation', 'animation']);
});
check('a pick writes the action by ID, with the names beside them to show', () => {
  assert.equal(r.saved, true, JSON.stringify(r.savedAction));
});
check('the Model key: one picker of VTS’s models, no hotkey picker; a pick writes the model by ID, with its name', () => {
  assert.deepEqual(r.modelKeyPicker.ids, ['m1', 'm2']);
  assert.equal(r.modelKeyHotkeyPicker, null);
  assert.equal(r.modelSaved, true, JSON.stringify(r.modelSavedAction));
});
check('Toggle expression: the stable-branch gap is stated in the form', () => assert.match(r.expressionGap ?? '', /stable version, an expression changed without a hotkey.*not shown here until the next model load or expression hotkey/));
check('Toggle expression: a model not loaded lists nothing, and says to load it', () => {
  assert.deepEqual(r.expressionOtherModel.ids, []);
  assert.equal(r.expressionOtherModel.unavailable, 'Load it in VTube Studio to see its expressions.');
});
check('Toggle expression: the loaded model’s expressions, by file, named without the extension; a pick writes both by ID', () => {
  assert.deepEqual(r.expressionPicker.ids, ['EyesCry.exp3.json', 'EyesLove.exp3.json']);
  assert.deepEqual(r.expressionPicker.names, ['EyesCry', 'EyesLove']);
  assert.equal(r.expressionSaved, true, JSON.stringify(r.expressionSavedAction));
});
check('a hotkey deleted in VTS: the saved one is kept, first, and marked', () => {
  assert.equal(r.deletedPicker.ids[0], 'hk-wave');
  assert.equal(r.deletedPicker.names[0], 'Wave');
  assert.ok(r.deletedPicker.notes.includes('not in VTube Studio now'));
});
check('VTS closed: "Start VTube Studio to choose", and the saved choice still shown', () => {
  assert.match(r.closedPicker.unavailable ?? '', /Start VTube Studio to choose/);
  assert.ok(r.closedPicker.selected.includes('m2'));
  assert.equal(r.keptAfterClose, 'hk-wave');
});

check('Remove: asks first, saying what it costs; Keep keeps it', () => {
  assert.match(r.confirm ?? '', /Every VTube Studio key stops working/);
  assert.equal(r.kept.saved, true);
  assert.equal(r.kept.section.state, 'set-up');
});
check('removed: not set up, the token gone, the key back to its not-set-up face, and no key touched', () => {
  assert.ok(r.removed, 'never not set up');
  assert.equal(r.removed.saved, null);
  assert.match(r.removed.section.message ?? '', /^Removed\./);
  assert.equal(r.removedFace?.keyUnset, true);
  assert.equal(r.keysKept, 'vts.hotkey');
});

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
