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
import { resolvePage, resolveProfile, startPageOf, startProfileOf } from '../../src/config-common.js';
import { pageDeletion } from '../src/renderer/model.js';

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
  store.apply({ kind: 'setIcon', at: at(1), icon: { kind: 'default' } });
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
  store.apply({ kind: 'setIcon', at: at(7), icon: { kind: 'file', path: `${HOME}/Pictures/icons/ffxiv.png` } });
  await store.flush();
  assert.equal(xlMain(JSON.parse(await fs.readFile(file, 'utf8')))['7'].icon, '~/Pictures/icons/ffxiv.png');
  store.close();
});

await check('a built-in is stored as builtin:<name>, as is; a name the checkout does not ship is refused and changes nothing', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  assert.equal(store.apply({ kind: 'setIcon', at: at(7), icon: { kind: 'file', path: 'builtin:speaker-out' } }).ok, true);
  const refused = store.apply({ kind: 'setIcon', at: at(7), icon: { kind: 'file', path: 'builtin:nope' } });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /"builtin:nope" is not a built-in icon/);
  await store.flush();
  assert.equal(xlMain(JSON.parse(await fs.readFile(file, 'utf8')))['7'].icon, 'builtin:speaker-out');
  store.close();
});

await check('assignAction (a library drop) replaces the action and clears icon, label and release action; background and label style stay', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const where = at(0); // { label, icon, action: audio.sink }
  const key = () => store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons['0'];
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelColor', value: '#ff0000' }).ok, true);
  assert.ok(key().icon !== undefined && key().label !== undefined, 'the fixture starts with an icon and a label');
  const before = { ...key(), onRelease: { type: 'keyHold', keys: 'f24', state: 'up' }, background: '#223344' };
  assert.equal(store.apply({ kind: 'putButtons', profile: 'default', serial: XL.serial, page: 'main', writes: [{ index: 0, button: before }] }).ok, true);
  assert.equal(store.apply({ kind: 'assignAction', at: where, action: { type: 'page' } }).ok, true);
  assert.deepEqual(key(), { labelColor: '#ff0000', background: '#223344', action: { type: 'page' } });
  // Onto an empty slot: just the action.
  assert.equal(store.apply({ kind: 'assignAction', at: at(30), action: { type: 'hotkey' } }).ok, true);
  assert.deepEqual(store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons['30'], { action: { type: 'hotkey' } });
  store.close();
});

await check('setActionIcon writes one icon of a state pair on the action — a built-in by name, a file as ~/ — and default removes it; refused where the action has no such pair', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const action = (i: number) => store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons[String(i)]?.action;
  assert.equal(store.apply({ kind: 'assignAction', at: at(30), action: { type: 'audio.micMute' } }).ok, true);
  assert.equal(store.apply({ kind: 'setActionIcon', at: at(30), field: 'iconMuted', icon: { kind: 'file', path: 'builtin:mic-muted' } }).ok, true);
  assert.equal(store.apply({ kind: 'setActionIcon', at: at(30), field: 'iconUnmuted', icon: { kind: 'file', path: `${HOME}/Pictures/on.png` } }).ok, true);
  assert.deepEqual(action(30), { type: 'audio.micMute', iconMuted: 'builtin:mic-muted', iconUnmuted: '~/Pictures/on.png' });
  assert.equal(store.apply({ kind: 'setActionIcon', at: at(30), field: 'iconMuted', icon: { kind: 'default' } }).ok, true);
  assert.deepEqual(action(30), { type: 'audio.micMute', iconUnmuted: '~/Pictures/on.png' });
  for (const refused of [
    { field: 'iconPlaying', icon: { kind: 'file', path: 'builtin:play' } },
    { field: 'iconMuted', icon: { kind: 'none' } },
    { field: 'iconMuted', icon: { kind: 'file', path: 'builtin:nope' } },
  ] as const) {
    assert.equal(store.apply({ kind: 'setActionIcon', at: at(30), ...refused }).ok, false, JSON.stringify(refused));
  }
  assert.equal(store.apply({ kind: 'assignAction', at: at(31), action: { type: 'media.control', method: 'next' } }).ok, true);
  assert.equal(store.apply({ kind: 'setActionIcon', at: at(31), field: 'iconPaused', icon: { kind: 'file', path: 'builtin:stop' } }).ok, false, 'next has no play/pause pair');
  store.close();
});

await check('setPressRelease writes keyHold down and up as a pair, keeping icon and label; null removes both; an empty key is refused', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const key = () => store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons['0'];
  const { label, icon } = key();
  assert.equal(store.apply({ kind: 'setPressRelease', at: at(0), keys: 'f24' }).ok, true);
  assert.deepEqual(key(), { label, icon, action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } });
  assert.equal(store.apply({ kind: 'setPressRelease', at: at(0), keys: ' ' }).ok, false);
  assert.equal(store.apply({ kind: 'setPressRelease', at: at(0), keys: null }).ok, true);
  assert.deepEqual(key(), { label, icon });
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

console.log('label appearance (M4 phase B)');

await check('setLabelStyle writes position, colour and size, and null removes each again', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const where = at(6); // XL main key 6, { label: "Prev", action: media.control }
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelPosition', value: 'top' }).ok, true);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelColor', value: '#ff8800' }).ok, true);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelSize', value: 20 }).ok, true);
  await store.flush();
  assert.equal(
    await fs.readFile(file, 'utf8'),
    expected((c) => {
      const b = xlMain(c)['6'];
      b.labelPosition = 'top';
      b.labelColor = '#ff8800';
      b.labelSize = 20;
    }),
  );
  // Removing them leaves the button, and its action, exactly as it was.
  for (const field of ['labelPosition', 'labelColor', 'labelSize'] as const) {
    assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field, value: null }).ok, true);
  }
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), EXAMPLE, 'back to exactly the original file');
  store.close();
});

await check('setLabelStyle refuses values the renderer could not use', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const where = at(6);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelPosition', value: 'middle' }).ok, false);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelSize', value: 0 }).ok, false);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelSize', value: -4 }).ok, false);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelSize', value: 'big' }).ok, false);
  assert.equal(store.apply({ kind: 'setLabelStyle', at: where, field: 'labelColor', value: '  ' }).ok, false);
  assert.equal(store.state().dirty, false, 'nothing was accepted');
  store.close();
});

await check("the icon's three states are distinct in the file, and each is reachable in one edit", async () => {
  // scope §10: absent = use the action's default; null = deliberately none;
  // a string = that file. One field, three readings.
  const store = await openStore(await configFile(EXAMPLE));
  const where = at(0); // starts with an icon path
  const icon = () => {
    const b = store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons['0'];
    return 'icon' in b ? b.icon : '(absent)';
  };
  assert.equal(typeof icon(), 'string', 'starts as a file');

  // One step from a file straight to "deliberately none" — not clear-then-tick.
  assert.equal(store.apply({ kind: 'setIcon', at: where, icon: { kind: 'none' } }).ok, true);
  assert.equal(icon(), null, 'explicit null, not removed');

  assert.equal(store.apply({ kind: 'setIcon', at: where, icon: { kind: 'default' } }).ok, true);
  assert.equal(icon(), '(absent)', 'the key is gone, so the default will render');

  assert.equal(store.apply({ kind: 'setIcon', at: where, icon: { kind: 'file', path: '~/Pictures/x.png' } }).ok, true);
  assert.equal(icon(), '~/Pictures/x.png');
  store.close();
});

await check('a null icon survives a save and reload as null, not as an absent key', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  assert.equal(store.apply({ kind: 'setIcon', at: at(0), icon: { kind: 'none' } }).ok, true);
  await store.flush();
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /"icon": null/, 'written as null in the file');
  // And the daemon's own validator accepts it.
  const reparsed = JSON.parse(text) as Config;
  assert.equal(reparsed.profiles.default.layouts[XL.serial].pages.main.buttons['0'].icon, null);
  store.close();
});

await check('a label-only button is expressible: removing the icon keeps the label and the action', async () => {
  // scope §2/§10: a label with no icon is a finished button, not a placeholder.
  const store = await openStore(await configFile(EXAMPLE));
  const where = at(0); // { label: "Output A", icon: "~/...", action: audio.sink }
  assert.equal(store.apply({ kind: 'setIcon', at: where, icon: { kind: 'default' } }).ok, true);
  const button = store.state().config.profiles.default.layouts[XL.serial].pages.main.buttons['0'];
  assert.equal(button.icon, undefined, 'the icon is gone');
  assert.equal(button.label, 'Output A', 'the label stays');
  assert.ok(button.action, 'the action stays');
  store.close();
});

console.log('renaming a deck (M4 phase B)');

await check('renameDeck writes decks.<serial>.name, and clearing it removes the field', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  assert.equal(store.apply({ kind: 'renameDeck', serial: XL.serial, name: '  Left XL  ' }).ok, true);
  assert.equal(store.state().config.decks![XL.serial].name, 'Left XL', 'trimmed');
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), expected((c) => (c.decks![XL.serial].name = 'Left XL')));

  // Clearing it leaves brightness alone — the entry is not wiped.
  assert.equal(store.apply({ kind: 'renameDeck', serial: XL.serial, name: null }).ok, true);
  assert.equal(store.state().config.decks![XL.serial].name, undefined);
  assert.equal(store.state().config.decks![XL.serial].brightness, 70, 'the rest of the deck entry survives');
  store.close();
});

await check('a deck with nothing left on it is removed, rather than leaving an empty entry', async () => {
  // A deck named but never given a brightness: clearing the name should take
  // the whole entry, not leave `"<serial>": {}` behind in the diff.
  const bare: Config = {
    decks: { 'DECK-1': { name: 'Temporary' } },
    profiles: { p1: { layouts: { 'DECK-1': { startPage: 'main', pages: { main: { buttons: {} } } } } } },
  };
  const store = await openStore(await configFile(serializeConfig(bare)));
  assert.equal(store.apply({ kind: 'renameDeck', serial: 'DECK-1', name: '' }).ok, true);
  assert.equal(store.state().config.decks, undefined, '"decks" itself goes when it is empty');
  store.close();
});

await check('a deck the config has never mentioned can be named', async () => {
  const noDecks: Config = {
    profiles: { p1: { layouts: { 'DECK-9': { startPage: 'main', pages: { main: { buttons: {} } } } } } },
  };
  const store = await openStore(await configFile(serializeConfig(noDecks)));
  assert.equal(store.state().config.decks, undefined);
  assert.equal(store.apply({ kind: 'renameDeck', serial: 'DECK-9', name: 'Right XL' }).ok, true);
  assert.equal(store.state().config.decks!['DECK-9'].name, 'Right XL');
  store.close();
});

console.log('add profile and add layout (M4 phase B, B1)');

const XL_SERIAL = 'REPLACE-WITH-XL-SERIAL';
const V2_SERIAL = 'REPLACE-WITH-ORIGINAL-V2-SERIAL';

await check('addProfile covers every deck it names, each with one empty start page', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const r = store.apply({ kind: 'addProfile', name: 'FFXIV', serials: [XL_SERIAL, V2_SERIAL], pageName: 'Main' });
  assert.deepEqual(r, { ok: true, result: { profileId: 'prof_beef' } });
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  const layout = () => ({ startPage: 'pg_beef', pages: { pg_beef: { name: 'Main', buttons: {} } } });
  assert.equal(
    after,
    expected((c) => {
      c.profiles.prof_beef = { name: 'FFXIV', layouts: { [XL_SERIAL]: layout(), [V2_SERIAL]: layout() } };
    }),
  );
  // Nothing outside the new profile moved: the whole edit is added lines.
  const d = await diff(EXAMPLE, after);
  assert.equal(d.removed, 0, `removed ${d.removed}: ${d.removedLines.join(' | ')}`);
  assert.equal(d.added, 23, 'the new profile and its two layouts, and nothing else');
  store.close();
});

await check('addProfile writes startPage explicitly, and the daemon starts the deck there', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  assert.equal(store.apply({ kind: 'addProfile', name: 'FFXIV', serials: [XL_SERIAL], pageName: 'Main' }).ok, true);
  const layout = store.state().config.profiles.prof_beef.layouts[XL_SERIAL];
  assert.equal(layout.startPage, 'pg_beef');
  assert.equal(startPageOf(layout), 'pg_beef', "the daemon's own startPageOf");
  store.close();
});

await check('addProfile refuses a duplicate name, a name equal to a profile ID, a blank name and no decks', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const base = { kind: 'addProfile' as const, serials: [XL_SERIAL], pageName: 'Main' };
  // validateConfig would refuse both of these anyway, so assert the editor's
  // own message: without it these passed with the clash check deleted.
  const refusal = (name: string) => {
    const r = store.apply({ ...base, name });
    assert.equal(r.ok, false, name);
    return r.ok ? '' : r.error;
  };
  assert.match(refusal('Game'), /already a profile called "Game"/, 'existing name');
  assert.match(refusal('prof_game'), /already a profile called "prof_game"/, 'existing ID');
  assert.equal(store.apply({ ...base, name: '  ' }).ok, false, 'blank name');
  assert.equal(store.apply({ kind: 'addProfile', name: 'FFXIV', serials: [], pageName: 'Main' }).ok, false, 'no decks');
  assert.equal(store.apply({ kind: 'addProfile', name: 'FFXIV', serials: [XL_SERIAL], pageName: ' ' }).ok, false, 'blank page name');
  assert.equal(store.state().dirty, false);
  store.close();
});

await check('addProfile never reuses a profile ID, and a repeated deck makes one layout', async () => {
  const ids = ['beef', 'beef', 'cafe'];
  const store = await openStore(await configFile(EXAMPLE), 30, undefined, () => ids.shift() ?? 'ffff');
  // 'beef' is consumed by the first profile's own ID, so its page is 'pg_beef' too.
  assert.deepEqual(store.apply({ kind: 'addProfile', name: 'One', serials: [XL_SERIAL, XL_SERIAL], pageName: 'Main' }), {
    ok: true,
    result: { profileId: 'prof_beef' },
  });
  assert.deepEqual(Object.keys(store.state().config.profiles.prof_beef.layouts), [XL_SERIAL], 'a repeated serial is one layout');
  assert.deepEqual(store.apply({ kind: 'addProfile', name: 'Two', serials: [V2_SERIAL], pageName: 'Main' }), {
    ok: true,
    result: { profileId: 'prof_cafe' },
  });
  store.close();
});

await check('addLayout gives an uncovered deck a layout, and refuses one it already has', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  // prof_game covers the XL only.
  assert.equal(store.apply({ kind: 'addLayout', profile: 'prof_game', serial: XL_SERIAL, pageName: 'Main' }).ok, false, 'already covered');
  assert.deepEqual(store.apply({ kind: 'addLayout', profile: 'prof_game', serial: V2_SERIAL, pageName: 'Emotes' }), { ok: true, result: {} });
  assert.equal(store.apply({ kind: 'addLayout', profile: 'no-such-profile', serial: V2_SERIAL, pageName: 'Main' }).ok, false, 'unknown profile');
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  assert.equal(
    after,
    expected((c) => {
      c.profiles.prof_game.layouts[V2_SERIAL] = { startPage: 'pg_beef', pages: { pg_beef: { name: 'Emotes', buttons: {} } } };
    }),
  );
  store.close();
});

await check('a profile added in the editor is one the daemon accepts and can be switched to by name', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  assert.equal(store.apply({ kind: 'addProfile', name: 'FFXIV', serials: [XL_SERIAL, V2_SERIAL], pageName: 'Main' }).ok, true);
  const config = store.state().config;
  // The store only accepts an edit validateConfig passes, but check the two
  // resolutions a `profile` key depends on, by the daemon's own functions.
  assert.equal(resolveProfile(config, 'FFXIV'), 'prof_beef', 'by name');
  assert.equal(resolveProfile(config, 'prof_beef'), 'prof_beef', 'by ID');
  store.close();
});

console.log('rename page (pulled forward from M5, 2026-09-16)');

await check('renaming a page takes links that reached it by name to the new name, and leaves ID links alone', async () => {
  // The editor writes IDs, but a hand-written link uses the name — and a
  // startPage may too. They follow the page in the form they were written
  // (the maintainer, 2026-09-19): a name stays a name, so the file stays readable.
  const byName: Config = {
    profiles: {
      p1: {
        layouts: {
          [XL.serial]: {
            startPage: 'Combat',
            pages: {
              home: {
                name: 'Home',
                buttons: {
                  '0': { action: { type: 'page', to: 'Combat' } },
                  '1': { action: { type: 'page', to: 'combat' } },
                },
              },
              combat: {
                name: 'Combat',
                buttons: {
                  '0': { onRelease: { type: 'page', to: 'Home' } },
                  '1': { action: { type: 'multi', steps: [{ type: 'page', to: 'Combat' }] } },
                },
              },
            },
          },
        },
      },
    },
  };
  const store = await openStore(await configFile(serializeConfig(byName)));
  assert.equal(store.apply({ kind: 'renamePage', profile: 'p1', serial: XL.serial, page: 'combat', name: 'Battle' }).ok, true);
  const layout = store.state().config.profiles.p1.layouts[XL.serial];
  assert.equal(layout.pages.combat.name, 'Battle');
  assert.equal(layout.startPage, 'Battle', 'startPage follows the name');
  assert.deepEqual(layout.pages.home.buttons['0'].action, { type: 'page', to: 'Battle' }, 'a name link follows the name');
  assert.deepEqual(layout.pages.home.buttons['1'].action, { type: 'page', to: 'combat' }, 'an ID link is left as it was');
  assert.deepEqual(layout.pages.combat.buttons['1'].action, { type: 'multi', steps: [{ type: 'page', to: 'Battle' }] }, 'inside a multi too');
  // A link to a *different* page is untouched.
  assert.deepEqual(layout.pages.combat.buttons['0'].onRelease, { type: 'page', to: 'Home' });
  // And the daemon still resolves everything to the same page.
  assert.equal(startPageOf(layout), 'combat');
  assert.equal(resolvePage(layout, 'Battle'), 'combat');
  store.close();
});

await check('a rename that changes nothing writes nothing, and a config using IDs is untouched', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  // Same name again.
  assert.equal(store.apply({ kind: 'renamePage', profile: 'default', serial: XL.serial, page: 'main', name: 'Main' }).ok, true);
  assert.equal(store.state().dirty, false, 'no write for a no-op rename');
  // A real rename of a page nothing links to by name leaves other keys alone.
  assert.equal(store.apply({ kind: 'renamePage', profile: 'default', serial: XL.serial, page: 'main', name: 'Home' }).ok, true);
  const layout = store.state().config.profiles.default.layouts[XL.serial];
  assert.equal(layout.pages.main.name, 'Home');
  // Only links to the *renamed* page are pinned; this one points at Games, so
  // renaming Main must leave it exactly as it was.
  assert.deepEqual(layout.pages.main.buttons['24'].action, { type: 'page', to: 'Games' }, 'a link to another page is untouched');
  store.close();
});

await check('renaming refuses a clash, a blank name, and an unknown page', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const where = { kind: 'renamePage' as const, profile: 'default', serial: XL.serial };
  assert.equal(store.apply({ ...where, page: 'main', name: 'Games' }).ok, false, "another page's name");
  assert.equal(store.apply({ ...where, page: 'main', name: 'games' }).ok, false, "another page's ID");
  assert.equal(store.apply({ ...where, page: 'main', name: '   ' }).ok, false, 'blank');
  assert.equal(store.apply({ ...where, page: 'nope', name: 'X' }).ok, false, 'unknown page');
  // Its own ID is allowed — validateConfig only refuses a name that is *another* entry's ID.
  assert.equal(store.apply({ ...where, page: 'main', name: 'main' }).ok, true);
  store.close();
});

console.log('rename profile (M5)');

/** Two profiles on two decks, linked to each other by name and by ID, in keys, a multi and startProfile. */
function profileLinkConfig(): Config {
  return {
    startProfile: 'Raid',
    profiles: {
      home: {
        name: 'Home',
        layouts: {
          [XL.serial]: {
            pages: {
              main: {
                name: 'Main',
                buttons: {
                  '0': { label: 'Raid', action: { type: 'profile', to: 'Raid' } },
                  '1': { action: { type: 'profile', to: 'prof_raid' } },
                  '2': { action: { type: 'multi', steps: [{ type: 'hotkey', keys: 'f1' }, { type: 'profile', to: 'Raid' }] } },
                },
              },
            },
          },
        },
      },
      prof_raid: {
        name: 'Raid',
        layouts: {
          [V2_SERIAL]: {
            pages: { main: { name: 'Main', buttons: { '4': { onRelease: { type: 'profile', to: 'Home' } } } } },
          },
        },
      },
    },
  };
}

await check('renaming a profile takes name links everywhere in the config to the new name, and leaves ID links alone', async () => {
  const store = await openStore(await configFile(serializeConfig(profileLinkConfig())));
  assert.equal(store.apply({ kind: 'renameProfile', profile: 'prof_raid', name: 'Savage' }).ok, true);
  const config = store.state().config;
  assert.equal(config.profiles.prof_raid.name, 'Savage');
  assert.equal(config.startProfile, 'Savage', 'startProfile follows the name');
  const main = config.profiles.home.layouts[XL.serial].pages.main.buttons;
  assert.deepEqual(main['0'], { label: 'Raid', action: { type: 'profile', to: 'Savage' } }, 'a name link in another profile follows; the label is not touched');
  assert.deepEqual(main['1'].action, { type: 'profile', to: 'prof_raid' }, 'an ID link is left as it was');
  assert.deepEqual(main['2'].action, { type: 'multi', steps: [{ type: 'hotkey', keys: 'f1' }, { type: 'profile', to: 'Savage' }] }, 'inside a multi too');
  // A link to the *other* profile is untouched.
  assert.deepEqual(config.profiles.prof_raid.layouts[V2_SERIAL].pages.main.buttons['4'].onRelease, { type: 'profile', to: 'Home' });
  // The daemon resolves every one of them to the same profile as before.
  assert.equal(startProfileOf(config), 'prof_raid');
  assert.equal(resolveProfile(config, 'Savage'), 'prof_raid');
  assert.equal(resolveProfile(config, 'Raid'), null, 'the old name no longer resolves, so nothing may still use it');
  store.close();
});

await check('renaming a profile nothing links to by name changes only its name; the same name again writes nothing', async () => {
  const store = await openStore(await configFile(serializeConfig(profileLinkConfig())));
  assert.equal(store.apply({ kind: 'renameProfile', profile: 'prof_raid', name: 'Raid' }).ok, true);
  assert.equal(store.state().dirty, false, 'no write for a no-op rename');
  // With only an ID link left pointing at Raid, a rename is exactly one changed field.
  const idOnly = profileLinkConfig();
  delete idOnly.startProfile;
  idOnly.profiles.home.layouts[XL.serial].pages.main.buttons = { '1': { action: { type: 'profile', to: 'prof_raid' } } };
  const second = await openStore(await configFile(serializeConfig(idOnly)));
  assert.equal(second.apply({ kind: 'renameProfile', profile: 'prof_raid', name: 'Savage' }).ok, true);
  const after = structuredClone(idOnly);
  after.profiles.prof_raid.name = 'Savage';
  assert.deepEqual(second.state().config, after, 'anything beyond the name changed');
  store.close();
  second.close();
});

await check('renaming a profile refuses a clash, a blank name, and an unknown profile', async () => {
  const store = await openStore(await configFile(serializeConfig(profileLinkConfig())));
  const rename = (profile: string, name: string) => store.apply({ kind: 'renameProfile', profile, name });
  assert.equal(rename('prof_raid', 'Home').ok, false, "another profile's name");
  assert.equal(rename('prof_raid', 'home').ok, false, "another profile's ID");
  assert.equal(rename('prof_raid', '  ').ok, false, 'blank');
  assert.equal(rename('nope', 'X').ok, false, 'unknown profile');
  const clash = rename('prof_raid', 'Home');
  assert.equal(clash.ok === false && clash.error, 'there is already a profile called "Home"', "the editor's own message, not validateConfig's");
  // Its own ID is allowed — validateConfig only refuses a name that is *another* entry's ID.
  assert.equal(rename('prof_raid', 'prof_raid').ok, true);
  assert.equal(resolveProfile(store.state().config, store.state().config.startProfile!), 'prof_raid');
  store.close();
});

console.log('delete page (M4 phase B, B1)');

await check('deleting a page takes the navigation off keys that pointed at it, keeping icon and label', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  // XL "main" key 24 is { label: "Games", background, action: page -> "Games" },
  // linked by the page's *name*, not its ID.
  assert.deepEqual(store.apply({ kind: 'deletePage', profile: 'default', serial: XL_SERIAL, page: 'games' }), { ok: true, result: {} });
  await store.flush();
  assert.equal(
    await fs.readFile(file, 'utf8'),
    expected((c) => {
      const layout = c.profiles.default.layouts[XL_SERIAL];
      delete layout.pages.games;
      delete layout.pages.main.buttons['24'].action;
    }),
  );
  const key24 = store.state().config.profiles.default.layouts[XL_SERIAL].pages.main.buttons['24'];
  assert.deepEqual(key24, { label: 'Games', background: '#2a1f3d' }, 'the key still looks placed');
  store.close();
});

await check('a startPage naming the deleted page moves, and "back" keys are not links', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  assert.equal(store.apply({ kind: 'deletePage', profile: 'default', serial: XL_SERIAL, page: 'main' }).ok, true);
  const layout = store.state().config.profiles.default.layouts[XL_SERIAL];
  assert.equal(layout.startPage, 'games', 'startPage moved to the page that is left');
  assert.equal(startPageOf(layout), 'games', "the daemon's own startPageOf agrees");
  // { type: "page", back: true } names no page, so it is not a link to anything.
  assert.deepEqual(layout.pages.games.buttons['0'].action, { type: 'page', back: true });
  store.close();
});

await check("a layout's last page cannot be deleted, and an unknown page is refused", async () => {
  const store = await openStore(await configFile(EXAMPLE));
  // prof_game covers the XL with one page, and its startPage names it ("Hotbar").
  const last = store.apply({ kind: 'deletePage', profile: 'prof_game', serial: XL_SERIAL, page: 'pg_hotbar' });
  assert.equal(last.ok, false);
  assert.match(last.ok ? '' : last.error, /at least one page/);
  assert.equal(store.apply({ kind: 'deletePage', profile: 'default', serial: XL_SERIAL, page: 'nope' }).ok, false, 'unknown page');
  assert.equal(store.state().dirty, false, 'a refused delete changes nothing');
  store.close();
});

await check('only the layout that owns the page is scanned, and a multi loses just the step that pointed there', async () => {
  const OTHER = 'SERIAL-B';
  const linked: Config = {
    profiles: {
      p1: {
        layouts: {
          [XL_SERIAL]: {
            startPage: 'home',
            pages: {
              home: {
                name: 'Home',
                buttons: {
                  // by ID, by name, on release, and one step of a macro
                  '0': { label: 'A', action: { type: 'page', to: 'combat' } },
                  '1': { label: 'B', action: { type: 'page', to: 'Combat' } },
                  '2': { label: 'C', onRelease: { type: 'page', to: 'combat' } },
                  '3': {
                    label: 'D',
                    action: { type: 'multi', steps: [{ type: 'audio.micMute' }, { type: 'page', to: 'Combat' }] },
                  },
                  '4': { label: 'E', action: { type: 'page', to: 'home' } },
                },
              },
              combat: { name: 'Combat', buttons: { '0': { action: { type: 'page', back: true } } } },
            },
          },
          // Another deck with a page of the same ID *and* name — normal, and
          // what the maintainer's own config does with "main". Its key resolves inside
          // its own layout, so deleting this one must not touch it.
          [OTHER]: {
            startPage: 'own',
            pages: {
              own: { name: 'Own', buttons: { '0': { label: 'Mine', action: { type: 'page', to: 'Combat' } } } },
              combat: { name: 'Combat', buttons: {} },
            },
          },
        },
      },
    },
  };
  const store = await openStore(await configFile(serializeConfig(linked)));
  assert.equal(store.apply({ kind: 'deletePage', profile: 'p1', serial: XL_SERIAL, page: 'combat' }).ok, true);
  const after = store.state().config.profiles.p1;
  const home = after.layouts[XL_SERIAL].pages.home.buttons;
  assert.deepEqual(home['0'], { label: 'A' }, 'linked by ID');
  assert.deepEqual(home['1'], { label: 'B' }, 'linked by name');
  assert.deepEqual(home['2'], { label: 'C' }, 'linked on release');
  assert.deepEqual(home['3'], { label: 'D', action: { type: 'multi', steps: [{ type: 'audio.micMute' }] } }, 'the macro keeps its other step');
  assert.deepEqual(home['4'], { label: 'E', action: { type: 'page', to: 'home' } }, 'a link to another page is untouched');
  assert.deepEqual(
    after.layouts[OTHER].pages.own.buttons['0'],
    { label: 'Mine', action: { type: 'page', to: 'Combat' } },
    "another deck's layout, with a page of the same ID and name, is not scanned",
  );
  assert.ok(after.layouts[OTHER].pages.combat, "and its own page of that ID is still there");
  store.close();
});

await check('a multi whose only step pointed at the page loses the action, not an empty macro', async () => {
  const one: Config = {
    profiles: {
      p1: {
        layouts: {
          [XL_SERIAL]: {
            startPage: 'home',
            pages: {
              home: { buttons: { '0': { icon: '~/x.png', action: { type: 'multi', steps: [{ type: 'page', to: 'combat' }] } } } },
              combat: { buttons: {} },
            },
          },
        },
      },
    },
  };
  const store = await openStore(await configFile(serializeConfig(one)));
  assert.equal(store.apply({ kind: 'deletePage', profile: 'p1', serial: XL_SERIAL, page: 'combat' }).ok, true);
  assert.deepEqual(store.state().config.profiles.p1.layouts[XL_SERIAL].pages.home.buttons['0'], { icon: '~/x.png' });
  store.close();
});

await check("the confirmation's preview matches what the delete actually does", async () => {
  // pageDeletion (renderer, for the dialog) and applyEdit (main, authoritative)
  // each decide where the start page lands. This is what stops them drifting.
  // Three pages, so "the first page that is left" is a different answer from
  // "the last one": with two, every choice of remaining page coincides.
  const three: Config = {
    profiles: {
      p1: {
        layouts: {
          [XL_SERIAL]: {
            startPage: 'a',
            pages: {
              a: { name: 'A', buttons: { '0': { action: { type: 'page', to: 'b' } } } },
              b: { name: 'B', buttons: { '0': { action: { type: 'page', to: 'A' } } } },
              c: { name: 'C', buttons: {} },
            },
          },
        },
      },
    },
  };
  const cases: Array<[string, string, string, string]> = [
    [EXAMPLE, 'default', XL_SERIAL, 'games'],
    [EXAMPLE, 'default', XL_SERIAL, 'main'],
    [EXAMPLE, 'prof_game', XL_SERIAL, 'pg_hotbar'],
    [serializeConfig(three), 'p1', XL_SERIAL, 'a'],
  ];
  for (const [text, profile, serial, page] of cases) {
    const store = await openStore(await configFile(text));
    const before = store.state().config;
    const preview = pageDeletion(before, profile, serial, page)!;
    const layoutBefore = before.profiles[profile].layouts[serial];
    const startedOn = startPageOf(layoutBefore);
    const result = store.apply({ kind: 'deletePage', profile, serial, page });

    if (preview.refusal !== null) {
      assert.equal(result.ok, false, `${page}: preview refused but the edit went through`);
      store.close();
      continue;
    }
    assert.equal(result.ok, true, `${page}: preview allowed it but the edit failed`);
    const layoutAfter = store.state().config.profiles[profile].layouts[serial];
    assert.equal(startPageOf(layoutAfter), preview.startPageAfter ?? startedOn, `${page}: start page`);
    for (const link of preview.links) {
      const button = layoutAfter.pages[link.page].buttons[String(link.index)];
      const action = button?.[link.where];
      const stillThere = action?.type === 'page' || (action?.type === 'multi' && JSON.stringify(action.steps).includes('"page"'));
      assert.equal(stillThere, false, `${page}: ${link.page} key ${link.index} kept its navigation`);
    }
    store.close();
  }
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
      store.apply({ kind: 'setIcon', at: loc, icon: { kind: 'file', path: `${HOME}/Pictures/icons/FFXIV/IconKit Battle(Set)/14_BEAR/Bolt_${i}.png` } });
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

/**
 * Phase A shows other action types read-only, but their icon and label stay
 * editable. Every key whose action is not a hotkey (or that has onRelease):
 * set a new icon and label, then remove both — the action, onRelease and
 * every other field must come through untouched.
 */
async function iconAndLabelOnOtherActions(label: string, text: string): Promise<void> {
  await check(`${label}: icon and label edits on non-hotkey keys leave their actions and other fields untouched`, async () => {
    const parsed = JSON.parse(text) as Config;
    const keys: ButtonLocation[] = [];
    for (const [profile, p] of Object.entries(parsed.profiles)) {
      for (const [serial, layout] of Object.entries(p.layouts)) {
        for (const [page, pageDef] of Object.entries(layout.pages)) {
          for (const [index, button] of Object.entries(pageDef.buttons)) {
            if ((button.action && button.action.type !== 'hotkey') || button.onRelease) {
              keys.push({ profile, serial, page, index: Number(index) });
            }
          }
        }
      }
    }
    assert.ok(keys.length > 0, 'the config has no non-hotkey keys, so this checks nothing');
    const types = new Set(keys.map((k) => parsed.profiles[k.profile].layouts[k.serial].pages[k.page].buttons[String(k.index)].action?.type));
    console.log(`       (${keys.length} keys: ${[...types].join(', ')})`);

    const buttonOf = (c: Config, k: ButtonLocation) => c.profiles[k.profile].layouts[k.serial].pages[k.page].buttons[String(k.index)];
    const file = await configFile(text);
    const store = await openStore(file);

    // 1. New icon and label on every one of them.
    for (const k of keys) {
      assert.equal(store.apply({ kind: 'setIcon', at: k, icon: { kind: 'file', path: `${HOME}/Pictures/icons/new ${k.index}.png` } }).ok, true);
      assert.equal(store.apply({ kind: 'setLabel', at: k, label: `new ${k.index}` }).ok, true);
    }
    await store.flush();
    const afterSet = await fs.readFile(file, 'utf8');
    const expectedSet = JSON.parse(text) as Config;
    for (const k of keys) {
      const b = buttonOf(expectedSet, k);
      b.icon = `~/Pictures/icons/new ${k.index}.png`;
      b.label = `new ${k.index}`;
    }
    assert.equal(afterSet, serializeConfig(expectedSet), 'set: file differs from the same change applied directly');
    const setParsed = JSON.parse(afterSet) as Config;
    for (const k of keys) {
      const before = buttonOf(parsed, k);
      const now = buttonOf(setParsed, k);
      assert.deepEqual(now.action, before.action, `action changed on ${JSON.stringify(k)}`);
      assert.deepEqual(now.onRelease, before.onRelease, `onRelease changed on ${JSON.stringify(k)}`);
      const { icon: _i1, label: _l1, ...restNow } = now;
      const { icon: _i2, label: _l2, ...restBefore } = before;
      assert.deepEqual(restNow, restBefore, `another field changed on ${JSON.stringify(k)}`);
    }

    // 2. Remove both again: every key keeps its action, so none disappears.
    for (const k of keys) {
      assert.equal(store.apply({ kind: 'setIcon', at: k, icon: { kind: 'default' } }).ok, true);
      assert.equal(store.apply({ kind: 'setLabel', at: k, label: null }).ok, true);
    }
    await store.flush();
    const cleared = JSON.parse(await fs.readFile(file, 'utf8')) as Config;
    for (const k of keys) {
      const before = buttonOf(parsed, k);
      const now = buttonOf(cleared, k);
      assert.ok(now, `key removed entirely: ${JSON.stringify(k)}`);
      assert.deepEqual(now.action, before.action);
      assert.deepEqual(now.onRelease, before.onRelease);
      assert.equal(now.icon, undefined);
      assert.equal(now.label, undefined);
    }
    store.close();
  });
}

await exitShapedEdit('example config', EXAMPLE);
await iconAndLabelOnOtherActions('example config', EXAMPLE);
if (process.env.DECKHAND_TEST_REAL_CONFIG) {
  const real = await fs.readFile(process.env.DECKHAND_TEST_REAL_CONFIG, 'utf8');
  await exitShapedEdit('copy of a real config', real);
  await iconAndLabelOnOtherActions('copy of a real config', real);
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

console.log('putButtons — every bulk operation (M4 phase B3)');

await check('putButtons writes and empties exactly the slots it names, and the diff shows only those', async () => {
  const file = await configFile(EXAMPLE);
  const store = await openStore(file);
  const before = await fs.readFile(file, 'utf8');
  const copied = structuredClone(xlMain(JSON.parse(EXAMPLE))['0']);
  const result = store.apply({
    kind: 'putButtons',
    profile: 'default',
    serial: XL_SERIAL,
    page: 'main',
    writes: [
      { index: 3, button: copied }, // an empty slot gets a copy of key 0
      { index: 1, button: null }, // an occupied slot is emptied
      { index: 4, button: {} }, // {} is an empty slot, and 4 was already empty
    ],
  });
  assert.deepEqual(result, { ok: true, result: {} });
  await store.flush();
  const after = await fs.readFile(file, 'utf8');
  assert.equal(
    after,
    expected((c) => {
      xlMain(c)['3'] = structuredClone(xlMain(c)['0']);
      delete xlMain(c)['1'];
    }),
  );
  const changed = await diff(before, after);
  assert.equal(changed.removedLines.length, changed.removed);
  store.close();
});

await check('a refused putButtons changes nothing — not even the writes before the bad one', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const where = { kind: 'putButtons' as const, profile: 'default', serial: XL_SERIAL, page: 'main' };
  const twice = store.apply({ ...where, writes: [{ index: 3, button: { label: 'a' } }, { index: 3, button: { label: 'b' } }] });
  assert.equal(twice.ok, false, 'one slot written twice');
  assert.equal(store.apply({ ...where, writes: [{ index: 3, button: { label: 'a' } }, { index: -1, button: null }] }).ok, false, 'a bad index');
  assert.equal(store.apply({ ...where, page: 'nope', writes: [{ index: 3, button: { label: 'a' } }] }).ok, false, 'an unknown page');
  assert.equal(store.state().dirty, false);
  assert.equal(xlMain(store.state().config)['3'], undefined, 'key 3 was not written by the refused edits');
  store.close();
});

await check('the button written is a copy: changing the edit object afterwards does not reach the config', async () => {
  const store = await openStore(await configFile(EXAMPLE));
  const button = { label: 'mine' };
  store.apply({ kind: 'putButtons', profile: 'default', serial: XL_SERIAL, page: 'main', writes: [{ index: 3, button }] });
  button.label = 'changed';
  assert.equal(xlMain(store.state().config)['3'].label, 'mine');
  store.close();
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
