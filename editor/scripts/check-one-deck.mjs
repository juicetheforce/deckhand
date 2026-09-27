// With one deck connected, the editor is exactly the one-deck editor it was
// before multi-deck editing: one grid, the plain Device dropdown, no
// multi-deck element, the same crumbs and pill, and the everyday operations
// working. Run by the pre-commit hook (scripts/hooks/pre-commit) on every
// commit touching editor/ or src/, so a change that leaks multi-deck UI into
// the one-deck case — the case most people have — is caught at the commit
// that makes it.
//
// It asserts the few things that define a one-deck editor, not a snapshot of
// the whole DOM: a snapshot changes with every legitimate UI edit, and a
// check whose update is routine stops catching anything.
//
// The config names a second deck that is not plugged in, as it would on a
// desk where one deck is unplugged: "one deck" means one connected, not one
// configured.
//
// Usage: npm run check:one-deck   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-one-deck-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
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

// The same serials as the renderer half (src/renderer/checks.ts, oneDeck).
const V2 = 'ONE-V2';
const XL = 'ONE-XL'; // in the config, never plugged in
const JUMP = { label: 'Jump', action: { type: 'hotkey', keys: 'ctrl+1' } };
const SPRINT = { label: 'Sprint', action: { type: 'hotkey', keys: 'ctrl+2' } };
const CONFIG = {
  decks: { [V2]: { name: 'Little deck' }, [XL]: { name: 'Big deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [V2]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: { 0: JUMP, 1: SPRINT, 2: { label: 'To second', action: { type: 'page', to: 'second' } } } },
            second: { name: 'Second', buttons: { 0: { label: 'Back', action: { type: 'page', to: 'main' } } } },
          },
        },
        [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } },
      },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Fake V2' }));
const stopWatching = await reloadLikeTheDaemon(daemon);

const output = await runElectronCheck('one-deck', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 60_000);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, `${r.error}\nprogress: ${JSON.stringify(r, null, 2)}`);
});

if (r && !r.error) {
  const s = r.structure;
  check('exactly one grid, with the deck\'s 15 keys', () => {
    assert.equal(s.grids, 1);
    assert.equal(s.keys, 15);
  });
  check('no multi-deck element at all ([data-multideck])', () => assert.equal(s.multideck, 0));
  check('the Device control is the plain dropdown, with the one connected deck as its only option', () => {
    assert.equal(s.deviceTag, 'SELECT');
    assert.deepEqual(s.deviceOptions, [{ value: V2, label: 'Little deck' }]);
    assert.equal(s.deviceValue, V2);
  });
  check('the crumbs: Profile and Device, a profile dropdown, the deck\'s rename pencil', () => {
    assert.deepEqual(s.crumbs, ['Profile', 'Device']);
    assert.equal(s.profileSelect, true);
    assert.equal(s.deckRename, true);
  });
  check('the page tabs, the "+" and the settings gear', () => {
    assert.deepEqual(s.tabs, ['Main', 'Second']);
    assert.equal(s.selectedTab, 'Main');
    assert.equal(s.addTab, true);
    assert.equal(s.settings, true);
  });
  check('the pill reads "Connected"', () => assert.deepEqual(s.pill, { state: 'connected', label: 'Connected' }));
  check('a page tab switches the grid and shows the page on the deck', () =>
    assert.deepEqual(r.tabSwitch, { tab: true, deck: true, face: true }));
  check('click, Ctrl+click and Shift+click select keys, and the inspector follows', () => {
    assert.deepEqual(r.selection.plain, { selected: [0], title: 'Key 1' });
    assert.deepEqual(r.selection.ctrl, { selected: [0, 2], title: '2 keys selected' });
    assert.deepEqual(r.selection.shift.selected, [2, 3, 4]);
  });
  check('a key dragged onto another swaps them', () => {
    assert.deepEqual(r.swap.key0, SPRINT);
    assert.deepEqual(r.swap.key1, JUMP);
  });
  check('a library click retargets the selected key; a library drag authors a new one', () => {
    assert.deepEqual(r.library.clicked, { label: 'Jump', action: { type: 'profile', to: 'default' } });
    assert.equal(r.library.dropped?.action?.type, 'hotkey');
    assert.deepEqual(r.library.selectedAfterDrop, [7]);
  });
  check('Delete clears the selected key', () => assert.deepEqual(r.afterDelete, [0, 1, 2]));
  check('Ctrl+A selects the deck\'s 15 keys', () => assert.equal(r.selectAll, 15));
  check('Copy to device is there and disabled: the other deck is not plugged in', () =>
    assert.deepEqual(r.copyToDevice, { found: true, disabled: true }));
}

check('the deck is on the page the editor left it on', () => assert.equal(daemon.sessions.get(V2).currentPage(), 'main'));

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
