/**
 * Offline test for what a new user's decks show on first run: the real
 * `dist/index.js` started with **no config.json** and two decks plugged in.
 *
 * It must write a starter config with the editor key — the Deckhand logo,
 * which opens the editor — on key 0 of each deck, and **no keystroke key
 * anywhere** (the first starter was Shift+D, which typed a capital D into
 * whatever had focus). Pressing it launches the editor installed beside the
 * daemon, through `systemd-run --user --scope` like any launched program, and
 * with no path in the config. With no editor installed beside the daemon the
 * press fails, and says why.
 *
 * The child is given scripts/test/fake-decks.mjs with `--import`, so it sees
 * two fake decks; a fake systemd-run on PATH records what would be launched;
 * DECKHAND_APP_DIR points the editor action at a scratch app directory.
 *
 *   npm run build:ts && node scripts/smoke-first-run.mjs
 *
 * The no-decks first run (an empty config) is scripts/smoke-bootstrap.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  // Same private-bus config as scripts/smoke-bootstrap.mjs: nothing can be activated on it.
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-first-run-bus-${process.pid}.conf`);
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

const { REPO, check, failureCount, scratchDir, sleep, connect } = await import('./test/control-harness.mjs');

const TMP = await scratchDir();
process.env.TMPDIR = TMP;
const CONFIG_DIR = path.join(TMP, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SOCKET = path.join(TMP, 'c.sock');
const DECKS_FILE = path.join(TMP, 'decks.json');
const LAUNCH_LOG = path.join(TMP, 'systemd-run.log');
const APP_DIR = path.join(TMP, 'app');
const ELECTRON = path.join(APP_DIR, 'editor', 'electron', 'electron');

const XL = 'FAKE-XL-0001';
const V2 = 'FAKE-V2-0002';
await fs.writeFile(
  DECKS_FILE,
  JSON.stringify([
    { model: 'xl', path: '/fake/xl-0', serialNumber: XL, productName: 'Fake XL' },
    { model: 'original-v2', path: '/fake/v2-0', serialNumber: V2, productName: 'Fake V2', columns: 5, rows: 3, pixels: 72 },
  ]),
);
// A scratch app directory with an "editor" in it, and systemd-run faked.
await fs.mkdir(path.dirname(ELECTRON), { recursive: true });
await fs.writeFile(ELECTRON, '#!/bin/sh\n');
await fs.chmod(ELECTRON, 0o755);
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-systemd-run.mjs'), path.join(TMP, 'bin', 'systemd-run'));
await fs.mkdir(CONFIG_DIR, { recursive: true });

const child = spawn(
  process.execPath,
  ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')],
  {
    env: {
      ...process.env,
      PATH: `${path.join(TMP, 'bin')}:${process.env.PATH}`,
      DECKHAND_CONFIG_DIR: CONFIG_DIR,
      DECKHAND_STATE_DIR: path.join(TMP, 'state'),
      DECKHAND_SOCKET: SOCKET,
      DECKHAND_INPUT_BIN: path.join(REPO, 'scripts/test/fake-input-helper.mjs'),
      FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
      FAKE_DECKS_FILE: DECKS_FILE,
      FAKE_SYSTEMD_RUN_LOG: LAUNCH_LOG,
      DECKHAND_APP_DIR: APP_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const output = [];
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => output.push(c));
child.stderr.on('data', (c) => output.push(c));
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const log = () => output.join('');

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

console.log('first run with two decks attached');
const socketUp = await until(() => fs.access(SOCKET).then(() => true, () => false));
check('the daemon starts and opens its socket', socketUp);
let written = null;
try {
  written = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
} catch {
  // checked below
}
check('it wrote a starter config', written !== null);
const layouts = written?.profiles?.default?.layouts ?? {};
check('a layout for each deck', Object.keys(layouts).sort().join(',') === [V2, XL].sort().join(','));
for (const serial of [XL, V2]) {
  const buttons = layouts[serial]?.pages?.main?.buttons ?? {};
  check(`${serial}: key 0 is the editor key, and the only key`, JSON.stringify(buttons) === JSON.stringify({ 0: { action: { type: 'editor' } } }));
}
check('no keystroke action anywhere in it', !/"(hotkey|text|keyHold|toggle)"/.test(JSON.stringify(written)));
check('no path in it', !JSON.stringify(written).includes('/'));

const client = await connect(SOCKET);
const attached = await until(async () => {
  const s = await client.request('status', {});
  return (s.result?.decks ?? []).filter((d) => d.connected && d.configured).length === 2;
});
check('both decks attach with it', attached);

console.log('pressing it');
const press = await client.request('action.run', { serial: XL, action: { type: 'editor' } });
check('the press succeeds', press.ok === true);
const launched = await until(async () => (await fs.readFile(LAUNCH_LOG, 'utf8').catch(() => '')).trim() !== '');
const argv = launched ? JSON.parse((await fs.readFile(LAUNCH_LOG, 'utf8')).trim().split('\n')[0]) : [];
check(
  'it launches the editor beside the daemon, in its own scope, without ELECTRON_RUN_AS_NODE',
  JSON.stringify(argv) ===
    JSON.stringify(['--user', '--scope', '--quiet', '--collect', '--', 'env', '-u', 'ELECTRON_RUN_AS_NODE', ELECTRON, path.join(APP_DIR, 'editor')]),
);

console.log('no editor installed beside the daemon');
await fs.rm(ELECTRON);
const missing = await client.request('action.run', { serial: XL, action: { type: 'editor' } });
check('the press fails', missing.ok === false);
check('and says why', /no editor installed beside this daemon/.test(missing.error?.message ?? ''));

client.socket.destroy();
child.kill('SIGTERM');
await exited;
await fs.rm(TMP, { recursive: true, force: true });
if (failureCount() > 0) console.log(`\n--- daemon log ---\n${log()}`);
const failed = failureCount();
console.log(failed === 0 ? '\nfirst-run: all checks passed' : `\nfirst-run: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
