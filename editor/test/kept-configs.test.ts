// The configurations kept before an import or a profile delete (M5 piece 2d,
// src/main/kept-configs.ts). The rules the maintainer decided on 2026-09-19: never
// deleted except by him, a cap that refuses rather than rotates, and no second
// copy of identical bytes.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_KEPT_CONFIGS } from '../src/shared/backup.js';
import { deleteKeptConfig, keepConfigCopy, keptConfigPath, listKeptConfigs } from '../src/main/kept-configs.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), 'dh-kept-'));

/** A config with `profiles` named, `decks` layouts each, and `keys` buttons in all. */
function config(profiles: string[], keys: number): string {
  const buttons: Record<string, unknown> = {};
  for (let i = 0; i < keys; i++) buttons[String(i)] = { action: { type: 'noop' } };
  return JSON.stringify({
    profiles: Object.fromEntries(
      profiles.map((name, i) => [`prof_${i}`, { name, layouts: { 'DECK-A': { pages: { main: { name: 'Main', buttons: i === 0 ? buttons : {} } } } } }]),
    ),
  });
}

console.log('kept configurations');

await check('the list says what is in each copy, newest first, and ignores the rolling backups', async () => {
  const dir = await scratch();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'before-delete-2026-09-01T10-00-00.000Z.json'), config(['Default', 'FFXIV'], 61));
  await fs.writeFile(path.join(dir, 'before-import-2026-09-19T22-05-27.962Z.json'), config(['Default'], 3));
  // Not ours: the rolling rotation's, and something else entirely.
  await fs.writeFile(path.join(dir, 'config-2026-09-18T18-56-07.054Z.json'), config(['Default'], 1));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
  const entries = await listKeptConfigs(dir);
  assert.deepEqual(
    entries.map((e) => [e.reason, e.keptAt, e.summary]),
    [
      ['import', '2026-09-19T22:05:27.962Z', { profiles: ['Default'], decks: 1, keys: 3 }],
      ['delete', '2026-09-01T10:00:00.000Z', { profiles: ['Default', 'FFXIV'], decks: 1, keys: 61 }],
    ],
  );
  assert.ok(entries.every((e) => e.bytes > 0));
});

await check('a copy that cannot be read is listed with why, not hidden', async () => {
  const dir = await scratch();
  await fs.writeFile(path.join(dir, 'before-delete-2026-09-01T10-00-00.000Z.json'), 'not json at all');
  const [entry] = await listKeptConfigs(dir);
  assert.equal(entry.summary, null);
  assert.ok(entry.problem, 'no reason given');
});

await check('a missing backups folder lists nothing rather than throwing', async () => {
  assert.deepEqual(await listKeptConfigs(path.join(await scratch(), 'nope')), []);
});

await check('keeping a copy writes a name the rolling rotation never matches', async () => {
  const dir = await scratch();
  const result = await keepConfigCopy(dir, config(['Default'], 2), 'delete', new Date('2026-09-19T22:05:27.962Z'));
  assert.equal(result.identical, false);
  assert.equal(result.file, 'before-delete-2026-09-19T22-05-27.962Z.json');
  // src/backups.ts deletes only config-<time>.json.
  assert.doesNotMatch(result.file, /^config-/);
  assert.equal(await fs.readFile(path.join(dir, result.file), 'utf8'), config(['Default'], 2));
});

await check('identical bytes are not kept twice: the copy already there is named', async () => {
  const dir = await scratch();
  const text = config(['Default'], 2);
  const first = await keepConfigCopy(dir, text, 'delete', new Date('2026-09-19T22:05:27.962Z'));
  const second = await keepConfigCopy(dir, text, 'import', new Date('2026-09-19T23:00:00.000Z'));
  assert.deepEqual(second, { file: first.file, identical: true });
  assert.equal((await listKeptConfigs(dir)).length, 1, 'a second copy of the same bytes was written');
  // A config that really differs is kept.
  await keepConfigCopy(dir, config(['Default', 'Raid'], 2), 'import', new Date('2026-09-19T23:30:00.000Z'));
  assert.equal((await listKeptConfigs(dir)).length, 2);
});

await check('at the cap it refuses, and deletes nothing — the oldest is the one worth keeping', async () => {
  const dir = await scratch();
  const oldest = new Date('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < MAX_KEPT_CONFIGS; i++) {
    await keepConfigCopy(dir, config([`Profile ${i}`], i), 'delete', new Date(oldest.getTime() + i * 60_000));
  }
  const before = await listKeptConfigs(dir);
  assert.equal(before.length, MAX_KEPT_CONFIGS);
  await assert.rejects(
    keepConfigCopy(dir, config(['One more'], 1), 'delete', new Date('2026-06-01T00:00:00.000Z')),
    /at most 20 configurations.*Delete one in Settings/s,
  );
  const after = await listKeptConfigs(dir);
  assert.deepEqual(after.map((e) => e.file), before.map((e) => e.file), 'the cap deleted or added something');
  // Making room by hand lets the next one through.
  await deleteKeptConfig(dir, before[before.length - 1].file);
  const made = await keepConfigCopy(dir, config(['One more'], 1), 'delete', new Date('2026-06-01T00:00:00.000Z'));
  assert.equal(made.identical, false);
  assert.equal((await listKeptConfigs(dir)).length, MAX_KEPT_CONFIGS);
});

await check('only a kept configuration can be named: no path, no traversal, not a rolling backup', async () => {
  const dir = await scratch();
  for (const bad of ['../../config.json', '/etc/passwd', 'config-2026-09-18T18-56-07.054Z.json', 'before-delete-nonsense.json', '']) {
    assert.throws(() => keptConfigPath(dir, bad), /is not a kept configuration/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(
    keptConfigPath(dir, 'before-import-2026-09-19T22-05-27.962Z.json'),
    path.join(dir, 'before-import-2026-09-19T22-05-27.962Z.json'),
  );
  await assert.rejects(deleteKeptConfig(dir, '../../config.json'), /is not a kept configuration/);
});

console.log(failures === 0 ? '\nkept configurations: all checks passed' : `\nkept configurations: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
