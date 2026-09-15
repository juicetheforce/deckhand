// Offline test of the editor's config store (M4 phase A, step 1).
// Bundled by scripts/run-tests.mjs and run with plain Node — no Electron.
//
// Uses the daemon's real watchConfig() from the built dist/config.js to count
// reloads, so "one save is one daemon reload" is checked against the daemon's
// own code. Set DECKHAND_TEST_REAL_CONFIG to a copy of a real config.json to
// also run the exit-shaped edit against it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../../src/types.js';
import { serializeConfig, toConfigPath, type ButtonLocation } from '../src/main/config-document.js';
import { ConfigStore, type StoreState } from '../src/main/config-store.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-editor-store-'));
const WATCHED_DIR = path.join(TMP, 'watched');
await fs.mkdir(WATCHED_DIR);
// Before importing the daemon's config module, which reads this when imported.
process.env.DECKHAND_CONFIG_DIR = WATCHED_DIR;
const daemonConfig = await import(pathToFileURL(path.join(REPO, 'dist/config.js')).href);
const watchConfig: (onChange: () => void) => () => void = daemonConfig.watchConfig;

const EXAMPLE = await fs.readFile(path.join(REPO, 'config.example.json'), 'utf8');
const HOME = os.homedir();
const XL: Omit<ButtonLocation, 'index'> = { profile: 'default', serial: 'REPLACE-WITH-XL-SERIAL', page: 'main' };
const at = (index: number): ButtonLocation => ({ ...XL, index });

let failures = 0;
let dirCounter = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh config directory holding `text` as config.json. */
async function configFile(text: string, dir?: string): Promise<string> {
  const target = dir ?? path.join(TMP, `c${++dirCounter}`);
  await fs.mkdir(target, { recursive: true });
  const file = path.join(target, 'config.json');
  await fs.writeFile(file, text);
  return file;
}

async function openStore(file: string, debounceMs = 30, onChange?: (s: StoreState) => void, hex?: () => string) {
  return ConfigStore.open({
    configPath: file,
    debounceMs,
    onChange,
    env: { homeDir: HOME, randomHex: hex ?? (() => 'beef') },
  });
}

/** git diff --numstat between two texts: lines added and removed, and the removed lines themselves. */
async function diff(before: string, after: string): Promise<{ added: number; removed: number; removedLines: string[] }> {
  const a = path.join(TMP, `diff-a-${++dirCounter}`);
  const b = path.join(TMP, `diff-b-${dirCounter}`);
  await fs.writeFile(a, before);
  await fs.writeFile(b, after);
  const stat = spawnSync('git', ['diff', '--no-index', '--numstat', a, b], { encoding: 'utf8' }).stdout.trim();
  const patch = spawnSync('git', ['diff', '--no-index', '-U0', a, b], { encoding: 'utf8' }).stdout;
  const [added, removed] = stat === '' ? [0, 0] : stat.split('\t').map(Number);
  const removedLines = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  return { added, removed, removedLines };
}

/** The example config with a change applied directly, for comparing against what the store wrote. */
function expected(mutate: (c: Config) => void, text = EXAMPLE): string {
  const c = JSON.parse(text) as Config;
  mutate(c);
  return serializeConfig(c);
}
const xlMain = (c: Config) => c.profiles.default.layouts['REPLACE-WITH-XL-SERIAL'].pages.main.buttons;

console.log('edits change only what they name');

await check('opening the example: in the editor format, nothing pending', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const s = store.state();
  assert.equal(s.reformatPending, false);
  assert.equal(s.dirty, false);
  assert.equal(s.conflict, null);
  store.close();
});

await check('setAction on an empty slot writes that button and nothing else', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  assert.deepEqual(store.apply({ kind: 'setAction', at: at(3), action: { type: 'hotkey', keys: 'ctrl+1' } }), { ok: true, result: {} });
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, expected((c) => (xlMain(c)['3'] = { action: { type: 'hotkey', keys: 'ctrl+1' } })));
  const d = await diff(EXAMPLE, after);
  assert.equal(d.removed, 0, `removed ${d.removedLines.join(' | ')}`);
  assert.equal(d.added, 6);
  store.close();
});

await check('setAction replaces only the action on a key with icon and label', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'setAction', at: at(0), action: { type: 'hotkey', keys: 'f24' } });
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  const before = xlMain(JSON.parse(EXAMPLE))['0'];
  const now = xlMain(JSON.parse(after))['0'];
  assert.equal(now.label, before.label);
  assert.equal(now.icon, before.icon);
  assert.deepEqual(Object.keys(now), Object.keys(before), 'key order kept');
  assert.equal(after, expected((c) => (xlMain(c)['0'].action = { type: 'hotkey', keys: 'f24' })));
  store.close();
});

await check('removeAction ("Clear hotkey") keeps icon and label', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'removeAction', at: at(0) });
  await store.flush();
  const now = xlMain(JSON.parse(await fs.readFile(file, 'utf8')))['0'];
  const before = xlMain(JSON.parse(EXAMPLE))['0'];
  assert.equal(now.action, undefined);
  assert.equal(now.label, before.label);
  assert.equal(now.icon, before.icon);
  store.close();
});

await check('removeAction on a key with only an action leaves an empty slot, not {}', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'removeAction', at: at(2) });
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), expected((c) => delete xlMain(c)['2']));
  store.close();
});

await check('clearButton ("Clear button") removes the whole key', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'clearButton', at: at(24) });
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), expected((c) => delete xlMain(c)['24']));
  store.close();
});

await check('setLabel "" removes the label; setIcon null removes the icon', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'setLabel', at: at(1), label: '' });
  store.apply({ kind: 'setIcon', at: at(1), icon: null });
  await store.flush();
  assert.equal(
    await fs.readFile(file, 'utf8'),
    expected((c) => {
      delete xlMain(c)['1'].label;
      delete xlMain(c)['1'].icon;
    }),
  );
  store.close();
});

await check('icon paths under $HOME are stored as ~/..., others as given', async () => {
  assert.equal(toConfigPath(`${HOME}/Pictures/icons/FFXIV/a b(c).png`, HOME), '~/Pictures/icons/FFXIV/a b(c).png');
  assert.equal(toConfigPath(`${HOME}2/icons/x.png`, HOME), `${HOME}2/icons/x.png`, 'a sibling directory sharing the prefix');
  assert.equal(toConfigPath('/usr/share/icons/x.png', HOME), '/usr/share/icons/x.png');
  assert.equal(toConfigPath(HOME, HOME), '~');
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'setIcon', at: at(7), icon: `${HOME}/Pictures/icons/ffxiv.png` });
  await store.flush();
  assert.equal(xlMain(JSON.parse(await fs.readFile(file, 'utf8')))['7'].icon, '~/Pictures/icons/ffxiv.png');
  store.close();
});

await check('an edit that changes nothing writes nothing', async () => {
  const file = await configFile(EXAMPLE);
  const inode = (await fs.stat(file)).ino;
  const store = await openStore(file);
  const label = xlMain(JSON.parse(EXAMPLE))['0'].label ?? null;
  assert.equal(store.apply({ kind: 'setLabel', at: at(0), label }).ok, true);
  assert.equal(store.state().dirty, false);
  await store.flush();
  await sleep(80);
  assert.equal((await fs.stat(file)).ino, inode, 'file was replaced');
  store.close();
});

await check('an edit at a location that does not exist is refused and changes nothing', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const before = serializeConfig(store.state().config);
  for (const bad of [
    { kind: 'setAction', at: { ...at(0), page: 'nope' }, action: { type: 'noop' } },
    { kind: 'setAction', at: { ...at(0), profile: 'nope' }, action: { type: 'noop' } },
    { kind: 'setAction', at: { ...at(0), serial: 'nope' }, action: { type: 'noop' } },
    { kind: 'setAction', at: at(-1), action: { type: 'noop' } },
    { kind: 'setAction', at: at(1.5), action: { type: 'noop' } },
    { kind: 'setAction', at: { ...at(0), page: '__proto__' }, action: { type: 'noop' } },
  ] as const) {
    const r = store.apply(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    // Refused by the location checks, not by a TypeError that happens to be caught.
    assert.match((r as { error: string }).error, /^(no page with ID|no profile with ID|profile "default" has no layout|key index)/, JSON.stringify(bad));
  }
  assert.equal(serializeConfig(store.state().config), before);
  assert.equal(store.state().dirty, false);
  store.close();
});

console.log('add page');

await check('addPage adds an empty named page with a new ID and touches nothing else', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const r = store.apply({ kind: 'addPage', profile: 'default', serial: 'REPLACE-WITH-XL-SERIAL', name: 'Combat' });
  assert.deepEqual(r, { ok: true, result: { pageId: 'pg_beef' } });
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  assert.equal(
    after,
    expected((c) => (c.profiles.default.layouts['REPLACE-WITH-XL-SERIAL'].pages.pg_beef = { name: 'Combat', buttons: {} })),
  );
  const d = await diff(EXAMPLE, after);
  assert.ok(d.removed <= 1, `removed ${d.removed}`);
  store.close();
});

await check('addPage refuses a duplicate name, a name equal to a page ID, and an empty name', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const deck = { kind: 'addPage', profile: 'default', serial: 'REPLACE-WITH-XL-SERIAL' } as const;
  assert.equal(store.apply({ ...deck, name: 'Games' }).ok, false, 'existing name');
  assert.equal(store.apply({ ...deck, name: 'games' }).ok, false, 'existing ID');
  assert.equal(store.apply({ ...deck, name: '   ' }).ok, false, 'blank');
  assert.equal(store.state().dirty, false);
  store.close();
});

await check('addPage never reuses an existing page ID', async () => {
  const ids = ['beef', 'beef', 'cafe'];
  const store = await openStore(await configFile(EXAMPLE), 30, undefined, () => ids.shift() ?? 'ffff');
  assert.deepEqual(store.apply({ kind: 'addPage', profile: 'default', serial: 'REPLACE-WITH-XL-SERIAL', name: 'One' }), { ok: true, result: { pageId: 'pg_beef' } });
  assert.deepEqual(store.apply({ kind: 'addPage', profile: 'default', serial: 'REPLACE-WITH-XL-SERIAL', name: 'Two' }), { ok: true, result: { pageId: 'pg_cafe' } });
  store.close();
});

async function exitShapedEdit(label: string, text: string): Promise<void> {
  await check(`${label}: a new page with hotkeys and icons diffs only inside the new page`, async () => {
    const parsed = JSON.parse(text) as Config;
    const profile = Object.keys(parsed.profiles)[0];
    const serial = Object.keys(parsed.profiles[profile].layouts)[0];
    const file = await configFile(text);
    const store = await openStore(file);
    const r = store.apply({ kind: 'addPage', profile, serial, name: 'Store test page' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const page = (r as { result: { pageId: string } }).result.pageId;
    for (let i = 0; i < 9; i++) {
      const loc = { profile, serial, page, index: i };
      store.apply({ kind: 'setAction', at: loc, action: { type: 'hotkey', keys: `ctrl+${i + 1}` } });
      store.apply({ kind: 'setIcon', at: loc, icon: `${HOME}/Pictures/icons/FFXIV/IconKit Battle(Set)/14_BEAR/Bolt_${i}.png` });
      store.apply({ kind: 'setLabel', at: loc, label: `B${i}` });
    }
    await store.flush();
    const after = await fs.readFile(file, 'utf8');
    const d = await diff(text, after);
    // The only line that may change outside the new page is the closing
    // brace before it, which gains a comma.
    assert.ok(d.removed <= 1, `removed ${d.removed}: ${d.removedLines.join(' | ')}`);
    for (const line of d.removedLines) assert.match(line, /^-\s*}$/);
    const afterParsed = JSON.parse(after) as Config;
    delete afterParsed.profiles[profile].layouts[serial].pages[page];
    assert.equal(serializeConfig(afterParsed), text, 'everything outside the new page is byte-identical');
    console.log(`       (${d.added} lines added, ${d.removed} removed)`);
    store.close();
  });
}

await exitShapedEdit('example config', EXAMPLE);
if (process.env.DECKHAND_TEST_REAL_CONFIG) {
  await exitShapedEdit('copy of a real config', await fs.readFile(process.env.DECKHAND_TEST_REAL_CONFIG, 'utf8'));
}

console.log('saving');

await check('a burst of edits is written once, after the debounce', async () => {
  const file = await configFile(EXAMPLE);
  let saves = 0;
  let wasDirty = false;
  const store = await openStore(file, 60, (s) => {
    if (wasDirty && !s.dirty) saves++;
    wasDirty = s.dirty;
  });
  for (let i = 0; i < 20; i++) {
    store.apply({ kind: 'setLabel', at: at(3), label: `L${i}` });
    await sleep(5);
  }
  assert.equal(saves, 0, 'saved during the burst');
  await sleep(250);
  assert.equal(saves, 1);
  assert.equal(xlMain(JSON.parse(await fs.readFile(file, 'utf8')))['3'].label, 'L19');
  store.close();
});

await check('one save is exactly one daemon reload, and no temporary file is left', async () => {
  const file = await configFile(EXAMPLE, WATCHED_DIR);
  let reloads = 0;
  const stop = watchConfig(() => reloads++);
  await sleep(100);
  const store = await openStore(file);
  for (let n = 0; n < 3; n++) {
    const inode = (await fs.stat(file)).ino;
    store.apply({ kind: 'setLabel', at: at(3), label: `reload ${n}` });
    await store.flush();
    // A new inode means the file was replaced by rename, not rewritten in place.
    assert.notEqual((await fs.stat(file)).ino, inode, 'written in place, not by temp file and rename');
    await sleep(600); // past the daemon watcher's 250 ms debounce
  }
  assert.equal(reloads, 3);
  assert.deepEqual(await fs.readdir(WATCHED_DIR), ['config.json']);
  store.close();
  stop();
});

await check('the file keeps its permissions', async () => {
  const file = await configFile(EXAMPLE);
  await fs.chmod(file, 0o600);
  const store = await openStore(file);
  store.apply({ kind: 'setLabel', at: at(3), label: 'mode' });
  await store.flush();
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  store.close();
});

await check("the editor's own write is not seen as an outside change", async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  store.apply({ kind: 'setLabel', at: at(3), label: 'own write' });
  await store.flush();
  await sleep(300);
  const s = store.state();
  assert.equal(s.conflict, null);
  assert.equal(s.fileError, null);
  assert.equal(s.dirty, false);
  store.close();
});

console.log('changes made outside the editor');

const outside = expected((c) => (xlMain(c)['3'] = { label: 'from outside' }));

await check('with nothing unsaved, an outside change is reloaded silently', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  await fs.writeFile(file, outside);
  await sleep(300);
  assert.equal(xlMain(store.state().config)['3'].label, 'from outside');
  assert.equal(store.state().conflict, null);
  assert.equal(await fs.readFile(file, 'utf8'), outside, 'the editor wrote back');
  store.close();
});

await check('with unsaved edits, an outside change is a conflict and the file is not overwritten', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file, 5000);
  store.apply({ kind: 'setLabel', at: at(4), label: 'mine' });
  await fs.writeFile(file, outside);
  await sleep(300);
  assert.notEqual(store.state().conflict, null);
  assert.equal(store.apply({ kind: 'setLabel', at: at(5), label: 'blocked' }).ok, false, 'edits blocked');
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), outside);
  store.close();
});

await check('resolving a conflict with "file" takes the outside version and discards unsaved edits', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file, 5000);
  store.apply({ kind: 'setLabel', at: at(4), label: 'mine' });
  await fs.writeFile(file, outside);
  await sleep(300);
  await store.resolveConflict('file');
  const s = store.state();
  assert.equal(s.conflict, null);
  assert.equal(s.dirty, false);
  assert.equal(xlMain(s.config)['3'].label, 'from outside');
  assert.equal(xlMain(s.config)['4'], undefined);
  assert.equal(await fs.readFile(file, 'utf8'), outside);
  store.close();
});

await check('resolving a conflict with "mine" writes the editor version', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file, 5000);
  store.apply({ kind: 'setLabel', at: at(4), label: 'mine' });
  await fs.writeFile(file, outside);
  await sleep(300);
  await store.resolveConflict('mine');
  assert.equal(await fs.readFile(file, 'utf8'), expected((c) => (xlMain(c)['4'] = { label: 'mine' })));
  assert.equal(store.state().dirty, false);
  store.close();
});

await check('an outside write landing just before a save is caught as a conflict, not overwritten', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file, 5000);
  store.apply({ kind: 'setLabel', at: at(4), label: 'mine' });
  await fs.writeFile(file, outside);
  await store.flush(); // before the watcher has reported anything
  assert.notEqual(store.state().conflict, null);
  assert.equal(await fs.readFile(file, 'utf8'), outside);
  store.close();
});

await check('an invalid file on disk blocks editing and is never overwritten; fixing it recovers', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const broken = EXAMPLE.slice(0, 200);
  await fs.writeFile(file, broken);
  await sleep(300);
  assert.match(store.state().fileError ?? '', /not valid JSON/);
  assert.equal(store.apply({ kind: 'setLabel', at: at(3), label: 'x' }).ok, false);
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), broken);
  await fs.writeFile(file, outside);
  await sleep(300);
  assert.equal(store.state().fileError, null);
  assert.equal(xlMain(store.state().config)['3'].label, 'from outside');
  store.close();
});

console.log('files the editor must not rewrite blindly');

await check('a file in another format is not saved until the reformat is acknowledged', async () => {
  const fourSpaces = JSON.stringify(JSON.parse(EXAMPLE), null, 4) + '\n';
  const file = await configFile(fourSpaces);
  const store = await openStore(file);
  assert.equal(store.state().reformatPending, true);
  store.apply({ kind: 'setLabel', at: at(3), label: 'reformat' });
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), fourSpaces);
  store.acknowledgeReformat();
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), expected((c) => (xlMain(c)['3'] = { label: 'reformat' })));
  store.close();
});

await check('a v0.1 or otherwise invalid config is refused at open', async () => {
  const v01 = await configFile(JSON.stringify({ decks: { X: { pages: { main: { buttons: {} } } } } }));
  await assert.rejects(openStore(v01), /v0\.1/);
  await assert.rejects(openStore(await configFile('{')), /not valid JSON/);
  await assert.rejects(openStore(path.join(TMP, 'absent', 'config.json')), /ENOENT/);
});

await check('a symlinked config.json is refused — and the daemon really does not see writes through one', async () => {
  const real = await configFile(EXAMPLE);
  const link = path.join(WATCHED_DIR, 'config.json');
  await fs.rm(link, { force: true });
  await fs.symlink(real, link);
  await assert.rejects(openStore(link), /symlink/);
  let reloads = 0;
  const stop = watchConfig(() => reloads++);
  await sleep(100);
  await fs.writeFile(real, outside);
  await sleep(600);
  stop();
  assert.equal(reloads, 0, 'the daemon saw a write through the symlink, so the refusal is unnecessary');
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
