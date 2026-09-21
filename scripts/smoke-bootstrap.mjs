/**
 * Offline test: first run with no config.json and no Stream Deck connected.
 *
 * The daemon must write a valid empty configuration and **stay up**. Exiting
 * instead makes systemd restart-loop it and makes `scripts/install.sh` roll
 * the install back, which is exactly what installing before any deck is
 * plugged in hits.
 *
 * This spawns the real `dist/index.js`, because the behaviour lives in
 * `main()`'s startup path and only a live process proves it keeps running. The
 * child is given scripts/test/no-decks.mjs with `--import`, so it finds no
 * decks whatever is plugged in; the fake input helper, so nothing touches
 * /dev/uinput; and a private D-Bus session, so MPRIS never reaches the
 * desktop's bus. Every path it writes is inside a scratch directory.
 *
 *   npm run build:ts && node scripts/smoke-bootstrap.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  // Same private-bus config as scripts/smoke-mpris.mjs: nothing can be activated on it.
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-bootstrap-bus-${process.pid}.conf`);
  await fs.writeFile(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${os.tmpdir()}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const rerun = spawnSync('dbus-run-session', [`--config-file=${busConfig}`, '--', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, DECKHAND_SMOKE_PRIVATE_BUS: '1' },
  });
  await fs.rm(busConfig, { force: true });
  process.exit(rerun.status ?? 1);
}

const { REPO, check, failureCount, scratchDir, sleep, connect, validateConfig } =
  await import('./test/control-harness.mjs');

const TMP = await scratchDir();
process.env.TMPDIR = TMP;

const CONFIG_DIR = path.join(TMP, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SOCKET = path.join(TMP, 'c.sock');

/** Start the daemon the way systemd does: the built entry point, nothing else. */
function startDaemon() {
  const child = spawn(
    process.execPath,
    ['--import', path.join(REPO, 'scripts/test/no-decks.mjs'), path.join(REPO, 'dist/index.js')],
    {
      env: {
        ...process.env,
        DECKHAND_CONFIG_DIR: CONFIG_DIR,
        DECKHAND_STATE_DIR: path.join(TMP, 'state'),
        DECKHAND_SOCKET: SOCKET,
        DECKHAND_INPUT_BIN: path.join(REPO, 'scripts/test/fake-input-helper.mjs'),
        FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output, exited, text: () => output.join('') };
}

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

const exists = async (file) => fs.access(file).then(() => true, () => false);

console.log('first run, no config and no deck connected');

check('no config.json before the daemon starts', !(await exists(CONFIG_PATH)));

const first = startDaemon();
const wrote = await until(() => exists(CONFIG_PATH));
check('the daemon writes a config.json', wrote);

// Exiting here would make systemd restart-loop it. Long enough that a
// start-then-exit would be seen.
await sleep(3000);
check('the daemon is still running three seconds later', first.child.exitCode === null);
check('it did not exit with a failure', first.child.exitCode === null || first.child.exitCode === 0);

let written = null;
try {
  written = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
} catch (err) {
  check(`the config it wrote is JSON (${err.message})`, false);
}

let validates = false;
try {
  validateConfig(structuredClone(written));
  validates = true;
} catch (err) {
  console.log(`    validateConfig rejected it: ${err.message}`);
}
check('the config it wrote passes validateConfig', validates);
check('it names no decks', written !== null && Object.keys(written.decks ?? {}).length === 0);
check('it has exactly one profile', written !== null && Object.keys(written.profiles ?? {}).length === 1);
check(
  'that profile has an empty layouts object',
  written !== null && JSON.stringify(written.profiles?.default?.layouts) === '{}',
);
check('startProfile names it', written !== null && written.startProfile === 'default');
check(
  'the log says it started on an empty configuration',
  first.text().includes('starting on an empty configuration'),
);
check(
  'the log does not say there was nothing to bootstrap',
  !first.text().includes('nothing to bootstrap'),
);

// Alive is not the same as serving: ask it something over the control socket.
const reachable = await until(() => exists(SOCKET));
check('it opened the control socket', reachable);
if (reachable) {
  const client = await connect(SOCKET);
  const status = await client.request('status', {});
  check('status answers over the socket', status?.ok === true);
  // activeProfile is {id, name}, not a bare string (src/control/commands.ts stateSnapshot).
  check('it is running the empty profile', status?.result?.activeProfile?.id === 'default');
  check('that profile is named', status?.result?.activeProfile?.name === 'Default');
  const decks = await client.request('decks', {});
  check('it reports no decks', decks?.ok === true && Array.isArray(decks.result) && decks.result.length === 0);
  client.close();
}

first.child.kill('SIGTERM');
await first.exited;

// Starting again must not clobber the config that is now there: writeNewConfig
// uses the 'wx' flag, and bootstrap should not run at all this time. Skipped
// when the first daemon wrote nothing, so a broken first half reports its
// failures rather than throwing here and hiding the rest.
if (await exists(CONFIG_PATH)) {
  const before = await fs.readFile(CONFIG_PATH, 'utf8');
  const second = startDaemon();
  await sleep(2000);
  check('a second start with that config still runs', second.child.exitCode === null);
  check('it did not rewrite the config', (await fs.readFile(CONFIG_PATH, 'utf8')) === before);
  check(
    'it did not bootstrap again',
    !second.text().includes('starting on an empty configuration'),
  );
  second.child.kill('SIGTERM');
  await second.exited;
} else {
  check('a second start could be tested (no config was written)', false);
}

await fs.rm(TMP, { recursive: true, force: true });

const failed = failureCount();
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
