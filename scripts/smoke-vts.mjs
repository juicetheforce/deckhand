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
 *   npm run build:ts && node scripts/smoke-vts.mjs
 */
import { promises as fs } from 'node:fs';
import dgram from 'node:dgram';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// The state directory is read when dist/backups.js is first imported, so it is set before any import of dist/.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
const STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_STATE_DIR = STATE_DIR;

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

const { REPO, check, failureCount, sleep } = await import('./test/control-harness.mjs');
const { startFakeVts } = await import('./test/fake-vts.mjs');
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
await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\nvts: all checks passed' : `\nvts: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
