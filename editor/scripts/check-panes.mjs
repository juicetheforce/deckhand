// M4 phase A refinements: the resizable panes in real Electron (scope §10).
//
// Drags each divider through the UI and checks the limits. Widths are
// deliberately **not** persisted (the maintainer, 2026-09-15), so this also checks the
// editor opens at its defaults and writes no widths anywhere.
//
// Usage: npm run check:panes   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
await fs.mkdir(configDir, { recursive: true });
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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

// The limits the renderer uses, read from its own source so the two cannot drift.
const panesSource = await fs.readFile(path.join(repoRoot, 'editor/src/renderer/panes.ts'), 'utf8');
const limit = (pane, key) => Number(new RegExp(`${pane}: \\{ min: (\\d+), max: (\\d+), default: (\\d+)`).exec(panesSource)[{ min: 1, max: 2, default: 3 }[key]]);
const LIBRARY = { min: limit('library', 'min'), max: limit('library', 'max'), default: limit('library', 'default') };
const INSPECTOR = { min: limit('inspector', 'min'), max: limit('inspector', 'max'), default: limit('inspector', 'default') };

const SERIAL = 'PANES-XL';
const CONFIG = {
  profiles: { default: { name: 'Default', layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } } } } },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(SERIAL, new FakeDeck());

const output = await runElectronCheck('panes', { configDir, stateDir, socket: daemon.socket }, 90_000);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr.slice(-2000)}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout.slice(-2000)}\nstderr:\n${output.stderr.slice(-2000)}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('the editor opens at the default widths, with a divider either side of the grid', () => {
    assert.deepEqual(r.startingWidths, { library: LIBRARY.default, inspector: INSPECTOR.default });
    assert.equal(r.dividerCount, 2);
    assert.equal(r.gridColumnPositive, true);
  });
  check('dragging a divider resizes its pane: the library follows the pointer, the inspector opposes it', () => {
    assert.deepEqual(r.afterLibraryDrag, { library: LIBRARY.default + 60, inspector: INSPECTOR.default });
    assert.equal(r.afterInspectorDrag.inspector, INSPECTOR.default + 40);
    assert.equal(r.afterInspectorDrag.library, LIBRARY.max, 'the library keeps the width the previous drag left it at');
  });
  check('a drag past the limit stops at it', () => {
    assert.equal(r.libraryAtMax, LIBRARY.max);
    assert.equal(r.inspectorAtMax, INSPECTOR.max);
  });
  check('double-click restores that pane to its default; arrow keys move a divider', () => {
    assert.equal(r.afterDoubleClick, LIBRARY.default);
    assert.equal(r.arrowMoved, true);
  });
}

const stateEntries = await fs.readdir(path.join(stateDir, 'editor')).catch(() => []);
const prefs = JSON.parse(await fs.readFile(path.join(stateDir, 'editor', 'preferences.json'), 'utf8').catch(() => '{}'));
check('no pane width is persisted anywhere', () => {
  assert.equal(prefs.paneWidths, undefined);
  assert.equal(stateEntries.includes('ui-state.json'), false, 'the old pane-width file is gone');
  assert.equal(JSON.stringify(prefs).includes(String(r?.finalWidths?.library ?? 'x')), false);
});
const configEntries = (await fs.readdir(configDir)).sort();
check('the config directory holds only config.json', () => assert.deepEqual(configEntries, ['config.json']));

await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
