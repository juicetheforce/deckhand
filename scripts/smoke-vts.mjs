/**
 * Offline test for VTube Studio (scope §7, "Streaming integrations"): the
 * hand-written WebSocket client, the connection's lifecycle, asking VTS for
 * access, and the credentials it saves — against scripts/test/fake-vts.mjs,
 * never a real VTS.
 *
 * **Never VTS's real ports.** A real VTS on this machine listens on 8001 and
 * broadcasts on 47779: every connection here names the fake's own port, and
 * the broadcast listener is pointed at a port of the test's
 * (DECKHAND_VTS_BROADCAST_PORT), or the test would pass or fail on what that
 * VTS says.
 *
 * Two halves, as smoke-obs.mjs has: the client and services/vts.ts in this
 * process; then the real `dist/index.js` in a child with a fake deck —
 * **VTS is connected only while a shown page has a VTS key**, Connect over
 * the socket, the Hotkey key pressed on the deck, and what is notified —
 * wiring that lives in src/index.ts. It runs itself on a private D-Bus
 * session, for the fake notification service.
 *
 *   npm run build:ts && node scripts/smoke-vts.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import dgram from 'node:dgram';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-vts-bus-${process.pid}.conf`);
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

// The state directory is read when dist/backups.js is first imported, so it is set before any import of dist/.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
const STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_STATE_DIR = STATE_DIR;
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');

/** A UDP port nothing else listens on, for the broadcast. */
const freeUdpPort = () =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const BROADCAST_PORT = await freeUdpPort();
process.env.DECKHAND_VTS_BROADCAST_PORT = String(BROADCAST_PORT);

const { REPO, check, failureCount, sleep, connect } = await import('./test/control-harness.mjs');
const { startFakeVts } = await import('./test/fake-vts.mjs');
const { startFakeNotifications } = await import('./test/fake-notifications.mjs');
const { iconStateOf, describeAction } = await import(path.join(REPO, 'dist/actions/index.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));
const vts = await import(path.join(REPO, 'dist/services/vts.js'));
const { VtsClient, PLUGIN_NAME, PLUGIN_DEVELOPER } = await import(path.join(REPO, 'dist/services/vts-client.js'));
const credentials = await import(path.join(REPO, 'dist/credentials.js'));

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
/** A TCP port nothing listens on: taken, then let go. */
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const approval = () => vts.cachedState().approval.state;
const connection = () => vts.cachedState().connection;

// --- The client ------------------------------------------------------------------

const fake = await startFakeVts({ approval: 'hold' });
{
  const client = await VtsClient.connect({ port: fake.port, onEvent: () => undefined, onClose: () => undefined });
  check('the client connects and reads the version from APIStateRequest, which needs no token', client.vtsVersion === '1.35.10');
  check('it offers no WebSocket extension — so nothing comes back compressed', fake.extensionsOffered.every((e) => e === ''));
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await client.request('APIStateRequest'));
  check('every reply on one connection arrives whole, not only the first (what Node’s own WebSocket fails at)', answers.every((a) => a.vTubeStudioVersion === '1.35.10'));
  let refused = null;
  try {
    await client.request('CurrentModelRequest');
  } catch (err) {
    refused = err;
  }
  check('a request on an unauthenticated session is "refused" (VTS error 8)', refused?.kind === 'refused' && refused?.errorID === 8);
  check('a token it was never given is not accepted', (await client.authenticate('not-a-token')) === false);
  client.close();
}
{
  // A reply far over 1016 bytes arrives in fragments, and is put back together.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `big-${i}`, name: `Model number ${i} with a long name` }));
  const saved = fake.models;
  fake.models = [...saved, ...many];
  fake.approval = 'allow';
  const client = await VtsClient.connect({ port: fake.port, onEvent: () => undefined, onClose: () => undefined });
  const token = await client.requestToken(undefined);
  check('a token request answered Allow gives a token', typeof token === 'string' && token.length > 0);
  check('and authenticates', await client.authenticate(token));
  const { availableModels = [] } = await client.request('AvailableModelsRequest').catch((err) => {
    console.log(`  (the long reply failed: ${err.message})`);
    return {};
  });
  const size = JSON.stringify({ availableModels }).length;
  check(`a long reply — ${size} bytes, at least ${Math.ceil(size / 1016)} fragments — arrives whole`, size > 3000 && availableModels.length === fake.models.length);
  client.close();
  fake.models = saved;
  fake.approval = 'hold';
}
{
  let failed = null;
  try {
    await VtsClient.connect({ port: await freePort(), onEvent: () => undefined, onClose: () => undefined });
  } catch (err) {
    failed = err;
  }
  check('nothing listening is "unavailable"', failed?.kind === 'unavailable');
}

// --- Not set up ------------------------------------------------------------------

let changes = 0;
vts.subscribe(() => changes++);
const connectionsBefore = fake.connections;
vts.setWanted(true);
check('with no saved token, a key wanting VTS shows "not set up"', await until(() => connection() === 'not-set-up'));
check('and nothing connects to VTS at all', fake.connections === connectionsBefore);
vts.retry();
await sleep(100);
check('the 60-second scan does not retry "not set up"', fake.connections === connectionsBefore && connection() === 'not-set-up');
const HOTKEY = { type: 'vts.hotkey', model: 'm1', hotkey: 'hk-heart', modelName: 'Akari', hotkeyName: 'Heart Eyes' };
const OTHER_MODEL = { type: 'vts.hotkey', model: 'm2', hotkey: 'hk-wave', modelName: 'Hiyori', hotkeyName: 'Wave' };
check('a Hotkey key draws its not-set-up face', (await describeAction({}, HOTKEY))?.unset === true);
check('and its own icon underneath, not the unavailable one — nothing is known yet', defaultIconFor(HOTKEY, iconStateOf(HOTKEY)) === 'vts-hotkey');

// --- Asking for access: allowed --------------------------------------------------

const tokenRequestsBefore = fake.tokenRequests.length;
check('Connect starts in the background', (await vts.requestAccess(fake.port)) === true);
check('VTS shows its window, and Deckhand waits for the person', await until(() => approval() === 'waiting' && fake.showing));
check('a second Connect while one waits is turned away, not sent', (await vts.requestAccess(fake.port)) === false && fake.tokenRequests.length === tokenRequestsBefore + 1);
const asked = fake.tokenRequests.at(-1);
check(`it asks as "${PLUGIN_NAME}" by "${PLUGIN_DEVELOPER}" — permanent strings`, asked.pluginName === 'Deckhand' && asked.pluginDeveloper === 'Open-source contributors');
const logo = await fs.readFile(path.join(REPO, 'assets/logo/png/apps/128.png'));
check('with Deckhand’s 128 px logo for VTS’s window', asked.iconBytes === logo.length);
await sleep(300);
check('nothing is saved while the person has not answered', (await credentials.vtsCredentials()) === null);
fake.answer('allow');
check('Allow: the approval says so', await until(() => approval() === 'approved'));
const saved = await credentials.vtsCredentials();
check('the token and the port are saved', saved?.port === fake.port && typeof saved?.token === 'string' && saved.token.length > 0);
check('in the owner-only credentials file', ((await fs.stat(credentials.CREDENTIALS_PATH)).mode & 0o777) === 0o600);
check('the key wanting VTS connects by itself once allowed', await until(() => connection() === 'connected'));
check('and knows the loaded model', vts.cachedState().modelId === 'm1');
check('a Hotkey key of the loaded model draws its own icon, set up', defaultIconFor(HOTKEY, iconStateOf(HOTKEY)) === 'vts-hotkey' && (await describeAction({}, HOTKEY)) === null);
check('one of a model not loaded draws the unavailable face', defaultIconFor(OTHER_MODEL, iconStateOf(OTHER_MODEL)) === 'vts-hotkey-unavailable');
check('the request’s own connection is let go: one connection stays', await until(() => fake.open === 1));

// --- What VTS says, as events ---------------------------------------------------

fake.loadModel('m2');
check('a model loaded in VTS is followed from its events: the old one goes…', await until(() => vts.cachedState().modelId === null));
check('…and the new one arrives', await until(() => vts.cachedState().modelId === 'm2'));
fake.loadModel('m1');
await until(() => vts.cachedState().modelId === 'm1');

// --- Pickers ---------------------------------------------------------------------

const models = await vts.list('models');
check('the models picker lists VTS’s models by ID, with their names', models.ok && models.items.map((m) => `${m.id}:${m.name}`).join() === 'm1:Akari,m2:Hiyori');
const hotkeys = await vts.list('hotkeys', 'm2');
check('a model not loaded lists its hotkeys too', hotkeys.ok && hotkeys.items.length === 1 && hotkeys.items[0].id === 'hk-wave');
const own = await vts.list('hotkeys', 'm1');
check('a hotkey with no name is shown by its file', own.ok && own.items.find((h) => h.id === 'hk-unnamed')?.name === 'Shock.motion3.json');
const gone = await vts.list('hotkeys', 'no-such-model');
check('a model VTS does not have is "not found"', !gone.ok && gone.reason === 'not-found');

// --- VTS turned off, and on --------------------------------------------------------

await fake.apiOff();
check('VTS’s API turned off: the connection is "unavailable"', await until(() => connection() === 'unavailable'));
await fake.apiOn();
const afterOff = fake.connections;
await sleep(300);
check('nothing reconnects by itself — no timer', fake.connections === afterOff && connection() === 'unavailable');
vts.retry();
check('the 60-second scan’s retry reconnects', await until(() => connection() === 'connected'));

// --- Revoked -----------------------------------------------------------------------

fake.revoke();
const revoked = await vts.list('models');
check('revoked in VTS mid-connection: the next request is refused (VTS error 8; it keeps the connection open)', !revoked.ok && revoked.reason === 'refused');
check('the connection is "refused"', connection() === 'refused');
const afterRevoke = fake.connections;
vts.retry();
vts.setWanted(false);
vts.setWanted(true);
await sleep(300);
check('a refused token is never retried — not by the scan, not by a key coming into view', fake.connections === afterRevoke && connection() === 'refused');
check('and the request’s connection was let go', await until(() => fake.open === 0));

// --- Asking again: denied, then blocked by a window already showing ---------------

fake.approval = 'deny';
await vts.requestAccess(fake.port);
check('Deny: the approval says so', await until(() => approval() === 'denied'));
check('and the old token is kept: still set up, still refused', (await credentials.vtsCredentials())?.token === saved.token && connection() === 'refused');

fake.approval = 'hold';
{
  // Another plugin's window is showing in VTS.
  const other = await VtsClient.connect({ port: fake.port, onEvent: () => undefined, onClose: () => undefined });
  void other.requestToken(undefined).catch(() => undefined);
  await until(() => fake.showing);
  await vts.requestAccess(fake.port);
  check('a window already showing: "busy", with what to do', await until(() => approval() === 'busy') && /Answer it in VTube Studio’s window|Answer it in VTube Studio's window/.test(vts.cachedState().approval.message));
  fake.answer('deny');
  other.close();
}

await vts.requestAccess(fake.port);
await until(() => approval() === 'waiting');
fake.answer('allow');
check('allowed again: the new token replaces the refused one', await until(() => approval() === 'approved') && (await credentials.vtsCredentials())?.token !== saved.token);
check('and the key connects', await until(() => connection() === 'connected'));

// --- Remove while waiting: VTS's window stays, and blocks --------------------------

await vts.requestAccess(fake.port);
await until(() => approval() === 'waiting');
await credentials.removeVtsCredentials();
vts.removeAccess();
check('Remove: no approval, not set up, nothing connected', approval() === 'none' && (await until(() => connection() === 'not-set-up')) && (await until(() => fake.open === 0)));
check('VTS’s window is still showing — a closed connection does not take it back', fake.showing);
await vts.requestAccess(fake.port);
check('so the next Connect is "busy" until the person answers it', await until(() => approval() === 'busy'));
fake.answer('deny');

// --- Finding VTS when nothing answers -------------------------------------------

const nowhere = await freePort();
const started = Date.now();
await vts.requestAccess(nowhere);
check('nothing answers and no broadcast comes: "not running", after the listen', await until(() => approval() === 'not-running', 9000));
check('which listened for at least one broadcast interval (~4.3 s measured)', Date.now() - started >= 5000);

await vts.requestAccess(nowhere);
await until(() => approval() === 'checking');
await sleep(200);
await fake.broadcast(BROADCAST_PORT, { active: false });
check('the broadcast says the API is off: "api-off", with where to turn it on', await until(() => approval() === 'api-off') && /Allow Plugin API access/.test(vts.cachedState().approval.message));

fake.approval = 'allow';
await vts.requestAccess(nowhere);
await until(() => approval() === 'checking');
await sleep(200);
await fake.broadcast(BROADCAST_PORT, { active: true, apiPort: fake.port });
check('the broadcast names another port: Connect follows it there', await until(() => approval() === 'approved'));
check('and saves that port', (await credentials.vtsCredentials())?.port === fake.port);

await vts.requestAccess(nowhere);
await until(() => approval() === 'checking');
await sleep(200);
await fake.broadcast(BROADCAST_PORT, { active: true, apiPort: nowhere });
check('the broadcast names the port that did not answer: "unreachable"', await until(() => approval() === 'unreachable'));

vts.setWanted(false);
await fake.stop();

// --- 2. The real daemon: Connect, the Hotkey key on a deck, notifications ---------

const CONFIG_DIR = path.join(TMP, 'config2');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE2 = path.join(TMP, 'state2');
const SOCKET = path.join(TMP, 'd.sock');
const DECKS_FILE = path.join(TMP, 'decks.json');
const DECK_SERIAL = 'FAKE-XL-0001';
await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.mkdir(STATE2, { recursive: true });
const fake2 = await startFakeVts({ approval: 'allow' });
const DAEMON_CONFIG = {
  decks: { [DECK_SERIAL]: { name: 'Deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [DECK_SERIAL]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: { 0: { label: 'Plain' } } },
            vtube: {
              name: 'VTube',
              buttons: {
                0: { label: 'Heart', action: HOTKEY },
                1: { action: { type: 'page', to: 'main' } },
                2: { label: 'Wave', action: OTHER_MODEL },
                3: { label: 'Gone', action: { ...HOTKEY, hotkey: 'hk-deleted', hotkeyName: 'Old face' } },
              },
            },
          },
        },
      },
    },
  },
};
await fs.writeFile(CONFIG_PATH, JSON.stringify(DAEMON_CONFIG, null, 2) + '\n');
await fs.writeFile(DECKS_FILE, JSON.stringify([{ model: 'xl', path: '/fake/xl-0', serialNumber: DECK_SERIAL, productName: 'Fake XL' }]));
const PRESS_FILE = path.join(TMP, 'press.json');
await fs.writeFile(PRESS_FILE, '{}');
let pressId = 0;
const pressInChild = async (index, holdMs = 30) => {
  await fs.writeFile(PRESS_FILE, JSON.stringify({ id: ++pressId, serial: DECK_SERIAL, index, holdMs }));
  await sleep(holdMs + 150);
};
const notes = await startFakeNotifications();
const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')], {
  env: {
    ...process.env,
    DECKHAND_CONFIG_DIR: CONFIG_DIR,
    DECKHAND_STATE_DIR: STATE2,
    DECKHAND_SOCKET: SOCKET,
    FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
    FAKE_DECKS_FILE: DECKS_FILE,
    FAKE_DECKS_LOG: path.join(TMP, 'opens.log'),
    FAKE_DECKS_PRESS: PRESS_FILE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => output.push(c));
child.stderr.on('data', (c) => output.push(c));
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const ready = await until(async () => {
  if (!(await fs.stat(SOCKET).catch(() => null))) return false;
  try {
    const c = await connect(SOCKET);
    const s = await c.request('status', {});
    c.socket.end();
    return s.ok && s.result.decks.some((d) => d.serial === DECK_SERIAL && d.page === 'main');
  } catch {
    return false;
  }
}, 10_000);
check('the daemon came up on the fake deck, on a page with no VTS key', ready);
const ctl = await connect(SOCKET);
const goTo = (page) => ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'page', to: page } });
const failedOn = async (key) => (await ctl.request('status', {})).result.decks.find((d) => d.serial === DECK_SERIAL)?.failed?.find((f) => f.key === key)?.error ?? null;

await goTo('vtube');
await sleep(500);
check('daemon: a VTS key shown, not set up: no connection to VTS at all', fake2.connections === 0);
await pressInChild(0);
check('daemon: a not-set-up press is notified, saying where to set it up', await until(() => notes.calls.length === 1 && /VTube Studio is not set up/.test(notes.calls[0]?.body ?? '')));
await pressInChild(2);
await sleep(300);
check('daemon: once, whichever key — and never a mark', notes.calls.length === 1 && (await failedOn(0)) === null && fake2.connections === 0);

await ctl.request('subscribe', { events: ['vts'] });
const vtsEvents = () => ctl.events.filter((e) => e.event === 'vts').map((e) => e.data);
const asking = await ctl.request('vts.connect', { port: fake2.port });
check('daemon: vts.connect replies at once, started', asking.ok && asking.result.started === true);
check('daemon: the approval comes as vts events, ending "approved"', await until(() => vtsEvents().some((d) => d.approval.state === 'approved')));
check('daemon: the shown key connects by itself', await until(() => fake2.open === 1));
// The fake counts a connection open before the daemon has authenticated and read the model: wait for the state, not the socket.
let status = null;
const connected = await until(async () => {
  status = await ctl.request('vts.status', {});
  return status.result.connection === 'connected';
});
const token = JSON.parse(await fs.readFile(path.join(STATE2, 'credentials.json'), 'utf8')).vts.token;
check('daemon: vts.status says set up and connected, with the model', connected && status.result.setUp === true && status.result.modelId === 'm1');
check('daemon: the token is never on the socket — not in a reply, not in an event', !JSON.stringify(status).includes(token) && !JSON.stringify(ctl.events).includes(token));

await pressInChild(0);
check('daemon: a press of the Hotkey key runs it in VTS', await until(() => fake2.triggered.includes('hk-heart')));
check('daemon: and leaves the key unmarked', (await failedOn(0)) === null);
const notesBefore = notes.calls.length;
await pressInChild(2);
check('daemon: a hotkey of a model not loaded: marked, saying why', await until(async () => /belongs to Hiyori/.test((await failedOn(2)) ?? '')));
check('daemon: not notified — its face already shows it unavailable', notes.calls.length === notesBefore && !fake2.triggered.includes('hk-wave'));
await pressInChild(3);
check('daemon: a hotkey deleted in VTS: marked and notified, saying to choose it again', await until(() => notes.calls.length === notesBefore + 1 && /has no hotkey "Old face"/.test(notes.calls.at(-1)?.body ?? '')));

const listed = await ctl.request('vts.list', { kind: 'hotkeys', model: 'm1' });
check('daemon: vts.list gives a model’s hotkeys by ID', listed.ok && listed.result.ok && listed.result.items.some((h) => h.id === 'hk-heart'));

fake2.revoke();
await pressInChild(0);
check('daemon: revoked in VTS, a press is marked and notified: connect again', await until(() => /no longer allows Deckhand/.test(notes.calls.at(-1)?.body ?? '')));
check('daemon: the connection is refused', (await ctl.request('vts.status', {})).result.connection === 'refused');

const allowedAgain = await ctl.request('vts.connect', { port: fake2.port });
check('daemon: Connect again', allowedAgain.result.started === true && (await until(() => fake2.open === 1)));
await goTo('main');
check('daemon: back to a page with no VTS key, it lets go', await until(() => fake2.open === 0));
const removed = await ctl.request('vts.remove', {});
check('daemon: Remove: not set up', removed.ok && removed.result.setUp === false);

ctl.socket.end();
child.kill('SIGTERM');
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
check('daemon: stops cleanly', code === 0 || code === null);
await fake2.stop();
await notes.stop();
if (failureCount() > 0) console.log(output.join('').split('\n').slice(-40).join('\n'));

await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\nvts: all checks passed' : `\nvts: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
