/**
 * Offline test for the command action: a launched program goes through
 * `systemd-run --user --scope`, so it runs in its own scope and outlives the
 * daemon; "wait" still runs it as the daemon's child and badges a failure.
 * Runs against scripts/test/fake-systemd-run.mjs, which records its arguments
 * and starts nothing.
 *
 *   npm run build:ts && node scripts/smoke-command.mjs
 *
 * That a scope really survives the service stopping is systemd's behaviour,
 * not this code's, and is not tested here.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO, check, failureCount, scratchDir } from './test/control-harness.mjs';

const TMP = await scratchDir();
const BIN = path.join(TMP, 'bin');
const LOG = path.join(TMP, 'systemd-run.log');
await fs.mkdir(BIN);
await fs.symlink(path.join(REPO, 'scripts/test/fake-systemd-run.mjs'), path.join(BIN, 'systemd-run'));
const PATH_WITH_FAKE = `${BIN}:${process.env.PATH}`;
process.env.PATH = PATH_WITH_FAKE;
process.env.FAKE_SYSTEMD_RUN_LOG = LOG;

const { runAction } = await import(path.join(REPO, 'dist/actions/index.js'));

let uncaught = 0;
process.on('uncaughtException', (err) => {
  uncaught++;
  console.log(`  (uncaught: ${err.message})`);
});
const logged = [];
const ctx = { log: (message) => logged.push(message) };

/** The launches recorded so far. The fake is detached, so wait for it to write. */
async function launches(expected) {
  for (let i = 0; i < 100; i++) {
    const text = await fs.readFile(LOG, 'utf8').catch(() => '');
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (lines.length >= expected) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}
const SCOPE = ['--user', '--scope', '--quiet', '--collect', '--'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('command: launched programs go into their own scope');

let failure = await runAction(ctx, { type: 'command', command: 'kate ~/notes.md' });
let runs = await launches(1);
check('"command" returns at once, not failed', failure === null);
check('"command" launches through systemd-run --user --scope, via sh -c', same(runs[0], [...SCOPE, '/bin/sh', '-c', 'kate ~/notes.md']));

failure = await runAction(ctx, { type: 'command', exec: ['flatpak', 'run', 'com.example.App'] });
runs = await launches(2);
check('"exec" returns at once, not failed', failure === null);
check('"exec" launches through systemd-run with no shell, arguments kept apart', same(runs[1], [...SCOPE, 'flatpak', 'run', 'com.example.App']));

failure = await runAction(ctx, { type: 'command', exec: ['odd name', '--flag=a b', ''] });
runs = await launches(3);
check('arguments with spaces and empty ones reach systemd-run unchanged', same(runs[2], [...SCOPE, 'odd name', '--flag=a b', '']));

console.log('command: "wait" still runs as a child, and badges a failure');

failure = await runAction(ctx, { type: 'command', command: 'echo waited', wait: true });
await new Promise((resolve) => setTimeout(resolve, 200));
check('"wait" runs directly: no systemd-run', (await launches(0)).length === 3);
check('"wait" logs the output', failure === null && logged.includes('waited'));
failure = await runAction(ctx, { type: 'command', command: 'exit 3', wait: true });
check('"wait" with a failing command marks the key', typeof failure === 'string' && failure.length > 0);

console.log('command: no systemd-run at all');

const errors = [];
const consoleError = console.error;
console.error = (...args) => errors.push(args.join(' '));
process.env.PATH = TMP; // a directory with no systemd-run in it
failure = await runAction(ctx, { type: 'command', command: 'kate' });
await new Promise((resolve) => setTimeout(resolve, 300));
process.env.PATH = PATH_WITH_FAKE;
console.error = consoleError;
check('the press still returns, not failed (it cannot wait to find out)', failure === null);
check('it is logged by name', errors.some((line) => /cannot start systemd-run/.test(line)));
check('and is not an uncaught exception', uncaught === 0);

await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\ncommand: all checks passed' : `\ncommand: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
