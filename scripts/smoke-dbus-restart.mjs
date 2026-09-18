/**
 * Offline test: the MPRIS service survives its session bus going away and
 * coming back (Ship, 2026-09-18; src/services/mpris.ts getBus()). Runs its own
 * dbus-daemon on a fixed socket path in a scratch directory, so the bus can be
 * stopped and started again at the same address — never the desktop's bus.
 *
 * Counts uncaught exceptions the way the daemon's own handler would see them
 * (src/index.ts): before this was fixed, a lost bus was one of those.
 *
 *   npm run build:ts && node scripts/smoke-dbus-restart.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

const { REPO, check, failureCount, scratchDir, sleep } = await import('./test/control-harness.mjs');
const TMP = await scratchDir();
process.env.TMPDIR = TMP;
const SOCKET = path.join(TMP, 'bus');
const BUS_CONFIG = path.join(TMP, 'bus.conf');
await fs.writeFile(
  BUS_CONFIG,
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
);
// Read by dbus-next when a connection is made, so set before any is.
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${SOCKET}`;

const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(err.message));
process.on('unhandledRejection', (reason) => uncaught.push(String(reason)));

const logged = [];
const realError = console.error;
const realLog = console.log;
console.error = (...args) => {
  logged.push(args.join(' '));
  if (process.env.VERBOSE) realError(...args);
};
const say = (...args) => realLog(...args);
console.log = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[mpris]')) logged.push(line);
  else realLog(...args);
};

let busProcess = null;
async function startBus() {
  await fs.rm(SOCKET, { force: true });
  busProcess = spawn('dbus-daemon', ['--nofork', `--config-file=${BUS_CONFIG}`], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !existsSync(SOCKET); i++) await sleep(10);
  if (!existsSync(SOCKET)) throw new Error('dbus-daemon did not start');
}
async function stopBus(signal = 'SIGTERM') {
  const exited = new Promise((r) => busProcess.once('exit', r));
  busProcess.kill(signal);
  await exited;
  busProcess = null;
}

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}

const mpris = await import(path.join(REPO, 'dist/services/mpris.js'));
const { startFakePlayer } = await import('./test/fake-mpris-player.mjs');
const title = () => mpris.cachedTrackInfo()?.title;
const lostLines = () => logged.filter((l) => l.includes('session bus connection lost')).length;

say('the bus is not there when the daemon starts');
let changes = 0;
const stop = mpris.subscribe(() => changes++);
{
  await sleep(2600); // past the one quick retry, which also fails
  check('no uncaught exception', uncaught.length === 0);
  check('the loss is logged', lostLines() >= 1);
  const lostSoFar = lostLines();
  await startBus();
  const player = await startFakePlayer('fakeA', { status: 'Playing', track: { title: 'One', artist: 'Band' } });
  await sleep(1500);
  check('nothing retries on its own once the quick retry has failed (no timer spinning)', title() === undefined && lostLines() === lostSoFar);
  mpris.retryLostBus(); // what the 60 s safety-net scan does
  check('the safety-net retry finds the bus and reads the player', await until(() => title() === 'One'));
  player.set({ track: { title: 'Two', artist: 'Band' } });
  check('...and follows its changes again', await until(() => title() === 'Two', 1000));
  check('...still with no uncaught exception', uncaught.length === 0);
  await player.stop();
}

say('the bus stops cleanly and comes back within 2 s');
{
  const player = await startFakePlayer('fakeA', { status: 'Playing', track: { title: 'Before', artist: 'Band' } });
  check('(the player is cached first)', await until(() => title() === 'Before'));
  const lostBefore = lostLines();
  const changesBefore = changes;
  await stopBus('SIGTERM');
  check('the loss is noticed', await until(() => lostLines() > lostBefore, 1000));
  check('...the now-playing cache is emptied, so faces show idle rather than a frozen track', await until(() => mpris.cachedTrackInfo() === null, 1000));
  check('...and faces are told to redraw', await until(() => changes > changesBefore, 1000));
  await startBus();
  const back = await startFakePlayer('fakeA', { status: 'Playing', track: { title: 'After', artist: 'Band' } });
  check('the quick retry reconnects, with no safety-net call', await until(() => title() === 'After', 4000));
  back.set({ status: 'Paused' });
  check('...and follows changes on the new connection', await until(() => mpris.cachedTrackInfo()?.status === 'Paused', 1000));
  check('no uncaught exception', uncaught.length === 0);

  say('a second loss after recovering, the bus killed outright');
  await stopBus('SIGKILL');
  check('the loss is noticed', await until(() => mpris.cachedTrackInfo() === null, 1000));
  await startBus();
  const again = await startFakePlayer('fakeA', { status: 'Playing', track: { title: 'Again', artist: 'Band' } });
  check('recovering earned the quick retry back', await until(() => title() === 'Again', 4000));
  check('no uncaught exception', uncaught.length === 0);
  await again.stop();
  await player.stop();
  await back.stop();
}

say('a press after the bus is back, before any retry');
{
  await stopBus();
  await sleep(2600); // the quick retry fails; nothing else will try
  await startBus();
  const player = await startFakePlayer('fakeA', { status: 'Paused', track: { title: 'Pressed', artist: 'Band' } });
  await mpris.call('PlayPause');
  check('the press reaches the player on a new connection', player.calls.includes('org.mpris.MediaPlayer2.Player.PlayPause'));
  check('...and following players comes back with it', await until(() => title() === 'Pressed', 2000));
  check('no uncaught exception', uncaught.length === 0);
  await player.stop();
}

stop();
mpris.disconnect();
await stopBus();
if (uncaught.length) realError(`uncaught:\n  ${uncaught.join('\n  ')}`);
await fs.rm(TMP, { recursive: true, force: true });
say(failureCount() === 0 ? '\ndbus restart: all checks passed' : `\ndbus restart: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
