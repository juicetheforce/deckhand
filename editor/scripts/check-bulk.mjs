// M4 phase B3: bulk operations — multi-select, duplicate, copy, paste, clear and
// their shortcuts — end to end in real Electron against two fake decks shaped
// like the real ones (XL 8×4, Original V2 5×3).
//
// Usage: npm run check:bulk   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-bulk-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { loadConfig, watchConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist/config.js')).href);

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

const XL = 'BULK-XL';
const V2 = 'BULK-V2';
const JUMP = { label: 'Jump', icon: '~/icons/jump.png', action: { type: 'hotkey', keys: 'ctrl+1' } };
const SPRINT = { label: 'Sprint', action: { type: 'hotkey', keys: 'ctrl+2' } };
const TO_SECOND = { label: 'To second', action: { type: 'page', to: 'second' } };
// Row 0, column 7 and row 3, column 0: neither has a place on a 5×3 Original V2.
const FAR = { label: 'Far', action: { type: 'hotkey', keys: 'f7' } };
const LOW = { label: 'Low', action: { type: 'hotkey', keys: 'f8' } };
const CONFIG = {
  decks: { [XL]: { name: 'Big deck' }, [V2]: { name: 'Little deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: { 0: JUMP, 1: SPRINT, 2: TO_SECOND, 7: FAR, 24: LOW } },
            second: { name: 'Second', buttons: { 0: { label: 'Home', action: { type: 'page', to: 'main' } } } },
          },
        },
        [V2]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } },
      },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Fake V2' }));

const stopWatching = watchConfig(async () => {
  try {
    const { config } = await loadConfig();
    daemon.state.config = config;
    daemon.state.lastReload = { ok: true, at: new Date().toISOString() };
    daemon.events.config();
    await daemon.profiles.applyReload(config, daemon.sessions);
  } catch (err) {
    daemon.state.lastReload = { ok: false, at: new Date().toISOString(), error: err.message };
    daemon.events.config();
  }
});

const output = await runElectronCheck('bulk', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 90_000);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('Ctrl+click adds a key to the selection, and the inspector offers the bulk operations', () => {
    assert.deepEqual(r.ctrlClick, { selected: [0, 1], title: '2 keys selected' });
  });

  check('Ctrl+D duplicates each key into the next empty key, and selects the copies', () => {
    assert.deepEqual(r.duplicate.keys, [0, 1, 2, 3, 4, 7, 24]);
    assert.deepEqual(r.duplicate.selected, [3, 4]);
    assert.deepEqual(r.duplicate.copied, JUMP, 'the copy is the whole button');
  });

  check('Shift+click selects a run; Ctrl+C fills the clipboard line', () => {
    assert.match(r.clipboardLine, /Clipboard: 3 keys \(“Jump” \(key 1\), “Sprint” \(key 2\) and “To second” \(key 3\)\)/);
  });

  check('Ctrl+V pastes at the selected key by position, keeps same-layout navigation, and selects what landed', () => {
    assert.deepEqual(r.paste.keys, [0, 1, 2, 3, 4, 7, 16, 17, 18, 24]);
    assert.deepEqual(r.paste.selected, [16, 17, 18]);
    assert.deepEqual(r.paste.pastedNav, TO_SECOND);
    assert.match(r.paste.message, /Pasted 3 keys to “Main”\./);
  });

  check('the right-click menu names how many keys it acts on, and clears them', () => {
    assert.deepEqual(r.menuLabels, ['Duplicate 3 keys', 'Copy 3 keys', 'Paste', 'Copy to page', 'Copy to device', 'Clear 3 buttons']);
    assert.deepEqual(r.afterMenuClear, [0, 1, 2, 3, 4, 7, 24]);
  });

  check('right-clicking a key outside the selection acts on that key alone; Escape closes only the menu', () => {
    assert.deepEqual(r.rightClickOutside.selected, [4]);
    assert.match(r.rightClickOutside.firstItem, /^Duplicate key/);
    assert.deepEqual(r.escapeClosedMenuOnly, { menuGone: true, selected: [4] });
  });

  check('Delete clears the selected key', () => {
    assert.deepEqual(r.afterDelete, [0, 1, 2, 3, 7, 24]);
  });

  check('shortcuts do nothing while typing in a field', () => {
    assert.equal(r.labelFieldFound, true);
    assert.deepEqual(r.afterTypingShortcuts, [0, 1, 2, 3, 7, 24], 'Delete or Ctrl+D in the label field acted on the key');
  });

  check('shortcuts do nothing while a hotkey is being recorded: Delete is recorded, the key stays', () => {
    assert.equal(r.recordFound, true);
    assert.equal(r.recordedDelete, true);
    assert.deepEqual(r.keyThreeAfterRecording, { ...JUMP, action: { type: 'hotkey', keys: 'delete' } });
    assert.equal(r.recordedEscAtWindow, true, 'Escape sent to window was not recorded');
    assert.deepEqual(r.selectionAfterEscAtWindow, [3], 'Escape sent to window was recorded and also cleared the selection');
  });

  check('Copy to page puts the key at the same position on the other page, and leaves the selection and clipboard alone', () => {
    assert.deepEqual(r.copyToPage.pageItems, ['Second']);
    assert.deepEqual(r.copyToPage.secondKey1, SPRINT);
    assert.deepEqual(r.copyToPage.selected, [1]);
    assert.equal(r.copyToPage.clipboardUnchanged, true);
    assert.match(r.copyToPage.message, /^Copied 1 key to “Second”\.✕/);
  });

  check('Copy to device lists the other deck, places by row and column, skips and names what has no place, and drops dead navigation', () => {
    assert.deepEqual(r.copyToDevice.items, ['Little deck', 'Main']);
    assert.deepEqual(r.copyToDevice.v2Buttons, { 1: SPRINT, 2: { label: 'To second' } });
    assert.match(
      r.copyToDevice.message,
      /Copied 2 keys to Little deck › “Main”\. Skipped “Far” \(key 8\) and “Low” \(key 25\): they have no place on that deck\. “To second” \(key 3\) lost its Go to page/,
    );
    assert.equal(r.copyToDevice.deckStayed, true, 'copying to a deck switched the editor to it');
  });

  check('Ctrl+A selects every key on the deck, and Escape selects none', () => {
    assert.equal(r.selectAll, 32);
    assert.equal(r.afterEscape, 0);
  });
}

const saved = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
check('the saved file holds exactly what the operations produced, and nothing else changed', () => {
  const expected = structuredClone(CONFIG);
  expected.profiles.default.layouts[XL].pages.main.buttons = {
    0: JUMP,
    1: SPRINT,
    2: TO_SECOND,
    3: { ...JUMP, action: { type: 'hotkey', keys: 'esc' } },
    7: FAR,
    24: LOW,
  };
  expected.profiles.default.layouts[XL].pages.second.buttons[1] = SPRINT;
  expected.profiles.default.layouts[V2].pages.main.buttons = { 1: SPRINT, 2: { label: 'To second' } };
  assert.deepEqual(saved, JSON.parse(JSON.stringify(expected)));
});

check('the daemon reloaded what the editor saved', () => {
  assert.deepEqual(daemon.state.config.profiles.default.layouts[XL].pages.main.buttons, saved.profiles.default.layouts[XL].pages.main.buttons);
});

if (failures > 0) console.log(`\nrenderer report:\n${JSON.stringify(r, null, 2)}`);
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
