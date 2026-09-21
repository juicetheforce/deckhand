/**
 * Offline test of rolling config backups (src/backups.ts).
 * No Stream Deck, helper or audio server; a scratch directory and a fake clock.
 *
 *   npm run build:ts && node scripts/smoke-backups.mjs      (npm run smoke runs it too)
 *
 * The section that matters most is "burst": a burst of autosaves must leave
 * one snapshot and must not push older backups out. "no reload storm" checks
 * that writing backups can never trigger a config reload, with the backup
 * directory in the worst place — inside the config directory.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
const CONFIG_DIR = path.join(TMP, 'config');
await fs.mkdir(CONFIG_DIR);
// Before any import of dist/config.js, which reads these when imported.
process.env.DECKHAND_CONFIG_DIR = CONFIG_DIR;
process.env.DECKHAND_STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');

const { ConfigBackups, BACKUP_DIR, BACKUP_KEEP, BACKUP_SPACING_MS } = await import(path.join(REPO, 'dist/backups.js'));
const { watchConfig, CONFIG_PATH } = await import(path.join(REPO, 'dist/config.js'));
const { check, failureCount, sleep, startDaemon, connect } = await import(path.join(REPO, 'scripts/test/control-harness.mjs'));

const START = Date.parse('2026-09-14T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A ConfigBackups in its own directory, with a clock the test moves by hand. */
async function fixture(name, options = {}) {
  const dir = path.join(TMP, name);
  const clock = { now: START };
  const backups = new ConfigBackups({ dir, now: () => clock.now, ...options });
  return { dir, clock, backups };
}

/** Names Deckhand wrote, oldest first (the names sort by time). */
async function backupNames(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => /^config-.*\.json$/.test(n)).sort();
  } catch {
    return [];
  }
}

/** A file's text, or null if it is gone — so a deleted file fails a check instead of crashing the run. */
const read = (dir, name) => fs.readFile(path.join(dir, name), 'utf8').catch(() => null);

console.log('defaults');
check(`keeps ${BACKUP_KEEP}, at most one per ${BACKUP_SPACING_MS / MINUTE} min`, BACKUP_KEEP === 20 && BACKUP_SPACING_MS === 5 * MINUTE);
check('lives under the state directory, not the config directory', BACKUP_DIR === path.join(TMP, 'state', 'backups') && !BACKUP_DIR.startsWith(CONFIG_DIR));

console.log('basic rules');
{
  const { dir, clock, backups } = await fixture('basic');
  check('no directory yet: status is empty, not an error', backups.status().count === 0 && backups.status().newest === null && !backups.status().error);
  check('first change saves the previous config', (await backups.afterGoodReload('v0\n', 'v1\n')) === 'saved');
  const [first] = await backupNames(dir);
  check('... as its exact file text', first !== undefined && (await read(dir, first)) === 'v0\n');
  check('... named for the time it was saved', first === 'config-2026-09-14T12-00-00.000Z.json');
  check('status counts it', backups.status().count === 1 && backups.status().newest === '2026-09-14T12:00:00.000Z');
  clock.now += 10 * MINUTE;
  check('a reload with identical text saves nothing', (await backups.afterGoodReload('v1\n', 'v1\n')) === 'unchanged');
  check('a change within 5 min of the newest backup saves nothing', await (async () => {
    clock.now = START + 4 * MINUTE + 59 * 1000;
    return (await backups.afterGoodReload('v1\n', 'v2\n')) === 'too-recent';
  })());
  clock.now = START + 5 * MINUTE;
  check('at exactly 5 min it saves again', (await backups.afterGoodReload('v2\n', 'v3\n')) === 'saved');
  clock.now += 6 * MINUTE;
  check('previous text identical to the newest backup is not saved twice', (await backups.afterGoodReload('v2\n', 'v4\n')) === 'duplicate');
  check('two backups on disk', (await backupNames(dir)).length === 2);
  check('no temporary files left', (await fs.readdir(dir)).every((n) => !n.endsWith('.tmp')));
  const dirMode = (await fs.stat(dir)).mode & 0o777;
  const fileMode = (await fs.stat(path.join(dir, first))).mode & 0o777;
  check(`private: directory 700, files 600 (got ${dirMode.toString(8)}, ${fileMode.toString(8)})`, dirMode === 0o700 && fileMode === 0o600);
  const reopened = new ConfigBackups({ dir });
  await reopened.init();
  check('init() reads what is already on disk', reopened.status().count === 2 && reopened.status().newest === '2026-09-14T12:05:00.000Z');
}

console.log('burst');
{
  // 19 backups from earlier days, then an editing burst: 60 autosaves, 2 s
  // apart. The undo net must still reach back past the burst.
  const { dir, clock, backups } = await fixture('burst');
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < 19; i++) {
    const name = `config-${new Date(START - (19 - i) * 24 * HOUR).toISOString().replace(/:/g, '-')}.json`;
    await fs.writeFile(path.join(dir, name), `day ${i}\n`);
  }
  await backups.init();
  const outcomes = [];
  for (let i = 0; i < 60; i++) {
    outcomes.push(await backups.afterGoodReload(`edit ${i}\n`, `edit ${i + 1}\n`));
    clock.now += 2000;
  }
  const names = await backupNames(dir);
  check(`60 autosaves in 2 min make one snapshot (${outcomes.filter((o) => o === 'saved').length} saved)`, outcomes.filter((o) => o === 'saved').length === 1);
  check('the snapshot is the config from before the burst', (await read(dir, names.at(-1))) === 'edit 0\n');
  check(`all 19 older backups survive (${names.length} on disk)`, names.length === 20 && (await read(dir, names[0])) === 'day 0\n');
  clock.now += 5 * MINUTE;
  check('the next change after the burst settles saves the last state of the burst', (await backups.afterGoodReload('edit 60\n', 'edit 61\n')) === 'saved' && (await read(dir, (await backupNames(dir)).at(-1))) === 'edit 60\n');
  check('... and pushes out only the single oldest backup', (await backupNames(dir)).length === 20 && (await read(dir, (await backupNames(dir))[0])) === 'day 1\n');
}

console.log('pruning');
{
  const { dir, clock, backups } = await fixture('prune');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'notes.txt'), 'mine\n');
  await fs.writeFile(path.join(dir, 'config-by-hand.json'), 'mine\n');
  for (let i = 0; i < 25; i++) {
    await backups.afterGoodReload(`v${i}\n`, `v${i + 1}\n`);
    clock.now += 6 * MINUTE;
  }
  const names = await backupNames(dir);
  const ours = names.filter((n) => n !== 'config-by-hand.json');
  check(`25 saves keep the newest 20 (${ours.length})`, ours.length === 20);
  check('the oldest kept is the 6th saved', (await read(dir, ours[0])) === 'v5\n' && (await read(dir, ours.at(-1))) === 'v24\n');
  check('files Deckhand did not name are never deleted', (await read(dir, 'notes.txt')) === 'mine\n' && (await read(dir, 'config-by-hand.json')) === 'mine\n');
}

console.log('clock and failures');
{
  const { dir, clock, backups } = await fixture('clock');
  clock.now = START + HOUR;
  await backups.afterGoodReload('a\n', 'b\n');
  clock.now = START; // the clock went back an hour
  check('a newest backup dated in the future does not block backups', (await backups.afterGoodReload('b\n', 'c\n')) === 'saved');
  check('both kept', (await backupNames(dir)).length === 2);

  const blocker = path.join(TMP, 'not-a-directory');
  await fs.writeFile(blocker, '');
  const broken = new ConfigBackups({ dir: path.join(blocker, 'backups'), now: () => START });
  let threw = false;
  let outcome;
  try {
    outcome = await broken.afterGoodReload('a\n', 'b\n');
  } catch {
    threw = true;
  }
  check('an unwritable directory fails without throwing', !threw && outcome === 'failed');
  check('... and status reports the failure', typeof broken.status().error === 'string' && broken.status().error.length > 0);
  await fs.rm(blocker);
  await fs.mkdir(blocker);
  check('a later success clears the failure', (await broken.afterGoodReload('b\n', 'c\n')) === 'saved' && broken.status().error === undefined);
}

console.log('no reload storm');
{
  // The daemon's reload, reduced to what touches the disk: read config.json,
  // then back up the previous text — here with no spacing, so every reload
  // writes, and to two places: inside the config directory (worst case) and
  // a separate state directory (the real layout).
  await fs.writeFile(CONFIG_PATH, 'write 0\n');
  const inside = new ConfigBackups({ dir: path.join(CONFIG_DIR, 'backups'), spacingMs: 0 });
  const outside = new ConfigBackups({ dir: path.join(TMP, 'storm-state'), spacingMs: 0 });
  let previous = 'write 0\n';
  let reloads = 0;
  const pending = [];
  const stop = watchConfig(() => {
    reloads++;
    pending.push((async () => {
      const text = await fs.readFile(CONFIG_PATH, 'utf8');
      await inside.afterGoodReload(previous, text);
      await outside.afterGoodReload(previous, text);
      previous = text;
    })());
  });
  await sleep(300);
  const WRITES = 5;
  for (let i = 1; i <= WRITES; i++) {
    // The editor's atomic write: temp file, then rename onto config.json.
    const tmp = path.join(CONFIG_DIR, '.config.json.tmp');
    await fs.writeFile(tmp, `write ${i}\n`);
    await fs.rename(tmp, CONFIG_PATH);
    await sleep(800); // longer than the watcher's 250 ms debounce, so each write is its own reload
  }
  await Promise.all(pending);
  await sleep(1500); // time for any reload a backup write might have caused
  stop();
  check(`${WRITES} config writes -> ${WRITES} reloads (got ${reloads})`, reloads === WRITES);
  check(`every reload wrote a backup in both places (${inside.status().count}, ${outside.status().count})`, inside.status().count === WRITES && outside.status().count === WRITES);
}

console.log('status and the CLI');
{
  const { dir, backups } = await fixture('status');
  await backups.afterGoodReload('a\n', 'b\n');
  const config = { profiles: { p: { layouts: { SERIAL: { pages: { main: { buttons: {} } } } } } } };
  const daemon = await startDaemon(TMP, config, { backups: () => backups.status() });
  const client = await connect(daemon.socket);
  const status = (await client.request('status')).result;
  check('status carries the backup directory and count', status.config.backups?.dir === dir && status.config.backups.count === 1);
  const cli = (args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'dist/cli.js'), ...args], { env: { ...process.env, DECKHAND_SOCKET: daemon.socket }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  const printed = await cli(['status']);
  check('deckhand status prints the backup path', printed.code === 0 && printed.stdout.includes(`backups: ${dir} (1 kept, newest `));
  client.close();
  await daemon.stop();
}

await sleep(100);
await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
