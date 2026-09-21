// Live switching, end to end in real Electron.
//
// The harness daemon (real DeckSessions on a fake deck, real ControlServer)
// is wired to reload the scratch config.json the way src/index.ts reload()
// does — Profiles.applyReload(), then the `config` event — so a page added
// in the editor really has to be saved and reloaded before it can be shown.
// The renderer drives the UI (src/renderer/checks.ts, "live"); this script
// moves the deck once by itself, standing in for a deck press, and checks
// the deck after the editor has quit.
//
// Usage: npm run check:live   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
// Before importing anything from the daemon: config.js reads these when imported.
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

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

const SERIAL = 'LIVE-XL';
const CONFIG = {
  startProfile: 'default',
  profiles: {
    default: { name: 'Default', layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} }, second: { name: 'Second', buttons: {} } } } } },
    other: { name: 'Other', layouts: { [SERIAL]: { startPage: 'hotbar', pages: { hotbar: { name: 'Hotbar', buttons: {} } } } } },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(SERIAL, new FakeDeck());
const session = daemon.sessions.get(SERIAL);

// Two real orderings, made wide enough that the checks see them every run
// rather than by luck (at their natural width a deliberate break of either
// goes uncaught):
// 1. The daemon answers a switch before its `state` event reaches the
//    client. Delay state events, so a breadcrumb that resumes following on the
//    reply always jumps back.
const notify = daemon.control.notify.bind(daemon.control);
daemon.control.notify = (name, snapshot) => (name === 'state' ? setTimeout(() => notify(name, snapshot), 150) : notify(name, snapshot));
// 2. A reload takes the decks time to apply, and the daemon announces it only
//    once they have it (src/index.ts reload()); the editor relies on that and
//    does not retry. Hold the apply back, so anything acting before the
//    announcement fails.
const RELOAD_APPLY_DELAY_MS = 300;

// Reload as src/index.ts does (the harness's reloadLikeTheDaemon).
let reloads = 0;
const stopWatching = await reloadLikeTheDaemon(daemon, { applyDelayMs: RELOAD_APPLY_DELAY_MS, onReload: (ok) => { if (ok) reloads++; } });

// Stand in for a deck press: once the renderer has confirmed the added page
// and signals with a preview on key 0, move the deck to Main.
let pressed = false;
const presser = setInterval(() => {
  if (!pressed && session.currentPage().startsWith('pg_') && session.previewKeys().includes(0)) {
    pressed = true;
    void session.goToPage('main');
  }
}, 25);

const output = await runElectronCheck('live', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 60_000);
clearInterval(presser);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});
if (r && !r.error) {
  check('the editor opens on what the deck shows', () => {
    assert.equal(r.opensOn.tab, 'Main');
    assert.equal(r.opensOn.deck.page, 'main');
  });
  check('clicking a page tab shows that page on the deck', () => assert.equal(r.tabShowsPage, true));
  check('the breadcrumb did not jump back while a page or profile switch was in flight', () => {
    assert.deepEqual(r.tabHistoryDuringSwitch, ['Second'], 'page switch');
    assert.deepEqual(r.tabHistoryDuringProfileSwitch, ['Hotbar'], 'profile switch');
  });
  check('choosing a profile switches the deck to its start page, and the breadcrumb lands there', () => {
    assert.equal(r.profileSwitches, true);
    assert.equal(r.profileSwitchesBack, true);
  });
  check('a page added with "+ Page" is saved, reloaded by the daemon and shown on the deck', () => {
    assert.equal(r.addedPageShown, true);
    assert.match(String(r.addedPageId), /^pg_[0-9a-f]{4}$/);
    assert.ok(reloads >= 1, 'the daemon never reloaded');
  });
  check('when the deck moves by itself, the breadcrumb follows', () => {
    assert.equal(r.tabBeforePress, 'Live page', 'the breadcrumb was not on the added page before the press, so following proves nothing');
    assert.equal(pressed, true, 'the stand-in press never happened');
    assert.equal(r.followsDeck, true);
  });
}
check('closing the editor left the deck where it was (Second), not the start page', () => {
  assert.equal(r?.leftOnSecond, true);
  assert.equal(session.currentPage(), 'second');
  assert.equal(daemon.profiles.activeProfile(), 'default');
});

stopWatching();
await daemon.stop();
// Retries: Electron's helper processes write to userData for a moment after
// the editor exits, so the first rmdir can meet ENOTEMPTY (check:failures did).
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
