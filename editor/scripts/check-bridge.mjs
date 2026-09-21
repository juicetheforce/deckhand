// The preload bridge end to end, in real Electron.
//
// Starts the control-socket test harness (real DeckSessions on fake decks
// behind a real ControlServer on a scratch socket), writes a matching
// config.json to a scratch directory, and runs the built editor with
// DECKHAND_EDITOR_CHECK=bridge. The renderer drives every bridge call
// (src/renderer/checks.ts); this script then checks the result on the other
// side: the file on disk, the fake deck, and the daemon's previews.
//
// Usage: npm run check:bridge   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
// Fakes first: the daemon's input module reads this when imported.
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, scratchDir } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

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

const scratch = await scratchDir(); // short, for the socket path

// For the icon protocol: a real 1×1 PNG, and a text file beside it.
const iconDir = path.join(scratch, 'icons');
await fs.mkdir(iconDir);
await fs.writeFile(
  path.join(iconDir, 'dot.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64'),
);
await fs.writeFile(path.join(iconDir, 'secret.txt'), 'not an image\n');

const SERIAL = 'BRIDGE-XL';
const CONFIG = {
  profiles: {
    default: {
      name: 'Default',
      layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { '0': { label: 'kept', icon: path.join(iconDir, 'dot.png') } } } } } },
    },
  },
};
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
await fs.mkdir(configDir);
const configPath = path.join(configDir, 'config.json');
await fs.writeFile(configPath, JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
const deck = new FakeDeck();
await daemon.attach(SERIAL, deck);
const session = daemon.sessions.get(SERIAL);
const writesBefore = deck.writes.get(3) ?? 0;

const userConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
const configHomeBefore = new Set(await fs.readdir(userConfigHome));

const output = await runElectronCheck('bridge', { configDir, stateDir, socket: daemon.socket });
const r = output.report?.renderer;

check('electron ran the check and the renderer reported without an error', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('snapshot: store open, daemon connected, deck geometry through the bridge', () => {
    assert.equal(r.storeOpen, true);
    assert.equal(r.daemonConnected, true);
    assert.deepEqual(r.decks, [{ serial: SERIAL, keyCount: 32, rows: 4, columns: 8 }]);
  });
  check('apply: addPage and setAction succeed; an edit at a missing page is refused with its message', () => {
    assert.equal(r.addPage.ok, true);
    assert.match(r.addPage.result.pageId, /^pg_[0-9a-f]{4}$/);
    assert.equal(r.setAction.ok, true);
    assert.equal(r.badEdit.ok, false);
    assert.match(r.badEdit.error, /no page with ID "no-such-page"/);
  });
  check('onStore: the renderer saw the autosave complete', () => {
    assert.equal(r.savedThroughAutosave, true);
  });
  check('pushed events crossed the bridge: a daemon event carrying the preview, a store event after the save', () => {
    assert.equal(r.daemonEventPushed, true, 'no daemon event with the preview reached onDaemon');
    assert.equal(r.storeEventPushed, true, 'no saved-store event reached onStore');
  });
  check('previewSet: ok, and the preview showed up in the daemon state the renderer received', () => {
    assert.deepEqual(r.previewSet, { ok: true });
    assert.equal(r.previewInState, true);
  });
  check('previewSet on a key the deck does not have: the daemon error code comes through', () => {
    assert.equal(r.previewBadKey.ok, false);
    assert.equal(r.previewBadKey.code, 'not_found');
  });
  check('icon protocol, in the page: the PNG draws; fetch() from page script is refused', () => {
    assert.equal(r.iconImageWidth, 1, 'the PNG did not load');
    assert.equal(r.iconTextFile, -1);
    assert.equal(r.iconMissing, -1);
    assert.match(String(r.iconFetch), /^refused/, 'page script could read the icon bytes');
  });
  check('icon protocol, by status: image 200, a .txt beside it 404, a missing image 404; builtin:speaker 200, an unknown or climbing built-in 404', () => {
    assert.deepEqual(output.report.iconStatuses, { image: 200, textFile: 404, missing: 404, builtin: 200, builtinUnknown: 404, builtinClimbing: 404 });
  });
  check('the preview reached the fake deck', () => {
    assert.ok((deck.writes.get(3) ?? 0) > writesBefore, 'key 3 was not written');
  });
}

const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
const layout = written.profiles.default.layouts[SERIAL];
const newPageId = r?.addPage?.result?.pageId;
check('config.json on disk has the new page and its hotkey; the existing page is untouched', () => {
  assert.ok(newPageId && layout.pages[newPageId], 'new page missing from the file');
  assert.equal(layout.pages[newPageId].name, 'Bridge page');
  assert.deepEqual(layout.pages[newPageId].buttons['2'].action, { type: 'hotkey', keys: 'ctrl+2' });
  assert.deepEqual(layout.pages.main, CONFIG.profiles.default.layouts[SERIAL].pages.main);
});
check('an edit made just before quitting was written (flushed on quit, inside the 400 ms autosave delay)', () => {
  assert.equal(r?.lastEdit?.ok, true);
  assert.equal(layout.pages[newPageId]?.buttons['2']?.label, 'written on quit');
});
check("the editor quitting cleared its previews on the daemon", () => {
  assert.deepEqual(session.previewKeys(), []);
});
const configDirEntries = await fs.readdir(configDir);
check('no temporary files left beside config.json', () => {
  assert.deepEqual(configDirEntries, ['config.json']);
});
const configHomeAfter = await fs.readdir(userConfigHome);
check(`nothing new in ${userConfigHome}`, () => {
  assert.deepEqual(configHomeAfter.filter((name) => !configHomeBefore.has(name)), []);
});

await daemon.stop();
// Retries: Electron's helper processes write to userData for a moment after
// the editor exits, so the first rmdir can meet ENOTEMPTY (check:failures did).
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
