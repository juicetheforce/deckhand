// M5 pieces 1 and 2: export and import from the settings window, end to end
// in real Electron.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus, against the M3 harness. HOME is a scratch directory — for this process
// and the editor — so `~/` icon paths and the manifest's `home` are scratch
// paths, never the maintainer's. The system save dialog cannot be driven in a hidden
// window, so the editor is started with DECKHAND_CHECK_EXPORT_PATH and
// DECKHAND_CHECK_IMPORT_PATH, which only a check mode honours; everything else
// is the button a person clicks.
//
// Usage: npm run check:backup   (builds first)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
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
const importPath = path.join(scratch, 'import-me'); // content decides what it is, not the name
const outside = path.join(scratch, 'outside'); // outside HOME
await fs.mkdir(path.join(home, 'Pictures', 'ffxiv'), { recursive: true });
await fs.mkdir(configDir);
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(outside);
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
const far = await fs.readFile(path.join(repoRoot, 'assets/logo/png/apps/32.png'));
await fs.writeFile(path.join(outside, 'far.png'), far);

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
                6: { icon: `${outside}/far.png` },
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
  DECKHAND_CHECK_IMPORT_PATH: importPath,
};
delete env.ELECTRON_RUN_AS_NODE;

const clickButton = (text) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); return true; })()`;
const statusText = "document.querySelector('[data-status=export]')?.textContent ?? null";
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
    farBytes: Buffer.from(files['icons/003-far.png'] ?? []).equals(far),
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

// --- Import (M5 piece 2) ---
const exists = (p) => fs.access(p).then(() => true, () => false);
const reviewText = "document.querySelector('.import-review')?.innerText ?? null";
const importStatus = "document.querySelector('[data-status=import]')?.textContent ?? null";
/** Click Import… and wait for the review, or for a new status line if the file is refused. */
async function chooseNow() {
  const before = await inPage(editor, 'settings', importStatus);
  await inPage(editor, 'settings', clickButton('Import…'));
  const shown = await until(async () => {
    const [review, status] = await inPage(editor, 'settings', `[${reviewText}, ${importStatus}]`);
    return review !== null || (status !== null && status !== before);
  });
  if (!shown) throw new Error('no review and no message after Import…');
  return inPage(editor, 'settings', `({ review: ${reviewText}, status: ${importStatus} })`);
}
/** Click Replace configuration and wait for the result line. */
async function confirmNow() {
  await inPage(editor, 'settings', clickButton('Replace configuration'));
  await until(async () => (await inPage(editor, 'settings', reviewText)) === null && (await inPage(editor, 'settings', importStatus)) !== null);
  return inPage(editor, 'settings', importStatus);
}

// A fresh export with icons, made while every icon exists…
await inPage(editor, 'settings', "document.querySelector('.settings-export input[type=checkbox]').click(), true");
r.reExport = await exportNow(editor);
await fs.copyFile(exportPath, importPath);
// …then "a reinstall": the icons are gone, and the config has changed since.
await fs.rm(path.join(home, 'Pictures', 'ffxiv', 'dove.png'));
await fs.rm(path.join(home, 'mic.png'));
await fs.rm(path.join(outside, 'far.png'));
const at7 = JSON.stringify({ profile: 'default', serial: XL, page: 'main', index: 7 });
await inPage(editor, 'editor', `window.deckhand.apply({ kind: 'setLabel', at: ${at7}, label: 'AFTER-EXPORT' }).then((x) => x.ok)`);
await until(async () => (await fs.readFile(configFile, 'utf8')).includes('AFTER-EXPORT'));
const restoredFar = `~/Deckhand icons (restored)${outside}/far.png`;
const restoredFarFile = path.join(home, 'Deckhand icons (restored)', outside.slice(1), 'far.png');

const chosen = await chooseNow();
r.review = chosen.review;
r.nothingWrittenAtReview = {
  dove: await exists(path.join(home, 'Pictures', 'ffxiv', 'dove.png')),
  far: await exists(restoredFarFile),
  configUnchanged: (await fs.readFile(configFile, 'utf8')).includes('AFTER-EXPORT'),
};
r.importStatus = await confirmNow();
{
  const text = await fs.readFile(configFile, 'utf8');
  const backups = (await fs.readdir(path.join(stateDir, 'backups')).catch(() => [])).filter((n) => n.startsWith('before-import-'));
  r.afterImport = {
    dove: (await fs.readFile(path.join(home, 'Pictures', 'ffxiv', 'dove.png'))).equals(dove),
    mic: (await fs.readFile(path.join(home, 'mic.png'))).equals(mic),
    far: (await fs.readFile(restoredFarFile)).equals(far),
    nothingOutsideHome: !(await exists(path.join(outside, 'far.png'))),
    labelGone: !text.includes('AFTER-EXPORT'),
    pointsAtRestored: text.includes(restoredFar),
    backups: backups.length,
    backupHoldsReplaced: backups.length === 1 && (await fs.readFile(path.join(stateDir, 'backups', backups[0]), 'utf8')).includes('AFTER-EXPORT'),
  };
}

// Cancel: the review goes, nothing changes, and its id no longer confirms.
// The stale id is tried while a review is waiting: it must not confirm that one.
const beforeCancel = await fs.readFile(configFile, 'utf8');
await chooseNow();
const staleWhileWaiting = await inPage(editor, 'settings', "window.deckhand.confirmImport('stale')");
await sleep(300);
const unchangedWhileWaiting = (await fs.readFile(configFile, 'utf8')) === beforeCancel;
await inPage(editor, 'settings', clickButton('Cancel'));
r.cancelled = {
  reviewGone: await until(async () => (await inPage(editor, 'settings', reviewText)) === null),
  configUnchanged: unchangedWhileWaiting && (await fs.readFile(configFile, 'utf8')) === beforeCancel,
  staleId: staleWhileWaiting,
  afterCancel: await inPage(editor, 'settings', "window.deckhand.confirmImport('stale')"),
};

// A hostile bundle: an autostart entry dressed as an icon.
{
  const evil = strToU8('[Desktop Entry]\nExec=sh -c "echo pwned"\n');
  const hostile = structuredClone(CONFIG);
  hostile.profiles.default.layouts[XL].pages.main.buttons[8] = { icon: '~/.config/autostart/evil.desktop' };
  const manifest = {
    format: 'deckhand-export', version: 1, exportedAt: new Date().toISOString(), home: '/home/someone', includesIcons: true,
    icons: [{ path: '~/.config/autostart/evil.desktop', entry: 'icons/001-evil.desktop', sha256: createHash('sha256').update(evil).digest('hex'), size: evil.length }],
    missing: [], builtins: [],
  };
  await fs.writeFile(importPath, zipSync({ 'config.json': strToU8(JSON.stringify(hostile)), 'deckhand-export.json': strToU8(JSON.stringify(manifest)), 'icons/001-evil.desktop': evil }));
  r.hostileReview = (await chooseNow()).review;
  r.hostileStatus = await confirmNow();
  r.noAutostart = !(await exists(path.join(home, '.config')));
}

// A bare config file: said to be config only, and taken as it is.
{
  const bare = structuredClone(CONFIG);
  bare.profiles.default.layouts[XL].pages.main.buttons[9] = { label: 'BARE-JSON' };
  await fs.writeFile(importPath, JSON.stringify(bare, null, 2));
  r.bareReview = (await chooseNow()).review;
  r.bareStatus = await confirmNow();
  r.bareOnDisk = (await fs.readFile(configFile, 'utf8')).includes('BARE-JSON');
}

// Something that is neither: refused with why, and nothing to review.
await fs.writeFile(importPath, 'this is not a configuration');
r.garbage = await chooseNow();

// Only the settings window may import.
r.editorImportRefused = await inPage(editor, 'editor', 'window.deckhand.chooseImport()');

editor.send('menu Quit Deckhand');
await until(() => editor.exited !== null, 10_000);

check('Include icons is ticked when the window opens', () => assert.equal(r.iconsTickedByDefault, true));
check('the edit was still unsaved when Export was clicked (else the next check proves nothing)', () => assert.equal(r.editNotOnDiskYet, true));
check('with icons: config.json byte for byte as saved — the unsaved edit saved first — the manifest and all three icons, byte for byte', () => {
  assert.deepEqual(r.withIcons.names, ['config.json', 'deckhand-export.json', 'icons/001-dove.png', 'icons/002-mic.png', 'icons/003-far.png']);
  assert.equal(r.withIcons.configIsTheFile, true);
  assert.equal(r.withIcons.editInExport, true);
  assert.equal(r.withIcons.drgBytes, true);
  assert.equal(r.withIcons.micBytes, true);
  assert.equal(r.withIcons.farBytes, true);
});
check('the manifest records the scratch home, each path as written, the missing icon and the built-in', () => {
  assert.equal(r.withIcons.home, home);
  assert.deepEqual(r.withIcons.paths, ['~/Pictures/ffxiv/dove.png', `${home}/Pictures/ffxiv/dove.png`, '~/mic.png', `${outside}/far.png`]);
  assert.deepEqual(r.withIcons.missing, [{ path: '~/gone.png', reason: 'not found' }]);
  assert.deepEqual(r.withIcons.builtins, ['play']);
});
check('the result line: where it went (with ~), three icon files, and the missing one named', () => {
  assert.match(r.withIconsStatus, /^Exported to ~\/out\/export\.zip — /);
  assert.match(r.withIconsStatus, /3 icon files/);
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

check('import review, before anything is written: where the outside-home icon will go, what is restored, what will show missing, the backup folder', () => {
  assert.ok(r.review, 'no review');
  assert.match(r.review, /from outside your home folder, moved into ~\/Deckhand icons \(restored\)/);
  assert.ok(r.review.includes(`${outside}/far.png → ${restoredFar}`), r.review);
  assert.match(r.review, /2 icons restored to where they were/);
  assert.match(r.review, /will show as missing[\s\S]*~\/gone\.png \(already missing when exported\)/);
  assert.ok(r.review.includes(`kept in ${stateDir}/backups`), r.review);
  assert.deepEqual(r.nothingWrittenAtReview, { dove: false, far: false, configUnchanged: true });
});
check('import confirmed: icons restored byte for byte, the outside one in the restored folder, nothing outside home, config replaced, the old one kept', () => {
  assert.match(r.importStatus, /^Imported\. 3 icon files written\. Your previous configuration is kept at .*before-import-/);
  assert.deepEqual(r.afterImport, { dove: true, mic: true, far: true, nothingOutsideHome: true, labelGone: true, pointsAtRestored: true, backups: 1, backupHoldsReplaced: true });
});
check('a stale id does not confirm the review that is waiting; Cancel removes it and changes nothing', () => {
  const refused = { ok: false, error: 'this import is no longer waiting; choose the file again' };
  assert.deepEqual(r.cancelled, { reviewGone: true, configUnchanged: true, staleId: refused, afterCancel: refused });
});
check('a hostile bundle: the autostart entry is listed as not restored, and never written', () => {
  assert.match(r.hostileReview, /1 file not restored:[\s\S]*~\/\.config\/autostart\/evil\.desktop \(not an image file Deckhand shows\)/);
  assert.match(r.hostileStatus, /^Imported\. 0 icon files written\./);
  assert.equal(r.noAutostart, true);
});
check('a bare .json: the review says config only, paths as written; confirmed, it is the config', () => {
  assert.match(r.bareReview, /configuration file, not a Deckhand export: a config-only restore/);
  assert.match(r.bareStatus, /^Imported\. 0 icon files written\./);
  assert.equal(r.bareOnDisk, true);
});
check('a file that is neither is refused with why, and no review', () => {
  assert.equal(r.garbage.review, null);
  assert.match(r.garbage.status, /^import-me cannot be imported: the file is not valid JSON/);
});
check('the editor window cannot start an import', () => assert.deepEqual(r.editorImportRefused, { ok: false, error: 'not allowed' }));

stopWatching();
await daemon.stop();
// Retries: fontconfig may still be writing its cache into the scratch home.
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
