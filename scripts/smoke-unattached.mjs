/**
 * Offline test: a connected deck that no profile has a layout for
 * (docs/scope.md §7, Portability).
 *
 * The defect this exists for, `[confirmed]` on Ubuntu 26.04 on 2026-09-20 by
 * journal timestamps exactly 60 s apart: `scan()` skipped a deck already in
 * `sessions` but not one in `unattached`, so the safety-net poll called
 * `attach()` on every unconfigured deck once a minute — opening the HID
 * device, reading its serial, logging "connected but not in config" and
 * closing it again. Two decks made two USB open/close cycles and two journal
 * lines a minute, at rest, and "connected, no layout" is the state every new
 * install now sits in.
 *
 * The obvious fix — skipping `unattached` the way `sessions` is skipped —
 * strands a deck that is later given a layout, so the reverse is checked here
 * too, in both directions: a layout added must light the deck with no replug,
 * and a layout removed must put it back where the editor can still see it.
 *
 * This spawns the real `dist/index.js`, because scan(), reload() and their
 * ordering are the thing under test and only a live process runs them. The
 * child is given scripts/test/fake-decks.mjs with `--import`, so it sees a
 * fake deck rather than the two real ones this machine always has attached,
 * and rescans on SIGUSR2 rather than on a 60 s timer; the fake input helper,
 * so nothing touches /dev/uinput; and a private D-Bus session. Every path it
 * writes is inside a scratch directory.
 *
 *   npm run build:ts && node scripts/smoke-unattached.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  // Same private-bus config as scripts/smoke-bootstrap.mjs: nothing can be activated on it.
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-unattached-bus-${process.pid}.conf`);
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
const OPEN_LOG = path.join(TMP, 'opens.log');

const SERIAL = 'FAKE-XL-0001';
const DEVICE = { model: 'xl', path: '/fake/xl-0', serialNumber: SERIAL, productName: 'Fake XL' };

/** The empty configuration a first install with no deck attached writes. */
const EMPTY_CONFIG = { profiles: { default: { name: 'Default', layouts: {} } }, startProfile: 'default' };

/** The same configuration with a layout for the fake deck. */
const WITH_LAYOUT = {
  profiles: {
    default: {
      name: 'Default',
      layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'Hi' } } } } } },
    },
  },
  startProfile: 'default',
};

await fs.mkdir(CONFIG_DIR, { recursive: true });
const writeConfig = async (config) => {
  // By temp file and rename, the way the editor writes it, so the daemon's
  // non-recursive watcher sees the one event it filters for.
  const temp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n');
  await fs.rename(temp, CONFIG_PATH);
};
const plug = async (devices) => fs.writeFile(DECKS_FILE, JSON.stringify(devices));

await writeConfig(EMPTY_CONFIG);
await plug([DEVICE]);
await fs.writeFile(OPEN_LOG, '');

const child = spawn(
  process.execPath,
  ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')],
  {
    env: {
      ...process.env,
      DECKHAND_CONFIG_DIR: CONFIG_DIR,
      DECKHAND_STATE_DIR: path.join(TMP, 'state'),
      DECKHAND_SOCKET: SOCKET,
      DECKHAND_INPUT_BIN: path.join(REPO, 'scripts/test/fake-input-helper.mjs'),
      FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
      FAKE_DECKS_FILE: DECKS_FILE,
      FAKE_DECKS_LOG: OPEN_LOG,
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

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

const opens = async () => (await fs.readFile(OPEN_LOG, 'utf8')).split('\n').filter((l) => l.startsWith('open ')).length;
const closes = async () => (await fs.readFile(OPEN_LOG, 'utf8')).split('\n').filter((l) => l.startsWith('close ')).length;
const warnings = () => log().split('\n').filter((l) => l.includes('not in config')).length;

const socketUp = await until(() => fs.access(SOCKET).then(() => true, () => false), 10_000);
if (!socketUp) {
  check(`the daemon opened its control socket (log:\n${log()})`, false);
  child.kill('SIGKILL');
  process.exit(1);
}
const client = await connect(SOCKET);
const status = async () => (await client.request('status', {})).result;
const deckStatus = async () => (await status()).decks.find((d) => d.serial === SERIAL) ?? null;
const geometry = async () => ((await client.request('decks', {})).result ?? []).find((d) => d.serial === SERIAL) ?? null;

/**
 * Force a device scan and wait for it to finish. SIGUSR2 is the fake hotplug
 * event (scripts/test/fake-decks-hooks.mjs), which runs the same
 * requestScan() the 60 s safety-net timer does.
 */
async function forceScan(times = 1) {
  for (let i = 0; i < times; i++) {
    child.kill('SIGUSR2');
    await sleep(250);
  }
}

console.log('a connected deck no profile has a layout for');

check('the deck is reported connected', (await deckStatus())?.connected === true);
check('and not configured', (await deckStatus())?.configured === false);
check('its geometry is on the wire, so the editor can see it', (await geometry())?.keyCount === 32);
check('the daemon warned about it once', warnings() === 1);
check('it was opened once', (await opens()) === 1);
check('and closed again, so nothing holds the device', (await closes()) === 1);

console.log('\nthe regression: repeated scans while nothing changes');

const openedBefore = await opens();
await forceScan(4);
check('four more scans opened it no further times', (await opens()) === openedBefore);
check('and logged no further warnings', warnings() === 1);
check('it is still reported connected and unconfigured', (await deckStatus())?.connected === true && (await deckStatus())?.configured === false);

console.log('\nthe trap: a layout added must light the deck with no replug');

await writeConfig(WITH_LAYOUT);
// Wait for the session, not for `configured`: that flips the moment the
// config is read, which is before the reload's scan has attached anything,
// and waiting on it made this check pass against a deck with no session.
const attached = await until(async () => typeof (await deckStatus())?.page === 'string', 10_000);
check('the reload attached it, with no replug', attached);
check('the config covers it now', (await deckStatus())?.configured === true);
check('on the profile that covers it', (await deckStatus())?.profile === 'default');
check('the reload opened it exactly once more', (await opens()) === openedBefore + 1);

const openedAttached = await opens();
await forceScan(3);
check('later scans do not reopen an attached deck either', (await opens()) === openedAttached);

console.log('\nthe inverse: a layout removed returns it to unattached');

await writeConfig(EMPTY_CONFIG);
const detached = await until(async () => (await deckStatus())?.configured === false, 10_000);
check('the reload detached it', detached);
check('it is still reported connected', (await deckStatus())?.connected === true);
check('it shows no page, so no session is left running', (await deckStatus())?.page === undefined);
check('its geometry is still on the wire', (await geometry())?.keyCount === 32);
// While it was attached its session held the device open, so opens ran one
// ahead of closes; back in `unattached` every open has been closed again.
check('the session it had was closed, so nothing holds the device', (await closes()) === (await opens()));

const openedDetached = await opens();
await forceScan(3);
check('and scans leave it alone again', (await opens()) === openedDetached);

console.log('\nunplugged, then plugged back in');

await plug([]);
await forceScan();
check('the deck is gone from status', (await deckStatus()) === null);
check('and from the geometry list', (await geometry()) === null);

await plug([DEVICE]);
const openedGone = await opens();
await forceScan();
check('replugging it is picked up', (await deckStatus())?.connected === true);
check('by opening it again — the skip does not strand a replug', (await opens()) === openedGone + 1);
check('and it is unconfigured, as the config says', (await deckStatus())?.configured === false);

const openedReplugged = await opens();
await forceScan(3);
check('after which scans leave it alone once more', (await opens()) === openedReplugged);

client.close();
child.kill('SIGTERM');
await exited;
await fs.rm(TMP, { recursive: true, force: true });

// The daemon's own log, when something failed: what a check saw over the
// socket rarely says why the daemon did it.
if (failureCount() > 0) console.log(`\n--- daemon log ---\n${log()}`);
const failed = failureCount();
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
