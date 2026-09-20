// The editor's empty state (docs/scope.md §7, Portability), in real Electron.
//
// the maintainer found this by opening the editor on a machine with an empty
// configuration and no hardware: three different situations — the daemon not
// reachable, every deck unplugged, and nothing ever configured — all rendered
// the same per-deck layout sentence, an empty device dropdown, no connection
// indicator, and a button offering to "add a layout for this deck" for a deck
// that did not exist. All three have been possible since M1; nobody noticed
// because a deck has always been attached to the working machine.
//
// Each situation gets its own daemon, its own config and its own editor
// window, because they differ in how the editor *starts up*, not in anything
// it can be driven into afterwards. That is five Electron launches, which is
// slow and is the point: the bug was in what the window shows when it opens.
//
// Nothing here touches the installed daemon or the real session bus: the
// socket, config and state directories are all scratch paths.
//
// Usage: npm run check:empty   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');

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

const XL = 'EMPTY-XL-0001';
const V2 = 'EMPTY-V2-0002';

/** The empty configuration a first install with no deck attached writes. */
const EMPTY_CONFIG = { profiles: { default: { name: 'Default', layouts: {} } }, startProfile: 'default' };

const layoutFor = (serial) => ({ startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } });
const configWith = (...serials) => ({
  decks: Object.fromEntries(serials.map((s) => [s, { name: s === XL ? 'My XL' : 'My V2' }])),
  profiles: { default: { name: 'Default', layouts: Object.fromEntries(serials.map((s) => [s, layoutFor(s)])) } },
  startProfile: 'default',
});

/**
 * Run one situation: write its config, start a harness daemon unless the
 * situation is "no daemon", let `setUp` arrange the decks, then open a real
 * editor against it and return what the renderer saw.
 */
async function situation({ config, noDaemon = false, setUp = async () => undefined, check: checkName = 'empty' }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
  const configDir = path.join(scratch, 'config');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  // After the config directory exists: dist/config.js reads DECKHAND_CONFIG_DIR
  // when it is first imported, and control-harness.mjs imports it.
  process.env.DECKHAND_CONFIG_DIR = configDir;
  const harness = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

  let daemon = null;
  // A socket path that nothing is listening on: the editor's daemon client
  // fails to connect, which is exactly "the daemon is not running".
  let socket = path.join(scratch, 'absent.sock');
  if (!noDaemon) {
    daemon = await harness.startDaemon(scratch, config);
    socket = daemon.socket;
    await setUp(daemon, harness);
  }

  const output = await runElectronCheck(checkName, { configDir, stateDir: path.join(scratch, 'state'), socket }, 40_000);
  await daemon?.stop();
  await fs.rm(scratch, { recursive: true, force: true });

  assert.equal(output.code, 0, `electron exited ${output.code}\nstderr:\n${output.stderr}`);
  const report = output.report?.renderer;
  assert.ok(report, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(report.error, undefined, report.error);
  return report;
}

// ---------------------------------------------------------------- 1. no daemon

console.log('\n1. the daemon is not reachable');
const down = await situation({ config: EMPTY_CONFIG, noDaemon: true });

check('it says the daemon is not running, not that a deck is missing', () => {
  assert.equal(down.kind, 'daemon-down');
  assert.match(down.title, /daemon is not running/i);
});
check('it says edits are still saved', () => assert.match(down.detail, /still saved/i));
check('the pill says so too, instead of vanishing', () => {
  assert.equal(down.pill, 'daemon-down');
  assert.equal(down.pillLabel, 'Daemon not running');
});
check('it offers no layout to add, having no deck to add one for', () => assert.equal(down.addButton, null));
check('and says it exactly once — the banner stands down (scope §7)', () => assert.equal(down.daemonNotices, 0));
check('there is no grid', () => assert.equal(down.grid, false));

// -------------------------------------------------- 2. nothing ever configured

console.log('\n2. the empty configuration, no deck plugged in');
const fresh = await situation({ config: EMPTY_CONFIG });

check('it says nothing is connected and nothing is set up', () => {
  assert.equal(fresh.kind, 'never-configured');
  assert.match(fresh.title, /No Stream Deck is connected/);
  assert.match(fresh.detail, /Nothing has been set up yet/);
});
check('the pill says no decks, not "not connected"', () => {
  assert.equal(fresh.pill, 'no-decks');
  assert.equal(fresh.pillLabel, 'No decks connected');
});
check('the device dropdown says there is nothing to choose, and is disabled', () => {
  assert.deepEqual(fresh.deviceOptions, ['No decks']);
  assert.equal(fresh.deviceDisabled, true);
});
check('nothing offers to add a layout for a deck that is not there', () => assert.equal(fresh.addButton, null));
check('no daemon notice: the daemon is fine', () => assert.equal(fresh.daemonNotices, 0));
check('no uncovered-deck warning either: there is no deck to leave uncovered', () =>
  assert.deepEqual(fresh.warnBadges, []));

// ------------------------------------------------------- 3. every deck unplugged

console.log('\n3. decks are configured; none is plugged in');
const unplugged = await situation({ config: configWith(XL, V2) });

check('it says no deck is connected', () => {
  assert.equal(unplugged.kind, 'all-unplugged');
  assert.match(unplugged.title, /No Stream Deck is connected/);
});
check('and names the decks it is waiting for, so it differs from case 2', () => {
  assert.match(unplugged.detail, /My XL and My V2/);
  assert.notEqual(unplugged.detail, fresh.detail);
});
check('the pill says no decks', () => assert.equal(unplugged.pill, 'no-decks'));
check('it offers no layout: both decks already have one', () => assert.equal(unplugged.addButton, null));

// ------------------------------------------ 4. a connected deck with no layout

console.log('\n4. a fresh install with a deck plugged into it');
// The state every new install sits in once hardware arrives, and the one the maintainer
// opened the editor on: the empty configuration, one deck connected, no
// profile with a layout for it. The daemon reports it connected: true,
// configured: false, from `unattached`.
const fresh2 = await situation({
  config: EMPTY_CONFIG,
  setUp: async (daemon, harness) => {
    const { geometryOf } = await import(pathToFileURL(path.join(repoRoot, 'dist/geometry.js')).href);
    daemon.unattached.set(V2, geometryOf(new harness.FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2' })));
    daemon.events.state();
  },
});

check('the old sentence survives here, because here it is true', () => {
  assert.equal(fresh2.kind, 'no-layout');
  assert.match(fresh2.detail, /showing whatever it had/);
});
check('and names the deck rather than saying "this deck"', () => {
  assert.match(fresh2.title, /Stream Deck Original V2/);
});
check('this is the one case that offers to add a layout, naming the deck', () => {
  assert.match(fresh2.addButton ?? '', /Add a layout for Stream Deck Original V2/);
});
check('the deck is there, so the pill says connected, not "no decks"', () => {
  assert.equal(fresh2.pill, 'connected');
});
check('the deck is in the dropdown, so it can be chosen', () => {
  assert.equal(fresh2.deviceOptions.length, 1);
  assert.equal(fresh2.deviceDisabled, false);
});

// --------------------------- 4b. the same, reached by choosing it in the list

console.log('\n4b. two decks connected, this profile covers only one');
// The breadcrumb opens on the deck that has a layout, so the uncovered one is
// reached by choosing it — which is what the "empty-select" check does.
const chosen = await situation({
  check: 'empty-select',
  config: configWith(XL),
  setUp: async (daemon, harness) => {
    const { geometryOf } = await import(pathToFileURL(path.join(repoRoot, 'dist/geometry.js')).href);
    await daemon.attach(XL, new harness.FakeDeck());
    daemon.unattached.set(V2, geometryOf(new harness.FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2' })));
    daemon.events.state();
  },
});

check('choosing the uncovered deck shows the same thing', () => {
  assert.equal(chosen.kind, 'no-layout');
  assert.match(chosen.addButton ?? '', /Add a layout for/);
});
check('say it once: the toolbar badge summarises, the card explains — two voices, not three', () => {
  // scope §7: the badge is "the one summary" and is kept; the dropdown's
  // per-row clause was dropped on 2026-09-20; the card is this piece's, and
  // it is the only one that names what to do about it.
  assert.equal(chosen.warnBadges.length, 1, 'the ⚠ summary');
  assert.match(chosen.warnBadges[0], /not covered/);
  assert.equal(chosen.deviceOptions.filter((o) => o.includes('no layout')).length, 0, 'the dropdown clause stays gone');
});

// ------------------------------------------- 5. a configured deck, unplugged

console.log('\n5. this profile covers the selected deck, which is not plugged in');
const gone = await situation({
  check: 'empty-select',
  config: configWith(XL, V2),
  setUp: async (daemon, harness) => {
    // Only the XL is there; the V2 has a layout and is absent. Selecting the
    // absent one is the only way to see its message.
    await daemon.attach(XL, new harness.FakeDeck());
  },
});

check('choosing the absent deck blames the deck, not the daemon', () => {
  assert.equal(gone.kind, 'deck-unplugged');
  assert.match(gone.title, /My V2 is not connected/);
  assert.equal(gone.addButton, null, 'it already has a layout');
});
check('the pill follows the selected deck', () => assert.equal(gone.pill, 'disconnected'));
check('and the dropdown marks it, which is one of the three states, not a repeat', () => {
  assert.equal(gone.deviceOptions.filter((o) => o.includes('not connected')).length, 1);
});
check('the daemon is fine, so nothing says otherwise', () => assert.equal(gone.daemonNotices, 0));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
