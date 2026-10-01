/**
 * Offline test for OBS (scope §7, "Streaming integrations"): the obs-websocket
 * client, the connection's lifecycle, the Stream, Record and Pause keys, and
 * the credentials file — against scripts/test/fake-obs.mjs, never a real OBS.
 *
 * Two halves:
 *
 * 1. In this process: the real DeckSession (control-harness.mjs) and the real
 *    services/obs.ts, against the fake. Press, hold, a short press, a page
 *    change mid-hold; a refused password never retried; OBS quitting with
 *    nothing reconnecting by itself; the 60-second scan's retry; the file's
 *    mode, and no secret on the socket.
 * 2. The real `dist/index.js` in a child, with a fake deck: **OBS is connected
 *    only while a shown page has an OBS key**, and **a key that needs the
 *    person to do something says so as a desktop notification** (a fake
 *    org.freedesktop.Notifications on the private bus), unless the config
 *    turns them off — that wiring lives in src/index.ts, which only a live
 *    process runs.
 *
 * Everything it writes is in a scratch directory; it runs itself on a
 * private D-Bus session, as the other daemon tests do.
 *
 *   npm run build:ts && node scripts/smoke-obs.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-obs-bus-${process.pid}.conf`);
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

// The state directory is read when dist/backups.js is first imported — by the
// harness's own imports — so it is set before any of them.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
const STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_STATE_DIR = STATE_DIR;
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');

const { REPO, check, failureCount, sleep, FakeDeck, startDaemon, connect } = await import('./test/control-harness.mjs');
const { startFakeObs } = await import('./test/fake-obs.mjs');
const { startFakeNotifications } = await import('./test/fake-notifications.mjs');
const obs = await import(path.join(REPO, 'dist/services/obs.js'));
const credentials = await import(path.join(REPO, 'dist/credentials.js'));
const { iconStateOf, describeAction } = await import(path.join(REPO, 'dist/actions/index.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));
const { HOLD_TO_STOP_MS } = await import(path.join(REPO, 'dist/actions/obs.js'));

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
const types = (fake) => fake.requests.map((r) => r.type);
/** A port nothing listens on: taken, then let go. */
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const PASSWORD = 'correct horse battery staple';

// The auth string is not checked against a known answer: obs-websocket's
// protocol.md gives an example's inputs but no output, and a value computed
// here with the same formula would prove nothing. The fake OBS checks it with
// its own copy of the formula; the proof is a real OBS accepting it
// (code-state, OBS session 1).

// --- 1. In process ---------------------------------------------------------------

const fake = await startFakeObs({ password: PASSWORD });
await credentials.setObsCredentials({ port: fake.port, password: PASSWORD });

const mode = (await fs.stat(credentials.CREDENTIALS_PATH)).mode & 0o777;
check('the credentials file is owner-only (0600)', mode === 0o600);
check('it is in the state directory', path.dirname(credentials.CREDENTIALS_PATH) === STATE_DIR);
const leftovers = (await fs.readdir(STATE_DIR)).filter((f) => f.endsWith('.tmp'));
check('no temp file is left behind', leftovers.length === 0);

let changes = 0;
const stopListening = obs.subscribe(() => changes++);

// Nothing wants OBS yet: no connection at all.
await sleep(200);
check('nothing connects while no key wants OBS', fake.connections === 0 && obs.cachedState().connection === 'idle');

obs.setWanted(true);
check('a key wanting OBS connects and identifies', await until(() => obs.cachedState().connection === 'connected'));
check(
  'it subscribes to General, Scenes, Inputs, Outputs and SceneItems — never the volume meters or any high-volume category',
  fake.eventSubscriptions === ((1 << 0) | (1 << 2) | (1 << 3) | (1 << 6) | (1 << 7)) && (fake.eventSubscriptions & 0xf0000) === 0,
);
check('and learns the program scene on connecting', obs.cachedState().programScene === 'Starting');
check('its first requests seed the state: stream, record and program scene', JSON.stringify(types(fake).slice(0, 3).sort()) === JSON.stringify(['GetCurrentProgramScene', 'GetRecordStatus', 'GetStreamStatus']));

// OBS goes live by itself (its own UI): the event alone moves the face.
const before = changes;
fake.setStream(true);
check('OBS going live is pushed, not polled', await until(() => obs.cachedState().stream === 'live'));
check('and the change is announced', changes > before);
check('the Stream key\'s default icon is the live one', defaultIconFor({ type: 'obs.stream' }, iconStateOf({ type: 'obs.stream' })) === 'obs-stream-on');
check('live, the Stream key keeps its own background: the icon carries the state', (await describeAction({}, { type: 'obs.stream' })) === null);
fake.event('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' });
check('reconnecting, the Stream key turns amber — a dropped stream never looks live', await until(async () => (await describeAction({}, { type: 'obs.stream' }))?.background === '#5a4a1d'));
fake.setStream(false);
await until(() => obs.cachedState().stream === 'stopped');
check('off air, its own background again', (await describeAction({}, { type: 'obs.stream' })) === null);

// The keys, on a real DeckSession.
const SERIAL = 'OBS-XL';
const CONFIG = {
  decks: { [SERIAL]: { name: 'Deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [SERIAL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: { action: { type: 'obs.stream' } },
                1: { action: { type: 'obs.record' } },
                2: { action: { type: 'obs.recordPause' } },
                3: { action: { type: 'obs.scene', scene: 'Gameplay' } },
                4: { action: { type: 'obs.mute', input: 'Mic/Aux' } },
                5: { action: { type: 'obs.source', scene: 'Gameplay', source: 'Webcam' } },
              },
            },
            other: { name: 'Other', buttons: {} },
          },
        },
      },
    },
  },
};
const daemon = await startDaemon(TMP, CONFIG);
const deck = new FakeDeck();
const session = await daemon.attach(SERIAL, deck);
const failedKey = (key) => session.failedKeys().find((f) => f.key === key)?.error ?? null;
const tap = async (key, heldMs = 30) => {
  deck.press(key);
  await sleep(heldMs);
  deck.release(key);
};
const requestsAfter = (mark) => types(fake).slice(mark);

// Stream: off air, a press starts it.
let mark = fake.requests.length;
await tap(0);
check('Stream, off air: a press starts the stream', await until(() => fake.streaming));
check('it asked OBS first, then started', JSON.stringify(requestsAfter(mark)) === JSON.stringify(['GetStreamStatus', 'StartStream']));
check('the face follows OBS\'s events to live', await until(() => obs.cachedState().stream === 'live'));

// Live: a short press does not stop it, and says why.
mark = fake.requests.length;
await tap(0, 50);
await sleep(200);
check('Stream, live: a short press does not stop it', fake.streaming && !requestsAfter(mark).includes('StopStream'));
check('the key is marked, saying to hold it', /Hold for 1 second/.test(failedKey(0) ?? ''));

// Live: a hold stops it, and clears the mark.
await tap(0, HOLD_TO_STOP_MS + 150);
check('Stream, live: a hold stops it', await until(() => !fake.streaming));
check('a successful hold clears the mark', await until(() => failedKey(0) === null));

// Off air, held long: the press starts it, and its own hold does not stop it.
mark = fake.requests.length;
await tap(0, HOLD_TO_STOP_MS + 150);
await sleep(200);
check('Stream, off air, held: starts, and the same hold does not stop what it started', fake.streaming && !requestsAfter(mark).includes('StopStream'));

// Live, a page change under the finger: the hold is dropped.
mark = fake.requests.length;
deck.press(0);
await sleep(50);
await session.goToPage('other');
await sleep(HOLD_TO_STOP_MS + 100);
deck.release(0);
await sleep(200);
check('a page change mid-hold drops the hold: the stream stays live', fake.streaming && !requestsAfter(mark).includes('StopStream'));
await session.goToPage('main');

// From the control socket there is no hold: it only starts.
const client = await connect(daemon.socket);
const run = await client.request('action.run', { serial: SERIAL, action: { type: 'obs.stream' } });
check('from the socket, live: refused, never stopped', run.ok === false && /hold/.test(run.error?.message ?? '') && fake.streaming);

// Record and Pause.
await tap(1);
check('Record: a press starts recording', await until(() => fake.recording && obs.cachedState().record === 'live'));
await tap(2);
check('Pause: a press pauses it', await until(() => obs.cachedState().recordPaused));
check('the Record key shows paused', defaultIconFor({ type: 'obs.record' }, iconStateOf({ type: 'obs.record' })) === 'obs-paused');
check('the Pause key shows paused', defaultIconFor({ type: 'obs.recordPause' }, iconStateOf({ type: 'obs.recordPause' })) === 'obs-paused');
await tap(2);
check('Pause again: resumes, and the Pause key shows press-to-pause', await until(() => !obs.cachedState().recordPaused) && defaultIconFor({ type: 'obs.recordPause' }, iconStateOf({ type: 'obs.recordPause' })) === 'obs-pause');
check('a pause OBS confirmed leaves the key unmarked', failedKey(2) === null);

// OBS cannot pause this recording (Recording Quality "Same as stream"): it
// answers success and does nothing. The key must not look like it worked.
fake.pausable = false;
const pressedAt = Date.now();
await tap(2);
check('Pause when OBS cannot pause: the key is marked, saying why', await until(() => /did not pause.*Same as stream/.test(failedKey(2) ?? ''), 3000));
check('it gave OBS about a second to say it had paused', Date.now() - pressedAt >= 900);
check('and the recording is not shown as paused', !obs.cachedState().recordPaused && !fake.paused);
fake.pausable = true;

await tap(1);
check('Record again: stops, and paused clears', await until(() => !fake.recording && obs.cachedState().record === 'stopped' && !obs.cachedState().recordPaused));
await tap(2);
check('Pause with nothing recording: the key is marked, saying so', await until(() => /Nothing is recording/.test(failedKey(2) ?? '')));
check('and nothing was asked of OBS but whether it records', fake.requests.at(-1)?.type === 'GetRecordStatus');

// --- Scene, Mute and Source: what the shown keys name, asked once, then fed by events ---
const face = (action) => defaultIconFor(action, iconStateOf(action));
const SCENE_KEY = { type: 'obs.scene', scene: 'Gameplay' };
const MUTE_KEY = { type: 'obs.mute', input: 'Mic/Aux' };
const SOURCE_KEY = { type: 'obs.source', scene: 'Gameplay', source: 'Webcam' };
const WEBCAM = obs.itemKey('Gameplay', 'Webcam');
mark = fake.requests.length;
obs.setWanted(true, { inputs: ['Mic/Aux'], items: [{ scene: 'Gameplay', source: 'Webcam' }] });
check('a newly shown input and scene item are asked for once', await until(() => obs.cachedState().inputMuted['Mic/Aux'] === false && obs.cachedState().itemEnabled[WEBCAM] === true));
check('one request for the input, two for the item (its id, then its state)', JSON.stringify(requestsAfter(mark).sort()) === JSON.stringify(['GetInputMute', 'GetSceneItemEnabled', 'GetSceneItemId']));
mark = fake.requests.length;
obs.setWanted(true, { inputs: ['Mic/Aux'], items: [{ scene: 'Gameplay', source: 'Webcam' }] });
await sleep(200);
check('the same keys shown again: nothing asked again', fake.requests.length === mark);

check('Scene: not the program scene, its resting icon', face(SCENE_KEY) === 'obs-scene');
await tap(3);
check('Scene: a press switches the program scene', await until(() => fake.program === 'Gameplay'));
check("and its key lights, from OBS's event", await until(() => face(SCENE_KEY) === 'obs-scene-active'));
fake.setProgram('BRB');
check('OBS switching scene by itself: the key goes out', await until(() => face(SCENE_KEY) === 'obs-scene'));

await tap(4);
check('Mute: a press mutes the input', await until(() => fake.inputs[0].muted === true));
check("and shows muted, from OBS's event", await until(() => face(MUTE_KEY) === 'obs-audio-muted'));
fake.setMuted('Mic/Aux', false);
check('unmuted in OBS: the key follows', await until(() => face(MUTE_KEY) === 'obs-audio'));
fake.setMuted('Desktop Audio', true);
await sleep(150);
check('an input no key names is not kept', !('Desktop Audio' in obs.cachedState().inputMuted));

await tap(5);
check('Source: a press hides it', await until(() => fake.items.Gameplay[0].enabled === false));
check('and shows hidden', await until(() => face(SOURCE_KEY) === 'obs-source-hidden'));
fake.setItemEnabled('Gameplay', 'Webcam', true);
check('shown again in OBS: the key follows', await until(() => face(SOURCE_KEY) === 'obs-source'));
fake.setItemEnabled('Starting', 'Countdown', false);
await sleep(150);
check('an item with the same id in another scene does not move the key', obs.cachedState().itemEnabled[WEBCAM] === true);

// Renamed in OBS: the key names the old name, so it is forgotten, and a press says what to do.
fake.renameInput('Mic/Aux', 'Mic');
check('an input renamed in OBS: its key forgets the old state', await until(() => !('Mic/Aux' in obs.cachedState().inputMuted)));
await tap(4);
check('and a press says what is missing, and what to do', await until(() => /no input named "Mic\/Aux".*Choose it again/.test(failedKey(4) ?? '')));
fake.renameInput('Mic', 'Mic/Aux');
check('renamed back: known again, by the event alone', await until(() => obs.cachedState().inputMuted['Mic/Aux'] === false));
await tap(4);
await until(() => failedKey(4) === null);
fake.setMuted('Mic/Aux', false);

// The pickers.
const listed = async (kind, scene) => (await client.request('obs.list', { kind, ...(scene ? { scene } : {}) })).result ?? {};
check("obs.list scenes: in OBS's order, top first", JSON.stringify((await listed('scenes')).names) === JSON.stringify(['Starting', 'Gameplay', 'BRB']));
check('obs.list inputs: audio inputs only, by name', JSON.stringify((await listed('inputs')).names) === JSON.stringify(['Desktop Audio', 'Mic/Aux']));
check("obs.list sources: the scene's, top first", JSON.stringify((await listed('sources', 'Gameplay')).names) === JSON.stringify(['Webcam', 'Game capture']));
check('obs.list sources of a scene OBS has not got: not-found', (await listed('sources', 'Nope')).reason === 'not-found');
check('obs.list without a kind is refused', (await client.request('obs.list', {})).ok === false);

// Not shown any more: forgotten.
obs.setWanted(true, { inputs: [], items: [] });
check('keys no longer shown: what they named is forgotten', Object.keys(obs.cachedState().inputMuted).length === 0 && Object.keys(obs.cachedState().itemEnabled).length === 0);

// No secret on the socket.
const status = await client.request('obs.status', {});
check('obs.status says a password is set, and never what it is', status.ok && status.result.passwordSet === true && !JSON.stringify(status).includes(PASSWORD));
const set = await client.request('obs.credentials', { port: fake.port });
check('obs.credentials replies without the password either', set.ok && !JSON.stringify(set).includes(PASSWORD));
check('a bad port is refused', (await client.request('obs.credentials', { port: 70000 })).ok === false);

// OBS quits: the faces go off air, and nothing reconnects by itself.
await until(() => obs.cachedState().connection === 'connected');
const connectionsBefore = fake.connections;
await fake.stop();
check('OBS quitting: the connection is marked unavailable', await until(() => obs.cachedState().connection === 'unavailable'));
check('and the faces show off air', obs.cachedState().stream === 'stopped' && obs.cachedState().record === 'stopped');
await sleep(1500);
const fake2 = await startFakeObs({ password: PASSWORD, port: fake.port });
await sleep(1500);
check('nothing reconnects on its own — no timer', fake2.connections === 0);
obs.retry();
check('the 60-second scan\'s retry reconnects', await until(() => obs.cachedState().connection === 'connected' && fake2.identified === 1));
void connectionsBefore;

// A wrong password: refused, and the scan never retries it.
await credentials.setObsCredentials({ password: 'wrong' });
obs.credentialsChanged();
check('a wrong password is refused', await until(() => obs.cachedState().connection === 'auth-failed'));
const attempts = fake2.connections;
obs.retry();
obs.retry();
await sleep(300);
check('the scan never retries a refused password', fake2.connections === attempts);
await tap(0);
check('a press with it fails, and says so', await until(() => /refused the password/.test(failedKey(0) ?? '')));
await sleep(300);
check('and letting go of the key does not clear that mark', /refused the password/.test(failedKey(0) ?? ''));
await credentials.setObsCredentials({ password: PASSWORD });
obs.credentialsChanged();
check('changing the credentials tries again, and connects', await until(() => obs.cachedState().connection === 'connected'));

// No password set while OBS asks for one.
await credentials.setObsCredentials({ password: null });
obs.credentialsChanged();
check('no password set while OBS asks for one: auth-failed, not unavailable', await until(() => obs.cachedState().connection === 'auth-failed'));
await credentials.setObsCredentials({ password: PASSWORD });

// --- Not set up: no saved connection (scope §7; credentials.ts) ----------------
await until(() => obs.cachedState().connection === 'connected');
await credentials.removeObsCredentials();
obs.credentialsChanged();
check('removed: not set up, and disconnected at once', await until(() => obs.cachedState().connection === 'not-set-up' && fake2.open === 0));
check('obs.status says not set up', (await client.request('obs.status', {})).result?.setUp === false);
let tries = fake2.connections;
obs.retry();
obs.retry();
await sleep(300);
check('the scan never tries a connection that is not set up', fake2.connections === tries);
check(
  'every OBS key draws its not-set-up face',
  (await describeAction({}, { type: 'obs.stream' }))?.unset === true &&
    (await describeAction({}, { type: 'obs.record' }))?.unset === true &&
    (await describeAction({}, { type: 'obs.recordPause' }))?.unset === true,
);
check('a press says where to set it up', /not set up: connect it in Deckhand's Settings › Integrations/.test(await obs.request('GetStreamStatus').catch((e) => e.message)));
await tap(1);
await sleep(300);
check('and is not a mark on the key: its face already says so', failedKey(1) === null && fake2.connections === tries);

// Test connection: says which thing is wrong, and changes nothing.
const test = async (args) => (await client.request('obs.test', args)).result ?? {};
const t1 = await test({ port: fake2.port, password: PASSWORD });
check('Test connection with the right values connects, naming OBS', t1.ok === true && t1.obsVersion === '32.1.1-fake');
check('and changes nothing: still not set up', obs.cachedState().connection === 'not-set-up' && (await client.request('obs.status', {})).result?.setUp === false);
check('a wrong password is named as such', (await test({ port: fake2.port, password: 'wrong' })).reason === 'auth');
check('no password, where OBS asks for one, is named as such', (await test({ port: fake2.port, password: '' })).reason === 'no-password');
const closedPort = await freePort();
const realObs = await obs.obsIsRunning();
const t4 = await test({ port: closedPort });
check(`nothing listening and ${realObs ? 'a real OBS running: server off' : 'no OBS process: not running'}`, t4.reason === (realObs ? 'server-off' : 'not-running'));
// A process named obs, as the RPM's and the Flatpak's both are: the server is off.
const fakeObsBin = path.join(TMP, 'obs');
await fs.copyFile('/usr/bin/sleep', fakeObsBin);
await fs.chmod(fakeObsBin, 0o755);
const obsProcess = spawn(fakeObsBin, ['30'], { stdio: 'ignore' });
await sleep(100);
const t5 = await test({ port: closedPort });
check('OBS running with nothing listening: its WebSocket server is off, and where to turn it on', t5.reason === 'server-off' && /Tools › WebSocket Server Settings/.test(t5.message));
obsProcess.kill();
check('another host cannot be told apart: unreachable, saying both', (await test({ host: '127.0.0.2', port: closedPort })).reason === 'unreachable');
check('a field left out uses the saved one — none saved, so the default port', (await test({ host: '127.0.0.1' })).ok === false);

// Save: sets OBS up, tries once at once, and the keys come back by themselves.
const savedOff = await client.request('obs.credentials', { host: '127.0.0.1', port: closedPort, password: PASSWORD });
check('Save with OBS not there: set up, saved, and the attempt says why', savedOff.ok && savedOff.result.setUp === true && savedOff.result.attempt?.ok === false);
check('and the keys wait for the scan: unavailable, not not-set-up', obs.cachedState().connection === 'unavailable' && (await describeAction({}, { type: 'obs.record' })) === null);
tries = fake2.connections;
const savedOn = await client.request('obs.credentials', { port: fake2.port });
check('Save with OBS there: connected, naming it', savedOn.ok && savedOn.result.attempt?.ok === true && savedOn.result.attempt.obsVersion === '32.1.1-fake');
check('one attempt, not one per key', fake2.connections === tries + 1);
check('every key comes back live, with nothing else done', obs.cachedState().connection === 'connected' && (await describeAction({}, { type: 'obs.stream' })) === null);
const kept = await client.request('obs.credentials', { password: '' });
check('an entry with no password is still set up — OBS can run without authentication', kept.result?.setUp === true);
await credentials.setObsCredentials({ password: PASSWORD });

// Nothing wants it: it lets go.
obs.credentialsChanged();
await until(() => obs.cachedState().connection === 'connected');
obs.setWanted(false);
check('no key wanting OBS: the connection is closed', await until(() => fake2.open === 0 && obs.cachedState().connection === 'idle'));

// A press with nothing wanting it connects, acts, and lets go.
mark = fake2.requests.length;
await describeAction({ log: () => undefined }, { type: 'obs.stream' });
await obs.request('GetStreamStatus');
check('a press connects at once, even with no key shown', fake2.requests.slice(mark).some((r) => r.type === 'GetStreamStatus'));
check('and lets go after, with no key shown', await until(() => fake2.open === 0));

stopListening();
client.socket.end();
await daemon.stop();
await fake2.stop();

// --- 2. The real daemon: connected only while a shown page has an OBS key --------

const CONFIG_DIR = path.join(TMP, 'config2');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE2 = path.join(TMP, 'state2');
const SOCKET = path.join(TMP, 'd.sock');
const DECKS_FILE = path.join(TMP, 'decks.json');
const DECK_SERIAL = 'FAKE-XL-0001';
await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.mkdir(STATE2, { recursive: true });
const fake3 = await startFakeObs({ password: PASSWORD });
await fs.writeFile(path.join(STATE2, 'credentials.json'), JSON.stringify({ obs: { port: fake3.port, password: PASSWORD } }), { mode: 0o600 });
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
            main: { name: 'Main', buttons: { 0: { label: 'Plain' }, 1: { action: { type: 'page', to: 'live' } } } },
            live: {
              name: 'Live',
              buttons: {
                0: { label: 'Go live', action: { type: 'obs.stream' } },
                1: { action: { type: 'page', to: 'main' } },
                2: { action: { type: 'page', to: 'nowhere' } },
                3: { action: { type: 'obs.recordPause' } },
                5: { action: { type: 'obs.mute', input: 'Desktop Audio' } },
              },
            },
          },
        },
      },
    },
  },
};
const writeConfig = async (config) => {
  const temp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n');
  await fs.rename(temp, CONFIG_PATH);
};
await writeConfig(DAEMON_CONFIG);
await fs.writeFile(DECKS_FILE, JSON.stringify([{ model: 'xl', path: '/fake/xl-0', serialNumber: DECK_SERIAL, productName: 'Fake XL' }]));
const PRESS_FILE = path.join(TMP, 'press.json');
await fs.writeFile(PRESS_FILE, '{}');
let pressId = 0;
/** Press a key on the child's fake deck (scripts/test/fake-deck-device.mjs, FAKE_DECKS_PRESS). */
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
  // The harness's connect() waits for a connection and never gives up on an
  // error, so it is only tried once the daemon's socket exists.
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
check('the daemon came up on the fake deck, on a page with no OBS key', ready);
const ctl = await connect(SOCKET);
const goTo = (page) => ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'page', to: page } });

await sleep(800);
check('daemon: no OBS key shown, no connection to OBS at all', fake3.connections === 0);

await goTo('live');
check('daemon: a page with an OBS key shown connects', await until(() => fake3.open === 1));
check(
  "daemon: a shown Mute key's input is asked for, once",
  await until(() => fake3.requests.filter((r) => r.type === 'GetInputMute' && r.data?.inputName === 'Desktop Audio').length === 1),
);
const shown = await ctl.request('obs.status', {});
check('daemon: obs.status says connected', shown.ok && shown.result.connection === 'connected');

// Notifications: only for a failure that says what to do, once per message.
fake3.setStream(true);
await pressInChild(0, 50);
check('daemon: a short press while live is notified, naming the deck and key', await until(() => notes.calls.length === 1));
const note = notes.calls[0] ?? {};
check(
  'daemon: the notification says what to do, from Deckhand, with its icon',
  note.appName === 'Deckhand' && note.summary === 'Deck: Go live' && /Hold for 1 second/.test(note.body ?? '') && note.appIcon === 'io.github.juicetheforce.Deckhand',
);
await pressInChild(0, 50);
await sleep(300);
check('daemon: the same failure again is not notified again', notes.calls.length === 1);
await pressInChild(2);
const failedNowhere = await until(async () => {
  const st = await ctl.request('status', {});
  return st.result.decks.find((d) => d.serial === DECK_SERIAL)?.failed?.some((f) => f.key === 2);
});
await sleep(300);
check('daemon: a failure that says nothing to do is badged, not notified', failedNowhere && notes.calls.length === 1);
await pressInChild(0, 1200);
check('daemon: a hold stops the stream', await until(() => !fake3.streaming));

// Turned off in the config: read at the moment of the failure, so a reload counts.
const quiet = structuredClone(DAEMON_CONFIG);
quiet.notifications = false;
await writeConfig(quiet);
await until(async () => (await ctl.request('status', {})).result.config.lastReload.at !== undefined, 1000);
await sleep(800);
await pressInChild(3);
const pauseFailed = await until(async () => {
  const st = await ctl.request('status', {});
  return st.result.decks.find((d) => d.serial === DECK_SERIAL)?.failed?.some((f) => f.key === 3 && /Nothing is recording/.test(f.error));
});
await sleep(300);
check('daemon: with notifications off, a failure that says what to do is badged only', pauseFailed && notes.calls.length === 1);
const wrong = structuredClone(DAEMON_CONFIG);
wrong.notifications = 'no';
await writeConfig(wrong);
check('daemon: "notifications" that is not true or false is refused', await until(async () => {
  const st = await ctl.request('status', {});
  return st.result.config.lastReload.ok === false && /notifications/.test(st.result.config.lastReload.error ?? '');
}));
await writeConfig(DAEMON_CONFIG);
await until(async () => (await ctl.request('status', {})).result.config.lastReload.ok === true);

// Remove: the keys stay, show not set up, and a press is told once — never marked.
await ctl.request('subscribe', { events: ['obs'] });
const obsEvents = () => ctl.events.filter((e) => e.event === 'obs').map((e) => e.data);
const removed = await ctl.request('obs.remove', {});
check('daemon: Remove disconnects at once', removed.ok && removed.result.setUp === false && (await until(() => fake3.open === 0)));
check('daemon: and says so as an obs event', await until(() => obsEvents().some((d) => d.setUp === false)));
const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
check('daemon: no key is removed', config.profiles.default.layouts[DECK_SERIAL].pages.live.buttons[0]?.action?.type === 'obs.stream');
const notesBefore = notes.calls.length;
await pressInChild(0);
check('daemon: a not-set-up press is notified, saying where to set it up', await until(() => notes.calls.length === notesBefore + 1 && /Settings › Integrations/.test(notes.calls.at(-1)?.body ?? '')));
await pressInChild(3);
await pressInChild(0);
await sleep(300);
check('daemon: once, whichever key — not per press', notes.calls.length === notesBefore + 1);
const unmarked = (await ctl.request('status', {})).result.decks.find((d) => d.serial === DECK_SERIAL)?.failed ?? [];
check('daemon: and never marks the key', !unmarked.some((f) => /not set up/.test(f.error)));
const setUpAgain = await ctl.request('obs.credentials', { port: fake3.port, password: PASSWORD });
check('daemon: set up again, the keys connect by themselves', setUpAgain.result?.attempt?.ok === true && (await until(() => fake3.open === 1)));
check('daemon: an obs event says set up and connected', await until(() => obsEvents().some((d) => d.setUp === true && d.connection === 'connected')));
await ctl.request('obs.remove', {});
await pressInChild(0);
check('daemon: removed again, the next not-set-up press is told again', await until(() => notes.calls.length === notesBefore + 2));
await ctl.request('obs.credentials', { port: fake3.port, password: PASSWORD });
await until(() => fake3.open === 1);

await goTo('main');
check('daemon: back to a page with none, it lets go', await until(() => fake3.open === 0));

// A reload that puts an OBS key on the page being shown connects, with no page change.
const withKey = structuredClone(DAEMON_CONFIG);
withKey.profiles.default.layouts[DECK_SERIAL].pages.main.buttons[2] = { action: { type: 'obs.record' } };
await writeConfig(withKey);
check('daemon: a reload adding an OBS key to the shown page connects', await until(() => fake3.open === 1, 5000));
await writeConfig(DAEMON_CONFIG);
check('daemon: a reload removing it lets go', await until(() => fake3.open === 0, 5000));

ctl.socket.end();
child.kill('SIGTERM');
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
check('daemon: stops cleanly', code === 0 || code === null);
await fake3.stop();
await notes.stop();
if (failureCount() > 0) console.log(output.join('').split('\n').slice(-40).join('\n'));

await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nsmoke-obs: all checks passed' : `\nsmoke-obs: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
