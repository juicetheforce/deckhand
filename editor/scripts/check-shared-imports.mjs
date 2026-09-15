// M4 phase A, proof 0a (docs/scope.md §7): the daemon's validateConfig,
// keymap.ts and types import into the editor — main process and renderer —
// without being copied, and without pulling the daemon's native or D-Bus
// dependencies into the editor.
//
// Runs the built editor in real Electron with DECKHAND_EDITOR_CHECK=shared,
// which makes the renderer report, and main load the config, print a report
// and quit. Also checks that Electron's state went to the state directory and
// not to ~/.config. The daemon socket points at a scratch path with nothing
// listening, so the check never talks to a running daemon.
//
// Usage: npm run check:shared   (builds first)
// DECKHAND_CONFIG_DIR may point at a config to validate; by default the
// repo's config.example.json is copied into a scratch directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');

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

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-editor-check-'));
const stateDir = path.join(scratch, 'state');
let configDir = process.env.DECKHAND_CONFIG_DIR;
if (!configDir) {
  configDir = path.join(scratch, 'config');
  await fs.mkdir(configDir);
  await fs.copyFile(path.join(repoRoot, 'config.example.json'), path.join(configDir, 'config.json'));
}

const userConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
const configHomeBefore = new Set(await fs.readdir(userConfigHome));

const output = await runElectronCheck('shared', { configDir, stateDir, socket: path.join(scratch, 'no-daemon.sock') });
const report = output.report;
check('electron ran the check and printed a report', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(report, `no report line\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
});

if (report) {
  console.log(`      electron ${report.electron}, node ${report.node}`);
  check('main process: validateConfig (via loadConfig) accepts the config', () => {
    assert.equal(report.configPath, path.join(configDir, 'config.json'));
    assert.equal(report.mainValidateConfig.ok, true, report.mainValidateConfig.error);
  });
  check('main process: parseCombo("ctrl+1") gives evdev [29, 2]', () => {
    assert.deepEqual(report.mainParseCombo, [29, 2]);
  });
  check('renderer: parseCombo("ctrl+1") gives evdev [29, 2]', () => {
    assert.equal(report.renderer.error, undefined);
    assert.deepEqual(report.renderer.parseCombo, [29, 2]);
    assert.equal(report.renderer.protocolTypeUsed, 'default');
  });
  check('userData is $DECKHAND_STATE_DIR/editor', () => {
    assert.equal(report.userData, path.join(stateDir, 'editor'));
  });
  const written = await fs.readdir(path.join(stateDir, 'editor')).catch(() => []);
  check('the editor state directory is not empty after a run', () => {
    assert.ok(written.length > 0, 'nothing written — the userData check proves less than it looks');
  });
}

const configHomeAfter = await fs.readdir(userConfigHome);
check(`nothing new in ${userConfigHome}`, () => {
  const added = configHomeAfter.filter((name) => !configHomeBefore.has(name));
  assert.deepEqual(added, []);
});

const configDirEntries = await fs.readdir(configDir);
check('nothing but config.json in the config directory', () => {
  assert.deepEqual(configDirEntries.filter((name) => name !== 'config.json' && !name.startsWith('config.v0.1')), []);
});

// The daemon's dependencies that must never reach the editor's bundles.
const FORBIDDEN = ['sharp', 'dbus-next', 'node-hid', '@elgato-stream-deck', 'usocket'];
const bundles = [
  path.join(editorRoot, 'dist/main/main.js'),
  path.join(editorRoot, 'dist/preload/preload.cjs'),
  ...(await fs.readdir(path.join(editorRoot, 'dist/renderer/assets')))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(editorRoot, 'dist/renderer/assets', name)),
];
for (const bundle of bundles) {
  const text = await fs.readFile(bundle, 'utf8');
  check(`${path.relative(editorRoot, bundle)} contains none of ${FORBIDDEN.join(', ')}`, () => {
    const found = FORBIDDEN.filter((name) => text.includes(name));
    assert.deepEqual(found, []);
  });
}

// The renderer's type check must not see Node or the daemon's dependencies,
// even through type-only imports, or it stops refusing `process` and `Buffer`
// in renderer code (see tsconfig.renderer.json).
// spawnSync, not execFileSync: --listFiles prints the program even when tsc
// also reports type errors, and a type error must not crash this check.
const listed = spawnSync(
  path.join(editorRoot, 'node_modules/.bin/tsc'),
  ['--noEmit', '-p', path.join(editorRoot, 'tsconfig.renderer.json'), '--listFiles'],
  { encoding: 'utf8' },
);
const rendererProgram = listed.stdout ?? '';
check('the renderer type check ran', () => {
  assert.ok(rendererProgram.includes('src/renderer/main.tsx'), `no file list\n${listed.stderr ?? ''}`);
});
check('the renderer type check reads no Node types and no daemon dependencies', () => {
  const leaked = rendererProgram
    .split('\n')
    .filter((file) => /node_modules\/(@types\/node|sharp|dbus-next|node-hid|@elgato-stream-deck)\//.test(file));
  assert.deepEqual(leaked.slice(0, 3), [], `${leaked.length} file(s), e.g.`);
});

await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
