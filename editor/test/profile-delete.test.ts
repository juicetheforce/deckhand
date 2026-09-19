// Deleting a profile keeps the configuration first (M5, src/main/profile-delete.ts).
// The order is what matters: nothing is deleted unless the copy was written,
// and the copy holds what was there before, including edits not yet autosaved.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/types.js';
import { applyEdit, serializeConfig } from '../src/main/config-document.js';
import { deleteProfileKeepingACopy, type DeleteDeps } from '../src/main/profile-delete.js';
import type { ApplyResult, Edit } from '../src/shared/edits.js';

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

function fixture(): Config {
  return {
    profiles: {
      home: { name: 'Home', layouts: { 'DECK-A': { pages: { main: { name: 'Main', buttons: { '0': { action: { type: 'profile', to: 'Raid' } } } } } } } },
      raid: { name: 'Raid', layouts: { 'DECK-A': { pages: { pg: { name: 'Main', buttons: {} } } } } },
    },
  };
}

/** A store like main's, over a real config.json, recording the order of what it does. */
async function harness(scratch: string, { flushFails = false } = {}) {
  const configPath = path.join(scratch, 'config.json');
  let config = fixture();
  // What is on disk starts one edit behind, as it does between autosaves.
  const saved = structuredClone(config);
  delete saved.profiles.home.layouts['DECK-A'].pages.main.buttons['0'].action;
  await fs.writeFile(configPath, serializeConfig(saved));
  const log: string[] = [];
  const deps: DeleteDeps = {
    store: {
      state: () => ({ config }),
      flush: async () => {
        log.push('flush');
        if (flushFails) throw new Error('disk full');
        await fs.writeFile(configPath, serializeConfig(config));
        return true;
      },
      apply: (edit: Edit): ApplyResult => {
        log.push(`apply ${edit.kind}`);
        const candidate = structuredClone(config);
        try {
          applyEdit(candidate, edit, { homeDir: scratch, randomHex: () => 'beef' });
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
        config = candidate;
        return { ok: true, result: {} };
      },
    },
    backupDir: path.join(scratch, 'backups'),
    configPath,
    keptPath: (file) => path.join(scratch, 'backups', file),
    tildePath: (file) => file,
  };
  return { deps, log, configPath, current: () => config };
}

console.log('delete profile: the configuration is kept first (M5)');

await check('the copy is written before the delete, and holds the unsaved edit too', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-del-'));
  const h = await harness(scratch);
  const result = await deleteProfileKeepingACopy(h.deps, 'raid', 'Main');
  assert.equal(result.ok, true);
  assert.deepEqual(h.log, ['flush', 'apply deleteProfile'], 'the copy was not taken before the delete');
  const kept = await fs.readdir(path.join(scratch, 'backups'));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^before-delete-.*\.json$/, 'a name the rolling rotation could delete');
  const before = JSON.parse(await fs.readFile(path.join(scratch, 'backups', kept[0]), 'utf8')) as Config;
  assert.ok(before.profiles.raid, 'the copy was taken after the delete');
  assert.ok(before.profiles.home.layouts['DECK-A'].pages.main.buttons['0'].action, 'the copy missed an edit that was not yet saved');
  assert.equal(h.current().profiles.raid, undefined, 'the profile was not deleted');
  assert.equal(result.ok === true && result.backup, path.join(scratch, 'backups', kept[0]));
});

await check('if the copy cannot be written, nothing is deleted and the message says so', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-del-'));
  const h = await harness(scratch);
  // A file where the backups directory should be: mkdir fails, so the copy does.
  await fs.writeFile(path.join(scratch, 'backups'), 'not a directory');
  const result = await deleteProfileKeepingACopy(h.deps, 'raid', 'Main');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /nothing was deleted/);
  assert.deepEqual(h.log, ['flush'], 'the delete ran anyway');
  assert.ok(h.current().profiles.raid, 'the profile was deleted with no copy kept');
});

await check('a failed flush stops it too: the copy would not be what was there', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-del-'));
  const h = await harness(scratch, { flushFails: true });
  const result = await deleteProfileKeepingACopy(h.deps, 'raid', 'Main');
  assert.equal(result.ok, false);
  assert.deepEqual(h.log, ['flush']);
  assert.ok(h.current().profiles.raid);
  assert.deepEqual(await fs.readdir(scratch).then((f) => f.filter((n) => n === 'backups')), [], 'a copy was left behind');
});

await check('a refused delete keeps no copy and writes nothing', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-del-'));
  const h = await harness(scratch);
  for (const profile of ['nope', 'home']) {
    // "home" is not the last profile; delete raid first so it is.
    if (profile === 'home') assert.equal((await deleteProfileKeepingACopy(h.deps, 'raid', 'Main')).ok, true);
    const result = await deleteProfileKeepingACopy(h.deps, profile, 'Main');
    assert.equal(result.ok, false, `${profile} should have been refused`);
  }
  const kept = await fs.readdir(path.join(scratch, 'backups'));
  assert.equal(kept.length, 1, 'a refused delete kept a copy: only the one real delete should have');
  assert.ok(h.current().profiles.home, 'the last profile was deleted');
});

await check('with no store open, nothing happens', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-del-'));
  const h = await harness(scratch);
  const result = await deleteProfileKeepingACopy({ ...h.deps, store: null, storeError: 'config.json is broken' }, 'raid', 'Main');
  assert.deepEqual(result, { ok: false, error: 'config.json is broken' });
  assert.deepEqual(h.log, []);
});

console.log(failures === 0 ? '\nprofile delete: all checks passed' : `\nprofile delete: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
