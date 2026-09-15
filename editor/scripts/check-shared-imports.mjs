// M4 phase A, proof 0a (docs/scope.md §7): the daemon's validateConfig,
// keymap.ts and types import into the editor — main process and renderer —
// without being copied, and without pulling the daemon's native or D-Bus
// dependencies into the editor.
//
// Runs the built editor in real Electron with DECKHAND_EDITOR_CHECK=1, which
// makes main.ts load the config, collect a report from the renderer, print it
// and quit. Also checks that Electron's state went to the state directory and
// not to ~/.config.
//
// Usage: npm run check:shared   (builds first)
// DECKHAND_CONFIG_DIR may point at a config to validate; by default the
// repo's config.example.json is copied into a scratch directory.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

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

const output = await new Promise((resolve, reject) => {
  const env = { ...process.env, DECKHAND_EDITOR_CHECK: '1', DECKHAND_STATE_DIR: stateDir, DECKHAND_CONFIG_DIR: configDir };
  // VS Code sets ELECTRON_RUN_AS_NODE=1 for processes started from its
  // extension host; it turns the Electron binary into plain Node, with no
  // BrowserWindow. Found when the first run of this check failed that way.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [editorRoot], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`electron did not finish in 30 s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
  }, 30_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

const line = output.stdout.split('\n').find((l) => l.startsWith('DECKHAND_EDITOR_CHECK '));
let report = null;
check('electron ran the check and printed a report', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(line, `no report line\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  report = JSON.parse(line.slice('DECKHAND_EDITOR_CHECK '.length));
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
