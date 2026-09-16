// M4 phase A, step 5: the icon picker end to end in real Electron.
//
// The renderer drives the picker through the UI (src/renderer/checks.ts,
// "icons"). HOME is a scratch directory holding an icon tree, for this script
// (the harness daemon expands ~ with it) and for Electron (the editor stores
// icon paths as ~/... and opens Pictures by default). When the renderer signals
// with a preview on key 31, this script adds a file to the open folder, to
// show the folder is watched. Afterwards it checks the saved config.json, the
// editor's preferences file and the deck.
//
// The old recent-folders file is seeded, so the bookmarks row proves it is
// carried over rather than opening empty (scope §10).
//
// Usage: npm run check:icons   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
const home = path.join(scratch, 'home');
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
await fs.mkdir(configDir, { recursive: true });
// Before importing anything from the daemon: config.js reads these when imported.
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
// The scratch home, for the harness daemon (it expands ~ in icon paths) and for Electron.
// Electron resolves Pictures from the XDG user-dirs file under ~/.config; give the scratch home one.
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
await fs.mkdir(path.join(home, '.config'), { recursive: true });
await fs.writeFile(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_PICTURES_DIR="$HOME/Pictures"\n');
const { FakeDeck, startDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { loadConfig, watchConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist/config.js')).href);
// The daemon's own sharp, only to make real PNGs for the tree.
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');

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

const icons = path.join(home, 'Pictures', 'icons');
let hue = 0;
async function png(relative) {
  const full = path.join(icons, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  hue += 37;
  await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: hue % 256, g: (hue * 3) % 256, b: 120 } } }).png().toFile(full);
}
for (const f of ['back ground.png', 'fishing.png', 'FFXIV/BEAR/Bolt_III.png', 'FFXIV/BEAR/Flame_IV.png', 'FFXIV/BEAR/Shared_Actions/Aura.png', 'FFXIV/WOLF/Halo (Area).png']) {
  await png(f);
}
await sharp({ create: { width: 48, height: 48, channels: 3, background: '#335577' } }).jpeg().toFile(path.join(icons, 'fishing.jpg'));
await fs.writeFile(path.join(icons, 'corrupt.png'), 'this is not a png');
await fs.writeFile(path.join(icons, 'clip.mp4'), 'not shown');
await fs.writeFile(path.join(icons, 'x.tga'), 'not shown');

const SERIAL = 'ICONS-XL';
const BUTTONS = {
  '0': { action: { type: 'hotkey', keys: 'ctrl+1' } },
  '1': { icon: '~/Pictures/icons/FFXIV/BEAR/Bolt_III.png', action: { type: 'hotkey', keys: 'ctrl+2' } },
  '2': { icon: '~/Pictures/icons/gone.png', action: { type: 'hotkey', keys: 'ctrl+3' } },
};
const CONFIG = {
  profiles: {
    default: {
      name: 'Default',
      layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: BUTTONS }, second: { name: 'Second', buttons: {} } } } },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

// An old recents file: the bookmarks row is seeded from it on first read.
const SEEDED_RECENTS = [path.join(icons, 'FFXIV/WOLF'), path.join(icons, 'FFXIV')];
await fs.mkdir(path.join(stateDir, 'editor'), { recursive: true });
await fs.writeFile(path.join(stateDir, 'editor', 'icon-picker.json'), JSON.stringify({ recentFolders: SEEDED_RECENTS }, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
const deck = new FakeDeck();
await daemon.attach(SERIAL, deck);

// Reload as src/index.ts does: announce the reload, then apply it to the decks.
let reloads = 0;
const stopWatching = watchConfig(async () => {
  try {
    const { config } = await loadConfig();
    daemon.state.config = config;
    daemon.state.lastReload = { ok: true, at: new Date().toISOString() };
    daemon.events.config();
    await daemon.profiles.applyReload(config, daemon.sessions);
    reloads++;
  } catch (err) {
    daemon.state.lastReload = { ok: false, at: new Date().toISOString(), error: err.message };
    daemon.events.config();
  }
});

// Every key a preview was requested for, recorded at the session: step 15 must
// really have sent a preview on key 0, or its being cleared proves nothing.
const session = daemon.sessions.get(SERIAL);
const previewRequests = [];
const setPreview = session.setPreview.bind(session);
session.setPreview = (index, button) => {
  previewRequests.push(index);
  return setPreview(index, button);
};

// Handshakes: a preview on key 30 renames the key's icon away, on key 29 puts it back.
const AWAY = path.join(icons, 'back ground.png');
let renamedAway = false;
let renamedBack = false;
const renameTimer = setInterval(async () => {
  const previews = daemon.sessions.get(SERIAL)?.previewKeys() ?? [];
  if (!renamedAway && previews.includes(30)) {
    renamedAway = true;
    await fs.rename(AWAY, AWAY + '.moved');
  } else if (renamedAway && !renamedBack && previews.includes(29)) {
    renamedBack = true;
    await fs.rename(AWAY + '.moved', AWAY);
  }
}, 50);

// The watcher handshake: a preview on key 31 means "add a file to the open folder now".
let wroteNewFile = false;
const signalTimer = setInterval(async () => {
  if (wroteNewFile || !daemon.sessions.get(SERIAL)?.previewKeys().includes(31)) return;
  wroteNewFile = true;
  await png('FFXIV/BEAR/Frost.png');
}, 50);

const output = await runElectronCheck('icons', { configDir, stateDir, socket: daemon.socket }, 120_000, { HOME: home });
clearInterval(signalTimer);
clearInterval(renameTimer);
// The editor may quit as soon as the daemon has announced the last reload,
// before the harness has applied it to the deck (as src/index.ts orders it).
// Let the reload of the final saved file finish before looking at the deck.
const finalText = await fs.readFile(path.join(configDir, 'config.json'), 'utf8');
for (let waited = 0; waited < 5000; waited += 50) {
  const shown = daemon.sessions.get(SERIAL)?.layout?.pages?.main?.buttons?.['1'];
  if (JSON.stringify(daemon.state.config) === JSON.stringify(JSON.parse(finalText)) && shown && shown.icon === undefined) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await new Promise((resolve) => setTimeout(resolve, 300));
stopWatching();
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr.slice(-3000)}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout.slice(-3000)}\nstderr:\n${output.stderr.slice(-3000)}`);
  assert.equal(r.error, undefined, r.error);
});
if (r && !r.error) {
  check('with no icon set, the picker opens at the newest bookmark', () =>
    assert.equal(r.startWithNothing, SEEDED_RECENTS[0], 'the newest of the seeded bookmarks'));
  check('the grid draws a broken icon path with the built-in missing icon (loaded under the CSP); a good icon is not', () => {
    assert.deepEqual([r.missingInGrid, r.goodIconNotMissing], [true, true]);
  });
  check("the Icon tab opens on the key's icon's folder, subfolders first, the current icon marked", () => {
    // The field has a fixed height and elides the middle: root, then the last two folders.
    assert.equal(r.openedOn, '~/FFXIV/BEAR');
    assert.deepEqual(r.blmItems, ['Shared_Actions', 'Bolt_III.png', 'Flame_IV.png']);
    assert.deepEqual(r.currentMarked, ['Bolt_III.png']);
  });
  check('selecting an image previews it on the deck and saves nothing', () => assert.deepEqual([r.previewShown, r.previewNotSaved], [true, true]));
  check('arrow keys move the selection', () => assert.deepEqual([r.arrowLeft, r.arrowRight], [true, true]));
  check('Assign saves ~/..., clears the preview after the reload, and is disabled on the current icon', () => {
    assert.deepEqual([r.usedSaved, r.previewClearedOnUse, r.useDisabledOnCurrent], [true, true, true]);
  });
  check('the bookmarks row is seeded from the old recents file, oldest first, each chip named for its folder alone', () => {
    // The folder's own name, nothing else (the maintainer): the full path is the tooltip.
    assert.deepEqual(r.bookmarksSeeded, ['★ FFXIV', '★ WOLF', '+ Bookmark this folder']);
  });
  check('"+ Bookmark this folder" keeps the open folder, and turns into a way to remove it', () => {
    assert.deepEqual([r.bookmarkAdded, r.bookmarkButtonTurnsIntoRemove], [true, true]);
  });
  check('back, forward and up walk the folder history; refresh keeps the folder; the grid has six columns', () => {
    assert.deepEqual([r.upWentToParent, r.backEnabled, r.backReturned, r.forwardWentOn, r.refreshKeptFolder], [true, true, true, true, true]);
    assert.equal(r.gridColumns, 6);
  });
  check('narrowing the pane drops columns and leaves the thumbnails their size', () => {
    const [start, narrower, narrowest, back] = r.narrowing;
    const shown = JSON.stringify(r.narrowing);
    assert.equal(start.columns, 6, `six columns at the default pane width: ${shown}`);
    assert.ok(narrower.columns < start.columns, `narrowing drops a column: ${shown}`);
    assert.ok(narrowest.columns < narrower.columns, `and another: ${shown}`);
    assert.ok(r.narrowing.every((w) => w.tile >= 44), `tiles never shrink below their minimum: ${shown}`);
    assert.equal(back.columns, 6, `dragging back restores six columns: ${shown}`);
  });
  check('a subfolder tile says how many items it holds — the number on the tile, the words in its tooltip', () => {
    assert.deepEqual(r.folderCounts, ['BEAR=4/4 items', 'WOLF=1/1 item']);
  });
  check('double-click chooses', () => assert.equal(r.doubleClickSaved, true));
  check('a file added to the open folder appears without a refresh', () => {
    assert.equal(wroteNewFile, true, 'the renderer never signalled');
    assert.deepEqual([r.newFileAbsentBefore, r.watcherShowedNewFile], [true, true]);
  });
  check('a deep path is elided in the fixed-height field, and the ellipsis opens it out', () => {
    assert.deepEqual([r.pathElided, r.pathExpanded], [true, true]);
  });
  check('the breadcrumb goes up; mp4 and tga are left out; names sort as a person expects', () => {
    assert.deepEqual(r.rootItems, ['FFXIV', 'back ground.png', 'corrupt.png', 'fishing.jpg', 'fishing.png']);
  });
  check('the filter searches the whole tree below and says where a match lives; clicking that opens it', () => {
    assert.deepEqual([r.filterFound, r.filterWhere, r.whereOpens], [true, 'FFXIV/BEAR/Shared_Actions', true]);
  });
  check('Enter chooses; a path with spaces and parentheses is stored as is', () => assert.equal(r.enterSaved, true));
  check('a file the deck cannot draw is refused, cannot be chosen, and its thumbnail is the missing icon', () => {
    assert.deepEqual([r.corruptRefused, r.useDisabledForRefused, r.corruptThumbMissing], [true, true, true]);
  });
  check('leaving the Icon tab, selecting another key, or changing page ends the preview; the folder is kept across keys', () => {
    assert.deepEqual([r.tabClears, r.keyChangeClears, r.placeKept, r.pageChangeClears], [true, true, true, true]);
    assert.ok(previewRequests.includes(0), 'no preview on key 0 ever reached the daemon, so its clearing proves nothing');
    assert.equal(r.keyTabShowsPath, '~/Pictures/icons/FFXIV/WOLF/Halo (Area).png');
  });
  check("a key's icon file renamed away, and put back, reaches the grid with no navigation", () => {
    assert.ok(renamedAway && renamedBack, 'the renderer never signalled for the renames');
    assert.deepEqual([r.iconShownBeforeRename, r.renameAwayShowsMissing, r.renameBackShowsIcon], [true, true, true]);
  });
  check('"Use the default" removes only the icon', () => assert.deepEqual([r.removeKeepsAction, r.removeButtonGone], [true, true]));
  check('with the deck connected there is no "not connected" note', () => assert.equal(r.notConnectedNoteShown, false));
  check('the picker is five bands — 5a\'s four with the filter given its own field — and the actions are below the grid', () => {
    assert.deepEqual(r.bands, ['picker-bar', 'picker-bookmarks', 'picker-filter', 'picker-grid', 'picker-bottom']);
    assert.equal(r.actionsBelowGrid, true);
    assert.equal(r.filterIsItsOwnField, true, 'the filter must be its own full-width field, not a glyph inside another control');
  });
}

const saved = await fs.readFile(path.join(configDir, 'config.json'), 'utf8');
const expected = structuredClone(CONFIG);
delete expected.profiles.default.layouts[SERIAL].pages.main.buttons['1'].icon;
check('config.json holds exactly the changes the UI made, in the editor format; the daemon reloaded each save', () => {
  assert.equal(saved, JSON.stringify(expected, null, 2) + '\n');
  assert.ok(reloads >= 4, `only ${reloads} reloads`);
});
const prefsFile = path.join(stateDir, 'editor', 'preferences.json');
const prefs = JSON.parse(await fs.readFile(prefsFile, 'utf8').catch(() => '{}'));
const configEntries = (await fs.readdir(configDir)).sort();
check('bookmarks are kept in the editor preferences file, in the editor state directory', () => {
  assert.deepEqual(prefs.bookmarks, [path.join(icons, 'FFXIV'), path.join(icons, 'FFXIV/WOLF')], 'the seeded pair, after the added one was removed again');
  assert.deepEqual(r?.bookmarksAtEnd, ['★ FFXIV', '★ WOLF']);
});
check('nothing but config.json in the config directory', () => assert.deepEqual(configEntries, ['config.json']));
check('no preview is left on the deck, and key 1 shows no icon, like key 0', () => {
  assert.deepEqual(daemon.sessions.get(SERIAL).previewKeys(), []);
  assert.equal(Buffer.compare(deck.images.get(1), deck.images.get(0)), 0);
});

await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
