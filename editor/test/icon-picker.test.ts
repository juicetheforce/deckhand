// The icon picker's file side and pure helpers (M4 phase A, step 5; scope §10).
//
// Always: listing, search, start folder, recent folders and the folder
// watcher against a scratch tree shaped like the maintainer's (nested job folders,
// names with spaces and parentheses, the same name in two formats, files the
// daemon cannot draw); breadcrumbs and arrow-key movement.
// DECKHAND_TEST_REAL_ICONS=<folder>: a read-only search of a real icon tree,
// compared with `find`, and timed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareNames,
  existingFolders,
  FolderWatcher,
  listFolder,
  MAX_RECENT_FOLDERS,
  RecentFolders,
  searchFolder,
  startFolder,
} from '../src/main/icon-browser.js';
import { IconFiles, stamp } from '../src/main/icon-files.js';
import { ICON_CONTENT_TYPES, iconUrl, isShownIcon } from '../src/shared/icons.js';
import { folderCrumbs, moveCursor, parentFolder } from '../src/renderer/picker-model.js';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 8).join('\n       ')}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A scratch "home" holding an icon tree.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-icons-'));
const icons = path.join(home, 'Pictures', 'icons');
async function file(relative: string, contents = 'x'): Promise<string> {
  const full = path.join(icons, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  return full;
}
for (const f of [
  'fishing.png',
  'fishing.jpg',
  'UPPER.PNG',
  'a b (c).png',
  'photo.webp',
  'anim.gif',
  'logo.svg',
  'clip.mp4',
  'Backdrop.tga',
  'favicon.ico',
  'scan.tiff',
  'notes.txt',
  '.hidden.png',
  '.cache/thumb.png',
  'FFXIV/IconKit Battle(Set)/BEAR/Bolt_III.png',
  'FFXIV/IconKit Battle(Set)/BEAR/Flame_IV.png',
  'FFXIV/IconKit Battle(Set)/BEAR/Shared_Actions/Aura.png',
  'FFXIV/IconKit Battle(Set)/WOLF/Halo (Area).png',
  'FFXIV/IconKit Battle(Set)/WOLF/Tricks/Secret of the Lotus.png',
  'Job 2/two.png',
  'Job 10/ten.png',
]) {
  await file(f);
}
await fs.symlink(path.join(icons, 'fishing.png'), path.join(icons, 'linked.png'));
await fs.symlink(path.join(icons, 'Job 2'), path.join(icons, 'linked folder'));
await fs.symlink(path.join(icons, 'nowhere.png'), path.join(icons, 'broken.png'));
// A link back up the tree: a search that followed it would never end.
await fs.symlink(icons, path.join(icons, 'FFXIV', 'loop'));
const locked = path.join(icons, 'locked');
await fs.mkdir(locked);
await fs.writeFile(path.join(locked, 'Bolt_locked.png'), 'x');
await fs.chmod(locked, 0o000);
const runningAsRoot = process.getuid?.() === 0;

await check('shown formats are exactly the ones Chromium and the daemon both draw', () => {
  assert.deepEqual(Object.keys(ICON_CONTENT_TYPES).sort(), ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
  assert.equal(isShownIcon('X.PNG'), true);
  assert.equal(isShownIcon('clip.mp4'), false);
  assert.equal(isShownIcon('scan.tiff'), false, 'TIFF: the daemon draws it, Chromium cannot show a thumbnail');
  assert.equal(isShownIcon('png'), false);
  assert.equal(isShownIcon('.png'), false, 'a dot-file named ".png" has no extension');
  assert.equal(isShownIcon('__proto__'), false);
});

await check('listing: folders then images, sorted as a person expects; hidden, non-image, unshowable and broken entries left out', async () => {
  const listing = await listFolder(icons, home);
  assert.deepEqual(
    listing.folders.map((f) => f.name),
    ['FFXIV', 'Job 2', 'Job 10', 'linked folder', 'locked'],
  );
  assert.deepEqual(
    listing.images.map((f) => f.name),
    ['a b (c).png', 'anim.gif', 'fishing.jpg', 'fishing.png', 'linked.png', 'logo.svg', 'photo.webp', 'UPPER.PNG'],
  );
});

await check('listing: paths absolute, config paths as ~/..., parent given (and null at /)', async () => {
  const listing = await listFolder(icons, home);
  const spaced = listing.images.find((i) => i.name === 'a b (c).png')!;
  assert.equal(spaced.path, path.join(icons, 'a b (c).png'));
  assert.equal(spaced.configPath, '~/Pictures/icons/a b (c).png');
  assert.equal(listing.configPath, '~/Pictures/icons');
  assert.equal(listing.parent, path.join(home, 'Pictures'));
  assert.equal((await listFolder('/', home)).parent, null);
  await assert.rejects(listFolder('Pictures/icons', home), /not an absolute path/);
  await assert.rejects(listFolder(path.join(icons, 'no such folder'), home), /ENOENT/);
});

await check('search: whole subtree, case-insensitive, each match says where it lives, sorted by folder then name', async () => {
  const outcome = await searchFolder(icons, 'BOLT', home);
  const names = outcome.matches.map((m) => `${m.folder} | ${m.name}`);
  assert.deepEqual(names, ['FFXIV/IconKit Battle(Set)/BEAR | Bolt_III.png']);
  assert.equal(outcome.matches[0].configPath, '~/Pictures/icons/FFXIV/IconKit Battle(Set)/BEAR/Bolt_III.png');
  assert.equal(outcome.truncated, false);
  const fishing = await searchFolder(icons, 'fishing', home);
  assert.deepEqual(fishing.matches.map((m) => `${m.folder}|${m.name}`), ['|fishing.jpg', '|fishing.png'], 'both formats, the open folder itself as ""');
});

await check('search: skips hidden entries and files it does not show; finds names with spaces and parentheses', async () => {
  assert.equal((await searchFolder(icons, 'thumb', home)).matches.length, 0, '.cache/ is hidden');
  assert.equal((await searchFolder(icons, 'hidden', home)).matches.length, 0);
  assert.equal((await searchFolder(icons, 'clip', home)).matches.length, 0);
  assert.deepEqual((await searchFolder(icons, 'halo (area)', home)).matches.map((m) => m.name), ['Halo (Area).png']);
  assert.deepEqual((await searchFolder(icons, 'lotus', home)).matches.map((m) => m.folder), ['FFXIV/IconKit Battle(Set)/WOLF/Tricks']);
});

await check('search: does not follow a symlinked folder (a loop back up the tree ends, no duplicates)', async () => {
  const outcome = await searchFolder(icons, 'aura', home);
  assert.equal(outcome.matches.length, 1);
  assert.equal(outcome.matches[0].folder, 'FFXIV/IconKit Battle(Set)/BEAR/Shared_Actions');
  // "two.png" is reachable only through "linked folder" besides its real place.
  assert.deepEqual((await searchFolder(icons, 'two', home)).matches.map((m) => m.folder), ['Job 2']);
});

await check('search: an unreadable folder is skipped, not an error', async () => {
  if (runningAsRoot) return console.log('       (skipped as root)');
  const outcome = await searchFolder(icons, 'bolt', home);
  assert.deepEqual(outcome.matches.map((m) => m.name), ['Bolt_III.png']);
});

await check('search: stops at the entry cap and at the match cap, and says so', async () => {
  const fewEntries = await searchFolder(icons, 'png', home, () => true, { maxEntries: 5 });
  assert.equal(fewEntries.truncated, true);
  const fewMatches = await searchFolder(icons, '.', home, () => true, { maxMatches: 3 });
  assert.equal(fewMatches.truncated, true);
  assert.equal(fewMatches.matches.length, 3);
  const all = await searchFolder(icons, '.', home);
  assert.equal(all.truncated, false);
});

await check('search: a replaced search stops between folders; an empty query finds nothing', async () => {
  let asked = 0;
  const outcome = await searchFolder(icons, 'png', home, () => ++asked < 3);
  assert.equal(outcome.cancelled, true);
  assert.equal(asked, 3);
  assert.deepEqual(await searchFolder(icons, '   ', home), { matches: [], truncated: false, cancelled: false });
});

await check('start folder: the icon\'s folder, else a recent one that exists, else the first fallback that exists', async () => {
  const bear = path.join(icons, 'FFXIV/IconKit Battle(Set)/BEAR');
  assert.equal(await startFolder(path.join(bear, 'Flame_IV.png'), [icons], [home]), bear);
  assert.equal(await startFolder(path.join(icons, 'gone/x.png'), ['/nope', icons], [home]), icons);
  assert.equal(await startFolder(null, ['relative/path', '/nope'], ['/also/nope', path.join(home, 'Pictures'), home]), path.join(home, 'Pictures'));
  assert.equal(await startFolder(null, [], ['/nope']), '/nope', 'the last fallback, even if missing, rather than nothing');
});

await check('recent folders: newest first, no duplicates, capped, kept in the given file; bad file contents are an empty list', async () => {
  const stateFile = path.join(home, 'state', 'editor', 'icon-picker.json');
  const recent = new RecentFolders(stateFile);
  assert.deepEqual(await recent.list(), []);
  for (let i = 0; i < 8; i++) await recent.remember(`/f${i}`);
  await recent.remember('/f5');
  const list = await recent.list();
  assert.equal(list.length, MAX_RECENT_FOLDERS);
  assert.deepEqual(list, ['/f5', '/f7', '/f6', '/f4', '/f3', '/f2']);
  assert.deepEqual((await fs.readdir(path.dirname(stateFile))).sort(), ['icon-picker.json'], 'no temporary file left');
  await fs.writeFile(stateFile, '{"recentFolders": ["/ok", 3, "relative", null]}');
  assert.deepEqual(await recent.list(), ['/ok']);
  await fs.writeFile(stateFile, 'not json');
  assert.deepEqual(await recent.list(), []);
  assert.deepEqual((await existingFolders([icons, '/nope'], home)).map((f) => f.configPath), ['~/Pictures/icons']);
});

await check('watcher: a burst of changes in the open folder is reported once; another folder\'s changes are not', async () => {
  const seen: string[] = [];
  const watcher = new FolderWatcher((folder) => seen.push(folder));
  const job2 = path.join(icons, 'Job 2');
  const job10 = path.join(icons, 'Job 10');
  watcher.watch(job2);
  await sleep(50);
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(job2, `new${i}.png`), 'x');
  await sleep(600);
  assert.deepEqual(seen, [job2]);
  watcher.watch(job10);
  await sleep(50);
  await fs.writeFile(path.join(job2, 'later.png'), 'x');
  await sleep(400);
  assert.deepEqual(seen, [job2], 'the old folder is no longer watched');
  await fs.writeFile(path.join(job10, 'x.png'), 'x');
  await sleep(400);
  assert.deepEqual(seen, [job2, job10]);
  watcher.close();
  await fs.writeFile(path.join(job10, 'y.png'), 'x');
  await sleep(400);
  assert.deepEqual(seen, [job2, job10], 'closed: nothing more');
});

await check('icon stamps: a file, a missing file, and ~ expanded', async () => {
  const file = path.join(icons, 'fishing.png');
  const first = await stamp(file);
  assert.match(first, /^\d+-\d+$/);
  assert.equal(await stamp(path.join(icons, 'no-such.png')), 'missing');
  await fs.writeFile(file, 'changed, so bigger');
  assert.notEqual(await stamp(file), first);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(await stamp('~/Pictures/icons/fishing.png'), await stamp(file));
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
  assert.equal(iconUrl('~/a b.png', '12-34'), 'deckhand-icon://icon/?path=~%2Fa%20b.png&v=12-34');
  assert.equal(iconUrl('~/a b.png'), 'deckhand-icon://icon/?path=~%2Fa%20b.png');
});

await check('icon files: a watched icon renamed away, put back, or replaced is reported; unrelated writes are not', async () => {
  const reports: Array<Record<string, string>> = [];
  const files = new IconFiles((stamps) => reports.push(stamps));
  const watched = path.join(icons, 'Job 2', 'two.png');
  const other = path.join(icons, 'Job 10', 'ten.png');
  const initial = await files.watchFiles([watched, other]);
  assert.equal(Object.keys(initial).length, 2);
  assert.match(initial[watched], /^\d+-\d+$/);

  await fs.rename(watched, watched + '.away');
  await sleep(500);
  assert.equal(reports.at(-1)?.[watched], 'missing', 'renaming it away was not reported');
  assert.equal(reports.at(-1)?.[other], initial[other], 'the untouched icon kept its stamp');

  await fs.rename(watched + '.away', watched);
  await sleep(500);
  assert.match(String(reports.at(-1)?.[watched]), /^\d+-\d+$/, 'putting it back was not reported');

  const before = reports.length;
  await fs.writeFile(path.join(icons, 'Job 2', 'not-an-icon-of-ours.png'), 'x');
  await sleep(500);
  assert.equal(reports.length, before, 'a write to a file no key uses must not be reported');

  // Watching a different set drops the old folder.
  await files.watchFiles([other]);
  const afterSwitch = reports.length;
  await fs.writeFile(watched, 'changed again');
  await sleep(500);
  assert.equal(reports.length, afterSwitch, 'the folder of an icon no longer shown is no longer watched');

  files.close();
  await fs.writeFile(other, 'changed');
  await sleep(400);
  assert.equal(reports.length, afterSwitch, 'closed: nothing more');
});

await check('names sort case-insensitively with numbers in order', () => {
  assert.deepEqual(['Job 10', 'job 2', 'Aura', 'aura'].sort(compareNames), ['Aura', 'aura', 'job 2', 'Job 10']);
});

await check('breadcrumbs: ~ for home, one segment per folder, each opening its own absolute path', () => {
  assert.deepEqual(folderCrumbs('/home/r/Pictures/icons', '~/Pictures/icons'), [
    { label: '~', path: '/home/r' },
    { label: 'Pictures', path: '/home/r/Pictures' },
    { label: 'icons', path: '/home/r/Pictures/icons' },
  ]);
  assert.deepEqual(folderCrumbs('/home/r', '~'), [{ label: '~', path: '/home/r' }]);
  assert.deepEqual(folderCrumbs('/usr/share/icons', '/usr/share/icons'), [
    { label: '/', path: '/' },
    { label: 'usr', path: '/usr' },
    { label: 'share', path: '/usr/share' },
    { label: 'icons', path: '/usr/share/icons' },
  ]);
  assert.deepEqual(folderCrumbs('/', '/'), [{ label: '/', path: '/' }]);
  assert.deepEqual(folderCrumbs('/home/r/A B (c)', '~/A B (c)').map((c) => c.path), ['/home/r', '/home/r/A B (c)']);
  assert.equal(parentFolder('/home/r/icons/x.png'), '/home/r/icons');
  assert.equal(parentFolder('/x.png'), '/');
});

await check('arrow keys: move by one or by a row, stop at the edges, start at the first item', () => {
  // 10 items in 4 columns: rows 0-3, 4-7, 8-9.
  assert.equal(moveCursor(10, 4, -1, 'ArrowDown'), 0);
  assert.equal(moveCursor(10, 4, 0, 'ArrowRight'), 1);
  assert.equal(moveCursor(10, 4, 0, 'ArrowLeft'), 0);
  assert.equal(moveCursor(10, 4, 1, 'ArrowDown'), 5);
  assert.equal(moveCursor(10, 4, 6, 'ArrowDown'), 6, 'no item below: stays');
  assert.equal(moveCursor(10, 4, 2, 'ArrowUp'), 2);
  assert.equal(moveCursor(10, 4, 9, 'ArrowRight'), 9);
  assert.equal(moveCursor(10, 4, 5, 'Home'), 0);
  assert.equal(moveCursor(10, 4, 5, 'End'), 9);
  assert.equal(moveCursor(0, 4, -1, 'ArrowRight'), -1);
  assert.equal(moveCursor(10, 0, 3, 'ArrowDown'), 4, 'a zero column count is treated as one');
});

const realTree = process.env.DECKHAND_TEST_REAL_ICONS;
if (realTree) {
  await check(`real tree ${realTree}: search finds every shown image find(1) finds, and how long it takes`, async () => {
    const started = performance.now();
    const all = await searchFolder(realTree, '.', os.homedir(), () => true, { maxMatches: 1_000_000 });
    const searchMs = performance.now() - started;
    const found = execFileSync('find', [realTree, '-not', '-path', '*/.*', '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p !== '' && isShownIcon(p));
    assert.equal(all.truncated, false);
    assert.equal(all.matches.length, found.length);
    const rootStarted = performance.now();
    const root = await listFolder(realTree, os.homedir());
    const listMs = performance.now() - rootStarted;
    console.log(
      `       ${all.matches.length} images; whole-tree search ${searchMs.toFixed(0)} ms; root listing ${listMs.toFixed(1)} ms (${root.folders.length} folders, ${root.images.length} images)`,
    );
  });
}

if (!runningAsRoot) await fs.chmod(locked, 0o700);
await fs.rm(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nicon picker: all checks passed' : `\nicon picker: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
