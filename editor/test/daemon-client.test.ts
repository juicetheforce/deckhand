// Offline test of the editor's daemon client (M4 phase A, step 2), against
// the M3 test harness: real DeckSessions on fake decks behind a real
// ControlServer on a scratch socket (scripts/test/control-harness.mjs).

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DaemonClient, DaemonError, type DaemonView } from '../src/main/daemon-client.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
// Fakes first: the daemon's input module reads this when imported.
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');
const harness: any = await import(pathToFileURL(path.join(REPO, 'scripts/test/control-harness.mjs')).href);
const { FakeDeck, startDaemon, scratchDir, sleep } = harness;

const XL = 'TEST-XL';
const V2 = 'TEST-V2';
const CONFIG = {
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: { pages: { main: { buttons: { '0': { label: 'saved' } } } } },
        [V2]: { pages: { main: { buttons: {} } } },
      },
    },
  },
};

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

/** Resolve once the client's view satisfies a condition, or fail after a while. */
function until(views: DaemonView[], client: DaemonClient, condition: (v: DaemonView) => boolean, ms = 3000): Promise<DaemonView> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const v = client.view();
      if (condition(v)) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error(`timed out; last view: ${JSON.stringify(v).slice(0, 400)}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function newClient(socketPath: string | null, extra: Partial<ConstructorParameters<typeof DaemonClient>[0]> = {}) {
  const views: DaemonView[] = [];
  const client = new DaemonClient({ socketPath, onChange: (v) => views.push(v), retryInitialMs: 100, retryMaxMs: 400, ...extra });
  return { client, views };
}

const dir: string = await scratchDir();
let daemon = await startDaemon(dir, CONFIG);
const xl = new FakeDeck();
await daemon.attach(XL, xl);

console.log('connecting and reading the daemon');

const { client, views } = newClient(daemon.socket);
client.start();

await check('connects, subscribes, and reads status and geometry', async () => {
  const v = await until(views, client, (x) => x.connected);
  assert.equal(v.problem, null);
  assert.equal(v.status?.activeProfile?.id, 'default');
  assert.equal(v.status?.protocol, 1);
  const deck = v.decks?.find((d) => d.serial === XL);
  assert.ok(deck, 'XL geometry missing');
  assert.equal(deck.keyCount, 32);
  assert.equal(deck.rows, 4);
  assert.equal(deck.columns, 8);
  assert.equal(deck.keys[9].row, 1);
  assert.equal(deck.keys[9].column, 1);
});

await check('a deck attaching is picked up from the state event, with its geometry', async () => {
  await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Fake V2' }));
  const v = await until(views, client, (x) => (x.decks ?? []).some((d) => d.serial === V2));
  const v2 = v.decks!.find((d) => d.serial === V2)!;
  assert.equal(v2.keyCount, 15);
  assert.equal(v2.iconSize, 72);
});

await check('a config event updates lastReload', async () => {
  daemon.state.lastReload = { ok: false, at: 'later', error: 'refused for the test' };
  daemon.events.config();
  const v = await until(views, client, (x) => x.status?.config.lastReload.at === 'later');
  assert.equal(v.status?.config.lastReload.error, 'refused for the test');
});

console.log('previews');

await check('previewSet renders on the fake deck and shows in state; previewClear restores it', async () => {
  const before = xl.writes.get(3) ?? 0;
  const savedImage = xl.images.get(3);
  await client.previewSet(XL, 3, { label: 'previewed', background: '#ff0000' });
  assert.ok((xl.writes.get(3) ?? 0) > before, 'nothing written to key 3');
  await until(views, client, (x) => (x.status?.decks.find((d) => d.serial === XL)?.previews ?? []).includes(3));
  await client.previewClear(XL, 3);
  await until(views, client, (x) => !(x.status?.decks.find((d) => d.serial === XL)?.previews ?? []).includes(3));
  assert.ok(xl.images.get(3)?.equals(savedImage), 'key 3 not restored to its saved image');
});

await check('an error reply rejects with the daemon error code', async () => {
  await assert.rejects(client.previewSet('NO-SUCH-DECK', 0, { label: 'x' }), (err: unknown) => err instanceof DaemonError && (err.code === 'not_found' || err.code === 'deck_not_connected'));
  await assert.rejects(client.previewSet(XL, 99, { label: 'x' }), (err: unknown) => err instanceof DaemonError && err.code === 'not_found');
  assert.equal(client.view().connected, true, 'an error reply must not drop the connection');
});

await check('a burst of 30 previews on one key all resolve, and the last one is shown', async () => {
  const writesBefore = xl.writes.get(5) ?? 0;
  await Promise.all(Array.from({ length: 30 }, (_, i) => client.previewSet(XL, 5, { label: `burst ${i}` })));
  const writes = (xl.writes.get(5) ?? 0) - writesBefore;
  const lastOnly = xl.images.get(5);
  await client.previewSet(XL, 5, { label: 'burst 29' });
  assert.ok(xl.images.get(5)?.equals(lastOnly), 'the image shown is not the last preview');
  console.log(`       (${writes} key writes for 30 previews)`);
  await client.previewClear(XL);
});

console.log('the daemon going away and coming back');

await check('a daemon stopping is reported, pending requests reject, and the client reconnects when it returns', async () => {
  const pending = client.previewSet(XL, 6, { label: 'in flight' }).catch((err) => err);
  await daemon.stop();
  const down = await until(views, client, (x) => !x.connected);
  assert.ok(down.problem, 'no problem reported');
  assert.equal(down.status, null);
  // A request left unsettled would hang this test instead of failing it.
  const result = await Promise.race([pending, sleep(2000).then(() => 'still pending after 2 s')]);
  // Rejected at once by the close — not left to the 10 s reply timeout — unless the reply beat the stop.
  assert.ok(result === undefined || (result instanceof DaemonError && result.code === 'closed'), `pending request: ${String(result)}`);
  await until(views, client, (x) => /not running/.test(x.problem ?? ''), 2000);

  daemon = await startDaemon(dir, CONFIG);
  await daemon.attach(XL, new FakeDeck());
  const up = await until(views, client, (x) => x.connected && (x.decks ?? []).some((d) => d.serial === XL), 3000);
  assert.equal(up.problem, null);
  assert.equal(up.status?.activeProfile?.id, 'default');
});

await check("stopping the client clears the previews it set (the daemon's rule, through this client)", async () => {
  const session = daemon.sessions.get(XL);
  await client.previewSet(XL, 7, { label: 'mine' });
  assert.deepEqual(session.previewKeys(), [7]);
  client.stop();
  const started = Date.now();
  while (session.previewKeys().length > 0 && Date.now() - started < 2000) await sleep(20);
  assert.deepEqual(session.previewKeys(), []);
});

await check('a stopped client does not reconnect', async () => {
  const count = views.length;
  await sleep(600);
  assert.equal(client.view().connected, false);
  assert.equal(views.length, count, 'the view changed after stop()');
});

await check('no daemon at start: reports "not running", then connects when it appears', async () => {
  const lateDir: string = await scratchDir();
  const late = newClient(path.join(lateDir, 'c.sock'));
  late.client.start();
  await until(late.views, late.client, (x) => /not running/.test(x.problem ?? ''));
  const lateDaemon = await startDaemon(lateDir, CONFIG);
  await until(late.views, late.client, (x) => x.connected, 3000);
  late.client.stop();
  await lateDaemon.stop();
  await fs.rm(lateDir, { recursive: true, force: true });
});

await check('no socket path ($XDG_RUNTIME_DIR unset): a clear problem, and no retrying', async () => {
  const none = newClient(null);
  none.client.start();
  assert.match(none.client.view().problem ?? '', /XDG_RUNTIME_DIR/);
  await sleep(300);
  assert.equal(none.views.length, 1);
  none.client.stop();
});

await check('a socket that accepts but never answers: the handshake times out and the client retries', async () => {
  const silentDir: string = await scratchDir();
  const silentPath = path.join(silentDir, 's.sock');
  let connections = 0;
  const silent = net.createServer((socket) => {
    connections++;
    socket.on('data', () => undefined);
  });
  await new Promise<void>((resolve) => silent.listen(silentPath, resolve));
  const c = newClient(silentPath, { replyTimeoutMs: 150 });
  c.client.start();
  await until(c.views, c.client, (x) => /did not answer/.test(x.problem ?? ''));
  const started = Date.now();
  while (connections < 2 && Date.now() - started < 2000) await sleep(20);
  assert.ok(connections >= 2, `connections: ${connections}`);
  assert.equal(c.client.view().connected, false);
  c.client.stop();
  await new Promise((resolve) => silent.close(resolve));
  await fs.rm(silentDir, { recursive: true, force: true });
});

await check('audio device lists: null until the daemon has read them, then kept current by the audio event, and read again on connecting', async () => {
  const audioDir: string = await scratchDir();
  let state: unknown = null;
  const device = (name: string, description: string, extra: Record<string, unknown> = {}) => ({ name, description, flags: ['HARDWARE'], monitorSource: '', portAvailability: 'available', ...extra });
  const withAudio = await startDaemon(audioDir, CONFIG, { audioState: () => state });
  const first = newClient(withAudio.socket);
  first.client.start();
  let v = await until(first.views, first.client, (x) => x.connected);
  assert.equal(v.audio, null, 'the daemon answers "internal" before it has read audio state');
  state = {
    sinks: [],
    defaultSink: 'out.a',
    defaultSinkVolume: null,
    defaultSinkMuted: false,
    defaultSourceMuted: false,
    sinkDevices: [device('out.a', 'Speakers', { monitorSource: 'out.a.monitor' }), device('out.net', 'Network', { flags: ['NETWORK'], monitorSource: 'out.net.monitor' })],
    sourceDevices: [device('in.a', 'Desk mic'), device('out.a.monitor', 'Monitor of Speakers', { monitorSource: 'out.a' })],
    defaultSource: 'in.a',
  };
  withAudio.events.audio();
  v = await until(first.views, first.client, (x) => (x.audio?.sinks.devices.length ?? 0) > 0);
  assert.deepEqual(v.audio, {
    sinks: { default: 'out.a', devices: [{ node: 'out.a', label: 'Speakers', available: 'yes' }] },
    sources: { default: 'in.a', devices: [{ node: 'in.a', label: 'Desk mic', available: 'yes' }] },
  });
  first.client.stop();
  const second = newClient(withAudio.socket);
  second.client.start();
  v = await until(second.views, second.client, (x) => x.connected);
  assert.equal(v.audio?.sinks.devices[0]?.node, 'out.a', 'read at connect');
  second.client.stop();
  await withAudio.stop();
  await fs.rm(audioDir, { recursive: true, force: true });
});

await daemon.stop();
await fs.rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
