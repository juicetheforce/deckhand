// M5 piece 1: export from the settings window, end to end in real Electron.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus, against the M3 harness. HOME is a scratch directory — for this process
// and the editor — so `~/` icon paths and the manifest's `home` are scratch
// paths, never the maintainer's. The system save dialog cannot be driven in a hidden
// window, so the editor is started with DECKHAND_CHECK_EXPORT_PATH, which only
// a check mode honours; everything else is the button a person clicks.
//
// Usage: npm run check:backup   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_BACKUP_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-backup-'));
const home = path.join(scratch, 'home');
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const outDir = path.join(scratch, 'home', 'out'); // inside HOME, so the result shows it as ~/out
const exportPath = path.join(outDir, 'export.zip');
await fs.mkdir(path.join(home, 'Pictures', 'ffxiv'), { recursive: true });
await fs.mkdir(configDir);
await fs.mkdir(outDir, { recursive: true });
process.env.HOME = home; // before the harness: its daemon expands `~/` with it
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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

// Two real PNGs from the repo, as icons in the scratch home.
const dove = await fs.readFile(path.join(repoRoot, 'assets/logo/png/apps/48.png'));
const mic = await fs.readFile(path.join(repoRoot, 'assets/logo/png/apps/16.png'));
await fs.writeFile(path.join(home, 'Pictures', 'ffxiv', 'dove.png'), dove);
await fs.writeFile(path.join(home, 'mic.png'), mic);

const XL = 'BACKUP-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: { icon: '~/Pictures/ffxiv/dove.png', action: { type: 'hotkey', keys: 'ctrl+1' } },
                1: { icon: `${home}/Pictures/ffxiv/dove.png` },
                2: { action: { type: 'audio.micMute', iconMuted: '~/mic.png' } },
                3: { icon: 'builtin:play' },
                4: { icon: '~/gone.png' },
              },
            },
          },
        },
      },
    },
  },
};
const configFile = path.join(configDir, 'config.json');
await fs.writeFile(configFile, JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
  DECKHAND_CHECK_EXPORT_PATH: exportPath,
};
delete env.ELECTRON_RUN_AS_NODE;

const clickButton = (text) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); return true; })()`;
const statusText = "document.querySelector('.settings-status')?.textContent ?? null";
const readZip = async () => unzipSync(new Uint8Array(await fs.readFile(exportPath)));
const names = (files) => Object.keys(files).sort();

/**
 * Click Export… and wait for a new result line; returns its text. Each export
 * here gives a different line, so "changed, and the button is back" is done.
 * (Not by removing the old line first: React owns that node, and removing it
 * from outside crashes the page on the next render.)
 */
async function exportNow(editor) {
  const before = await inPage(editor, 'settings', statusText);
  await inPage(editor, 'settings', clickButton('Export…'));
  const done = await until(async () => {
    const [text, idle] = await inPage(editor, 'settings', `[${statusText}, [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Export…' && !b.disabled)]`);
    return idle && text !== null && text !== before;
  });
  if (!done) throw new Error(`no new result line after Export… (still: ${before})`);
  return inPage(editor, 'settings', statusText);
}

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);

await inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
await until(async () => (await stateOf(editor)).settingsOpen);
await until(async () => (await inPage(editor, 'settings', "document.querySelector('.settings-export') !== null")) === true);
r.iconsTickedByDefault = await inPage(editor, 'settings', "document.querySelector('.settings-export input[type=checkbox]').checked");

// An unsaved edit: made in the editor, exported before autosave's 400 ms.
const at = JSON.stringify({ profile: 'default', serial: XL, page: 'main', index: 5 });
await inPage(editor, 'editor', `window.deckhand.apply({ kind: 'setLabel', at: ${at}, label: 'UNSAVED-EDIT' }).then((x) => x.ok)`);
r.editNotOnDiskYet = !(await fs.readFile(configFile, 'utf8')).includes('UNSAVED-EDIT');
r.withIconsStatus = await exportNow(editor);
{
  const files = await readZip();
  const manifest = JSON.parse(strFromU8(files['deckhand-export.json']));
  const onDisk = await fs.readFile(configFile, 'utf8');
  r.withIcons = {
    names: names(files),
    configIsTheFile: strFromU8(files['config.json']) === onDisk,
    editInExport: strFromU8(files['config.json']).includes('UNSAVED-EDIT'),
    drgBytes: Buffer.from(files['icons/001-dove.png'] ?? []).equals(dove),
    micBytes: Buffer.from(files['icons/002-mic.png'] ?? []).equals(mic),
    home: manifest.home,
    paths: manifest.icons.map((i) => i.path),
    missing: manifest.missing,
    builtins: manifest.builtins,
  };
}
r.nothingElseInOut = await fs.readdir(outDir);

// Config only: untick, export over the same file.
await inPage(editor, 'settings', "document.querySelector('.settings-export input[type=checkbox]').click(), true");
r.configOnlyStatus = await exportNow(editor);
{
  const files = await readZip();
  r.configOnly = { names: names(files), includesIcons: JSON.parse(strFromU8(files['deckhand-export.json'])).includesIcons };
}

// Only the settings window may export: the editor's window is refused, and nothing is written.
await fs.rm(exportPath);
r.editorRefused = await inPage(editor, 'editor', 'window.deckhand.exportConfig(true)');
await sleep(300);
r.editorWroteNothing = await fs.access(exportPath).then(() => false, () => true);

// A destination that cannot be written: the failure is shown, and no partial file is left.
await fs.chmod(outDir, 0o555);
r.failedStatus = await exportNow(editor);
await fs.chmod(outDir, 0o755);
r.afterFailure = await fs.readdir(outDir);

editor.send('menu Quit Deckhand');
await until(() => editor.exited !== null, 10_000);

check('Include icons is ticked when the window opens', () => assert.equal(r.iconsTickedByDefault, true));
check('the edit was still unsaved when Export was clicked (else the next check proves nothing)', () => assert.equal(r.editNotOnDiskYet, true));
check('with icons: config.json byte for byte as saved — the unsaved edit saved first — the manifest and both icons, byte for byte', () => {
  assert.deepEqual(r.withIcons.names, ['config.json', 'deckhand-export.json', 'icons/001-dove.png', 'icons/002-mic.png']);
  assert.equal(r.withIcons.configIsTheFile, true);
  assert.equal(r.withIcons.editInExport, true);
  assert.equal(r.withIcons.drgBytes, true);
  assert.equal(r.withIcons.micBytes, true);
});
check('the manifest records the scratch home, each path as written, the missing icon and the built-in', () => {
  assert.equal(r.withIcons.home, home);
  assert.deepEqual(r.withIcons.paths, ['~/Pictures/ffxiv/dove.png', `${home}/Pictures/ffxiv/dove.png`, '~/mic.png']);
  assert.deepEqual(r.withIcons.missing, [{ path: '~/gone.png', reason: 'not found' }]);
  assert.deepEqual(r.withIcons.builtins, ['play']);
});
check('the result line: where it went (with ~), two icon files, and the missing one named', () => {
  assert.match(r.withIconsStatus, /^Exported to ~\/out\/export\.zip — /);
  assert.match(r.withIconsStatus, /2 icon files/);
  assert.match(r.withIconsStatus, /One icon could not be read and is not in it: ~\/gone\.png \(not found\)/);
});
check('nothing but the export is left in its folder (no temporary file)', () => assert.deepEqual(r.nothingElseInOut, ['export.zip']));
check('config only: replaces the file, with config.json and the manifest alone', () => {
  assert.deepEqual(r.configOnly.names, ['config.json', 'deckhand-export.json']);
  assert.equal(r.configOnly.includesIcons, false);
  assert.match(r.configOnlyStatus, /config only/);
});
check('the editor window cannot export, and nothing is written', () => {
  assert.deepEqual(r.editorRefused, { ok: false, error: 'not allowed' });
  assert.equal(r.editorWroteNothing, true);
});
check('a folder that cannot be written: "Export failed", and nothing is left behind', () => {
  assert.match(r.failedStatus, /^Export failed: .*EACCES/);
  assert.deepEqual(r.afterFailure, []);
});

stopWatching();
await daemon.stop();
// Retries: fontconfig may still be writing its cache into the scratch home.
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
