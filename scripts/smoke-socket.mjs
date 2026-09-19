/**
 * Offline test of the control socket (docs/scope.md §7, "M3 protocol design"),
 * over a real Unix socket, against fake decks, a fake input helper
 * (scripts/test/fake-input-helper.mjs) and a fake pactl
 * (scripts/test/fake-pactl.mjs). No Stream Deck, /dev/uinput or audio server.
 *
 *   npm run build:ts && node scripts/smoke-socket.mjs      (npm run smoke runs it too)
 *
 * Two sections prove the reasons the socket is built the way it is:
 *   - "stuck keys": no socket client can leave a key held down;
 *   - "flood": a client flooding the socket cannot delay a deck key press by
 *     more than one socket keystroke.
 * The flood section measures timing, so a heavily loaded machine could fail it
 * spuriously; its margin is one keystroke plus 50 ms.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));

// Fakes first: src/input.js reads DECKHAND_INPUT_BIN when it is imported.
const INPUT_LOG = path.join(TMP, 'input.log');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');
process.env.FAKE_INPUT_LOG = INPUT_LOG;
const PACTL_LOG = path.join(TMP, 'pactl.log');
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(TMP, 'bin', 'pactl'));
process.env.PATH = `${path.join(TMP, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_LOG = PACTL_LOG;

const { FakeDeck, startDaemon, connect, check, failureCount, sleep, server, commands } = await import('./test/control-harness.mjs');
const { input } = await import(path.join(REPO, 'dist/input.js'));
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));
const audio = await import(path.join(REPO, 'dist/services/audio.js'));
const { geometryOf } = await import(path.join(REPO, 'dist/geometry.js'));
const { renderButton } = await import(path.join(REPO, 'dist/render.js'));
const { MAX_LINE_BYTES, MAX_CONNECTIONS, ControlServer, ControlError } = server;

input.start();

async function helperLog() {
  const text = await fs.readFile(INPUT_LOG, 'utf8').catch(() => '');
  return text.trim() === '' ? [] : text.trim().split('\n').map((line) => JSON.parse(line));
}
/** Keycodes the fake helper has down after its most recent command. */
async function keysDown() {
  const entries = await helperLog();
  return entries.length === 0 ? [] : entries[entries.length - 1].down;
}

const F21 = 191, F22 = 192, F23 = 193, F24 = 194;

// Test-only actions.
let counted = 0;
registry['test.count'] = { async execute() { counted++; } };
registry['test.slow'] = { async execute() { await sleep(400); } };
registry['test.slowFace'] = { async describe() { await sleep(200); return { label: 'slow' }; } };
let liveDescribes = 0;
registry['test.live'] = { async describe() { liveDescribes++; return { label: `live ${liveDescribes}` }; } };
registry['test.downThenThrow'] = { async execute(ctx) { await input.down('f22', ctx.source); throw new Error('failed after pressing'); } };

const CONFIG = {
  decks: { XL1: { name: 'XL', brightness: 60 } },
  profiles: {
    home: {
      name: 'Home',
      layouts: {
        XL1: { pages: {
          main: { buttons: {
            0: { label: 'saved', action: { type: 'test.count' } },
            1: { label: 'ptt', action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } },
            2: { label: 'press me', action: { type: 'hotkey', keys: 'f21' } },
            3: { action: { type: 'test.slowFace' } },
          } },
          p2: { buttons: {} },
        } },
        V21: { pages: { main: { buttons: {} } } },
      },
    },
    raid: { name: 'FFXIV Raid', layouts: { XL1: { pages: { combat: { buttons: {} } } } } },
  },
};

const daemon = await startDaemon(TMP, CONFIG, {
  releaseSocketKeys: () => input.releaseAllHeldBy('socket'),
  audioState: () => audio.cachedState(),
});
const xlFake = new FakeDeck();
const v2Fake = new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Fake V2' });
const xl = await daemon.attach('XL1', xlFake);
await daemon.attach('V21', v2Fake);
daemon.unattached.set('NEW9', geometryOf(new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Unconfigured' })));
await sleep(500);
const client = await connect(daemon.socket);
const run = (args) => client.request('action.run', { serial: 'XL1', ...args });

// ---------------------------------------------------------------------------
console.log('transport');
{
  const mode = (await fs.stat(daemon.socket)).mode & 0o777;
  check('socket file is mode 0600', mode === 0o600);

  const c = await connect(daemon.socket);
  c.write('{"id":1,"cmd":"sta'); await sleep(30); c.write('tus"}\n{"id":"two","cmd":"status"}\n');
  c.write('not json\n[1]\n{"cmd":"status"}\n{"id":3}\n{"id":4,"cmd":"status","args":[1]}\n{"id":5,"cmd":"nosuch"}\n{"id":6,"cmd":"toString"}\n\n  \n');
  await sleep(300);
  const byId = (id) => c.lines.find((l) => l.id === id);
  check('a request split across writes, and two in one write', byId(1)?.ok && byId('two')?.ok);
  const unmatched = c.lines.filter((l) => l.id === null).map((l) => l.error.code);
  check('bad JSON -> bad_json; non-object and missing id -> bad_request; all with id null', unmatched.join() === 'bad_json,bad_request,bad_request');
  check('missing cmd, and args not an object -> bad_request with the id', byId(3)?.error.code === 'bad_request' && byId(4)?.error.code === 'bad_request');
  check('unknown command, including inherited names -> unknown_command', byId(5)?.error.code === 'unknown_command' && byId(6)?.error.code === 'unknown_command');
  check('blank lines get no reply', c.lines.length === 9);
  c.close();

  const long = await connect(daemon.socket);
  long.write('{"id":1,"cmd":"status","args":{"x":"' + 'a'.repeat(MAX_LINE_BYTES + 10));
  await Promise.race([long.closed, sleep(2000)]);
  check('a line over 64 KiB, even unfinished -> line_too_long, connection closed', long.lines[0]?.error.code === 'line_too_long' && long.socket.destroyed);

  const crowd = [];
  for (let i = 0; i < MAX_CONNECTIONS + 2; i++) crowd.push(await connect(daemon.socket));
  await sleep(150);
  const refused = crowd.filter((c2) => c2.lines[0]?.error.code === 'too_many_connections');
  check(`at most ${MAX_CONNECTIONS} connections; the rest told too_many_connections`, daemon.control.connectionCount() === MAX_CONNECTIONS && refused.length === 3);
  for (const c2 of crowd) c2.close();
  await sleep(150);

  // A subscriber that stops reading is disconnected, not buffered for forever.
  const lazy = await connect(daemon.socket);
  await lazy.request('subscribe', { events: ['config'] });
  lazy.socket.pause();
  let sent = 0;
  while (!daemon.control['connections'].size || [...daemon.control['connections']].some((cn) => cn.subscriptions.has('config'))) {
    daemon.control.broadcast('config', 'x'.repeat(16000));
    if (++sent % 20 === 0) await sleep(1);
    if (sent > 20000) break;
  }
  check(`a subscriber that stops reading is disconnected (after ${sent} events of 16 KB)`, sent < 20000);

  // Stale, live and foreign files at the socket path.
  const other = path.join(TMP, 's.sock');
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(other)}, () => console.log('up'))`]);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGKILL');
  await sleep(100);
  const s2 = new ControlServer({});
  check('a stale socket left by a killed process is replaced', await s2.start(other));
  check('a socket another server answers on is left alone', (await new ControlServer({}).start(other)) === false);
  await s2.stop();
  await fs.writeFile(other, 'not a socket');
  check('a regular file at the path is refused and not touched', (await new ControlServer({}).start(other)) === false && (await fs.readFile(other, 'utf8')) === 'not a socket');
  check('a path over 107 bytes is refused', (await new ControlServer({}).start(path.join(TMP, 'x'.repeat(120)))) === false);

  const errors = new ControlServer({ boom: async () => { throw new Error('kaboom'); }, typed: async () => { throw new ControlError('not_found', 'nope'); } });
  const errorsSocket = path.join(TMP, 'e.sock');
  await errors.start(errorsSocket);
  const ec = await connect(errorsSocket);
  check('a ControlError keeps its code; anything else is internal', (await ec.request('typed')).error.code === 'not_found' && (await ec.request('boom')).error.code === 'internal');
  ec.close(); await errors.stop();
}

// ---------------------------------------------------------------------------
console.log('status and decks');
{
  const s = (await client.request('status')).result;
  check('status: protocol, pid, config', s.protocol === 1 && s.pid === process.pid && s.config.path === '/test/config.json');
  check('status: active profile id and name', s.activeProfile.id === 'home' && s.activeProfile.name === 'Home');
  const deck = (serial) => s.decks.find((d) => d.serial === serial);
  check('attached deck carries profile, page, brightness, previews', JSON.stringify(deck('XL1')) === JSON.stringify({ serial: 'XL1', connected: true, configured: true, profile: 'home', page: 'main', brightness: 60, previews: [], failed: [] }));
  check('a connected deck with no layout is listed', JSON.stringify(deck('NEW9')) === JSON.stringify({ serial: 'NEW9', connected: true, configured: false }));
  daemon.state.lastReload = { ok: false, at: 'now', error: 'refused' };
  check('status reports a refused reload', (await client.request('status')).result.config.lastReload.error === 'refused');
  daemon.state.lastReload = { ok: true, at: 'now' };

  const decks = (await client.request('decks')).result;
  const xlGeo = decks.find((d) => d.serial === 'XL1');
  check('decks: attached and unconfigured, sorted', decks.map((d) => d.serial).join() === 'NEW9,V21,XL1');
  check('decks: XL geometry with row/column per key', xlGeo.keyCount === 32 && xlGeo.iconSize === 96 && xlGeo.rows === 4 && xlGeo.columns === 8 && xlGeo.keys[9].row === 1 && xlGeo.keys[9].column === 1);
  check('decks: the unconfigured deck geometry comes from the cache', decks.find((d) => d.serial === 'NEW9').keyCount === 15);

  const plus = geometryOf({ MODEL: 'plus', PRODUCT_NAME: 'Plus', CONTROLS: [
    ...new FakeDeck({ columns: 4, rows: 2, pixels: 120 }).CONTROLS,
    { type: 'lcd-segment', row: 2, column: 0, columnSpan: 4, rowSpan: 1, id: 0, pixelSize: { width: 800, height: 100 } },
    ...[0, 1, 2, 3].map((i) => ({ type: 'encoder', row: 3, column: i, index: i, hidIndex: i })),
  ] });
  check('geometry: a Plus-shaped deck reports its strip and encoders as unsupported', plus.rows === 4 && plus.columns === 4 && plus.keyCount === 8 && plus.unsupported.length === 5);
  const pedal = geometryOf({ MODEL: 'pedal', CONTROLS: [0, 1, 2].map((i) => ({ type: 'button', index: i, row: 0, column: i, feedbackType: 'none' })) });
  check('geometry: a screenless deck has iconSize null', pedal.iconSize === null && pedal.keyCount === 3);
}

// ---------------------------------------------------------------------------
console.log('repaint and profile.switch');
{
  let before = xlFake.writes.get(0);
  check('repaint one deck', (await client.request('repaint', { serial: 'XL1' })).result.repainted.join() === 'XL1' && xlFake.writes.get(0) === before + 1);
  check('repaint every deck', (await client.request('repaint')).result.repainted.join() === 'V21,XL1');
  before = xlFake.writes.get(0);
  const burst = await Promise.all(Array.from({ length: 10 }, () => client.request('repaint', { serial: 'XL1' })));
  check(`10 overlapping repaints: all ok, deck painted twice (${xlFake.writes.get(0) - before})`, burst.every((r) => r.ok) && xlFake.writes.get(0) - before === 2);
  check('repaint errors: not_found, bad_request', (await client.request('repaint', { serial: 'NOPE' })).error.code === 'not_found' && (await client.request('repaint', { serial: 3 })).error.code === 'bad_request');
  check('a known deck with no session -> deck_not_connected', (await client.request('repaint', { serial: 'NEW9' })).error.code === 'deck_not_connected');

  const sw = (await client.request('profile.switch', { to: 'FFXIV Raid' })).result;
  check('profile.switch by name, through Profiles: XL moved, V2 kept its layout', sw.changed && sw.active.id === 'raid' && xl.currentPage() === 'combat' && daemon.profiles.shownProfileFor('V21') === 'home');
  check('switching to the active profile -> changed false', (await client.request('profile.switch', { to: 'raid' })).result.changed === false);
  check('unknown profile -> not_found', (await client.request('profile.switch', { to: 'nope' })).error.code === 'not_found');
  await client.request('profile.switch', { to: 'home' });
}

// ---------------------------------------------------------------------------
console.log('preview.set and preview.clear');
{
  const good = path.join(TMP, 'good.png');
  const sharp = (await import('node:module')).createRequire(path.join(REPO, 'package.json'))('sharp');
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toFile(good);
  await fs.writeFile(path.join(TMP, 'bad.png'), 'not an image');

  const saved = xlFake.images.get(0);
  check('preview.set shows the button', (await client.request('preview.set', { serial: 'XL1', key: 0, button: { label: 'PREVIEW' } })).ok && xlFake.images.get(0) !== saved);
  counted = 0; xlFake.press(0); xlFake.release(0); await sleep(150);
  check('pressing a previewed key does not run the saved action', counted === 0);
  await client.request('preview.set', { serial: 'XL1', key: 0, button: { label: 'P', action: { type: 'test.count' } } });
  counted = 0; xlFake.press(0); xlFake.release(0); await sleep(150);
  check('...nor the previewed one', counted === 0);

  await xl.goToPage('p2');
  await daemon.profiles.switchTo('raid', daemon.sessions);
  await daemon.profiles.applyReload(daemon.state.config, daemon.sessions);
  check('a preview survives a page change, profile switch and reload', xl.previewKeys().join() === '0');
  await daemon.profiles.switchTo('home', daemon.sessions);
  check('preview.clear restores the saved image', (await client.request('preview.clear', { serial: 'XL1', key: 0 })).result.cleared.join() === '0' && Buffer.compare(xlFake.images.get(0), saved) === 0);

  check('a good icon renders', (await client.request('preview.set', { serial: 'XL1', key: 5, button: { icon: good } })).ok);
  const bad = await client.request('preview.set', { serial: 'XL1', key: 6, button: { icon: path.join(TMP, 'bad.png') } });
  check('a corrupt icon -> render_failed, preview not kept', bad.error?.code === 'render_failed' && !xl.previewKeys().includes(6));
  check('a missing icon -> render_failed', (await client.request('preview.set', { serial: 'XL1', key: 6, button: { icon: path.join(TMP, 'missing.png') } })).error?.code === 'render_failed');

  liveDescribes = 0;
  await client.request('preview.set', { serial: 'XL1', key: 7, button: { action: { type: 'test.live' }, refreshMs: 100 } });
  await sleep(1100);
  check(`a live previewed key refreshes on the tick (${liveDescribes})`, liveDescribes >= 2);

  const before = xlFake.writes.get(8) ?? 0;
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => client.request('preview.set', { serial: 'XL1', key: 8, button: { label: `b${i}` } })));
  const latest = await renderButton({ label: 'b19', iconFit: 'cover', labelColor: '#ffffff', labelSize: 14, labelPosition: 'bottom', background: '#101014' }, 96);
  check(`20 overlapping previews on one key: at most 2 renders (${(xlFake.writes.get(8) ?? 0) - before}), latest shown`, burst.every((r) => r.ok) && (xlFake.writes.get(8) ?? 0) - before <= 2 && Buffer.compare(xlFake.images.get(8), latest) === 0);

  check('argument errors', (await client.request('preview.set', { serial: 'XL1', key: 32, button: {} })).error.code === 'not_found'
    && (await client.request('preview.set', { serial: 'XL1', key: 1.5, button: {} })).error.code === 'bad_request'
    && (await client.request('preview.set', { serial: 'XL1', key: 0, button: { action: { type: 'nope' } } })).error.code === 'bad_request');

  const other = await connect(daemon.socket);
  await other.request('preview.set', { serial: 'XL1', key: 20, button: { label: 'theirs' } });
  await other.request('preview.set', { serial: 'XL1', key: 21, button: { label: 'taken over' } });
  await client.request('preview.set', { serial: 'XL1', key: 21, button: { label: 'mine now' } });
  other.close(); await other.closed; await sleep(200);
  check('a closing connection clears only the previews it still owns', !xl.previewKeys().includes(20) && xl.previewKeys().includes(21));
  await client.request('preview.clear', { serial: 'XL1' });
}

// ---------------------------------------------------------------------------
console.log('action.run');
{
  check('a hotkey runs', (await run({ action: { type: 'hotkey', keys: 'f23' } })).ok);
  check('argument errors', (await run({ action: { type: 'nope' } })).error.code === 'bad_request'
    && (await run({ action: { type: 'noop' }, holdMs: 5 })).error.code === 'bad_request'
    && (await run({ action: { type: 'noop' }, onRelease: { type: 'noop' }, holdMs: 10001 })).error.code === 'bad_request');
  const failed = await run({ action: { type: 'hotkey', keys: 'notakey' } });
  check('a failing action -> action_failed with its message', failed.error?.code === 'action_failed' && /notakey/.test(failed.error.message));

  const second = await connect(daemon.socket);
  const first = run({ action: { type: 'test.slow' } });
  await sleep(50);
  check('one socket action at a time: busy on the same and another connection',
    (await run({ action: { type: 'noop' } })).error?.code === 'busy'
    && (await second.request('action.run', { serial: 'XL1', action: { type: 'noop' } })).error?.code === 'busy');
  check('the first still completes, and the next is accepted', (await first).ok && (await run({ action: { type: 'noop' } })).ok);
  second.close();

  await run({ action: { type: 'keyHold', keys: 'f23', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f23', state: 'up' }, holdMs: 300 });
  const entries = await helperLog();
  const downAt = entries.findLast((e) => e.cmd === 'DOWN' && e.codes.includes(F23));
  const upAt = entries.findLast((e) => e.cmd === 'UP' && e.codes.includes(F23));
  check(`onRelease runs after holdMs (${upAt.arrived - downAt.finished} ms)`, upAt.arrived - downAt.finished >= 290);
}

// ---------------------------------------------------------------------------
console.log('stuck keys — no socket client can leave a key held down');
{
  await run({ action: { type: 'keyHold', keys: 'f24', state: 'down' } });
  check('a bare keyHold down is released when the action finishes', (await keysDown()).length === 0);
  await run({ action: { type: 'multi', steps: [{ type: 'keyHold', keys: 'f23', state: 'down' }, { type: 'keyHold', keys: 'shift', state: 'down' }] } });
  check('a multi that presses two keys and stops: both released', (await keysDown()).length === 0);
  await run({ action: { type: 'keyHold', keys: 'f23', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } });
  check('an onRelease that releases the wrong key: the pressed key released anyway', (await keysDown()).length === 0);
  const thrown = await run({ action: { type: 'test.downThenThrow' } });
  check('an action that throws after pressing: action_failed, key released', thrown.error?.code === 'action_failed' && (await keysDown()).length === 0);

  const quitter = await connect(daemon.socket);
  quitter.write(JSON.stringify({ id: 1, cmd: 'action.run', args: { serial: 'XL1', action: { type: 'keyHold', keys: 'f22', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f22', state: 'up' }, holdMs: 800 } }) + '\n');
  await sleep(200);
  const heldWhileConnected = (await keysDown()).includes(F22);
  quitter.close(); await quitter.closed;
  await sleep(1000);
  check('the client disconnects mid-hold: the release still runs, nothing held', heldWhileConnected && (await keysDown()).length === 0);

  xlFake.press(1); await sleep(150);
  const deckHolds = (await keysDown()).includes(F24);
  await run({ action: { type: 'multi', steps: [{ type: 'keyHold', keys: 'f24', state: 'down' }, { type: 'keyHold', keys: 'f23', state: 'down' }] } });
  const afterSocket = await keysDown();
  check('a deck push-to-talk on f24 is not cut off when a socket action that also pressed f24 finishes', deckHolds && afterSocket.includes(F24) && !afterSocket.includes(F23));
  xlFake.release(1); await sleep(150);
  check('...and is released by the deck key', (await keysDown()).length === 0);
}

// ---------------------------------------------------------------------------
console.log('audio.sinks and audio.sources');
{
  check('before the audio cache is read -> internal, explained', /not been read/.test((await client.request('audio.sinks')).error?.message ?? ''));
  await audio.refreshCache();
  const spawns = (await fs.readFile(PACTL_LOG, 'utf8')).trim().split('\n').length;
  const sinks = (await client.request('audio.sinks')).result;
  const byNode = Object.fromEntries(sinks.devices.map((d) => [d.node, d]));
  check('network sink left out; both sinks of one device listed', sinks.devices.length === 4 && !sinks.devices.some((d) => d.node.startsWith('raop_sink')) && byNode['alsa_output.usb-Example_Headset-00.mono-chat']);
  check('an unplugged jack is listed, available "no"', byNode['alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink'].available === 'no');
  check('a "(null)" description falls back to the node name', byNode['alsa_output.usb-Accented_Device-00.analog-stereo'].label === 'alsa_output.usb-Accented_Device-00.analog-stereo');
  const sources = (await client.request('audio.sources')).result;
  check('monitor sources left out: 3 real inputs', sources.devices.length === 3 && sources.devices.every((d) => !d.node.endsWith('.monitor')));
  await Promise.all(Array.from({ length: 200 }, (_, i) => client.request(i % 2 ? 'audio.sinks' : 'audio.sources')));
  check('200 device-list requests spawn no pactl', (await fs.readFile(PACTL_LOG, 'utf8')).trim().split('\n').length === spawns);
}

// ---------------------------------------------------------------------------
console.log('subscribe and events');
{
  const sub = await connect(daemon.socket);
  const quiet = await connect(daemon.socket);
  check('unknown event -> bad_request', (await sub.request('subscribe', { events: ['state', 'nope'] })).error.code === 'bad_request');
  await sub.request('subscribe', { events: ['state', 'config', 'audio'] });
  const of = (name) => sub.events.filter((e) => e.event === name);
  const reset = () => { sub.events.length = 0; };

  reset(); await xl.goToPage('p2'); await sleep(50);
  check('a page change -> one state event with the new page', of('state').length === 1 && of('state')[0].data.decks.find((d) => d.serial === 'XL1').page === 'p2');
  reset(); await daemon.profiles.switchTo('raid', daemon.sessions); await sleep(50);
  check('a profile switch -> merged into one event showing the final state', of('state').length === 1 && of('state')[0].data.activeProfile.id === 'raid');
  reset(); for (let i = 0; i < 50; i++) daemon.events.state(); await sleep(20);
  check('50 notifications in one turn -> one event', of('state').length === 1);
  reset(); daemon.state.lastReload = { ok: false, at: 'now', error: 'both named "X"' }; daemon.events.config(); await sleep(20);
  check('config event carries a refused reload', of('config').length === 1 && /both named/.test(of('config')[0].data.error));
  reset(); daemon.events.audio(); await sleep(20);
  check('audio event when the lists first exist', of('audio').length === 1 && of('audio')[0].data.sinks.devices.length === 4);
  reset(); await audio.refreshCache(); daemon.events.audio(); await sleep(20);
  check('no audio event when the lists did not change', of('audio').length === 0);
  check('a connection that did not subscribe received nothing', quiet.events.length === 0);
  await sub.request('subscribe', { events: ['config'] });
  reset(); await daemon.profiles.switchTo('home', daemon.sessions); await sleep(50);
  check('re-subscribing replaces the set', of('state').length === 0);
  sub.close(); quiet.close();
}

// ---------------------------------------------------------------------------
console.log('flood — a flooding client cannot delay a deck key press beyond one socket keystroke');
{
  await sleep(300);
  const startedAt = Date.now();
  let stop = false;
  let busyReplies = 0;
  const flooders = [];
  for (let i = 0; i < 12; i++) {
    flooders.push((async () => {
      const c = await connect(daemon.socket);
      while (!stop) {
        const r = await c.request('action.run', { serial: 'XL1', action: { type: 'hotkey', keys: 'ctrl+f24' } });
        if (r.error?.code === 'busy') busyReplies++;
      }
      c.close();
    })());
  }
  for (const cmd of ['repaint', 'preview.set', 'decks']) {
    flooders.push((async () => {
      const c = await connect(daemon.socket);
      let i = 0;
      while (!stop) {
        if (cmd === 'preview.set') await c.request(cmd, { serial: 'XL1', key: 10 + (i++ % 10), button: { label: `p${i}` } });
        else await c.request(cmd, { serial: 'XL1' });
      }
      c.close();
    })());
  }
  await sleep(1000);

  const presses = [];
  for (let i = 0; i < 30; i++) {
    await sleep(60 + ((i * 37) % 110));
    presses.push(Date.now());
    xlFake.press(2); xlFake.release(2);
  }
  await sleep(1500);
  stop = true;
  await Promise.all(flooders);
  await sleep(300);

  const entries = (await helperLog()).filter((e) => e.arrived >= startedAt);
  const deckKeystrokes = entries.filter((e) => e.cmd === 'TAP' && e.codes.length === 1 && e.codes[0] === F21);
  const socketKeystrokes = entries.filter((e) => e.cmd === 'TAP' && e.codes.length === 2);
  const longest = Math.max(...socketKeystrokes.map((e) => e.finished - e.arrived));
  const delays = [];
  let maxAhead = 0;
  for (let i = 0, j = 0; i < presses.length; i++) {
    while (j < deckKeystrokes.length && deckKeystrokes[j].arrived < presses[i]) j++;
    if (j === deckKeystrokes.length) break;
    delays.push(deckKeystrokes[j].arrived - presses[i]);
    maxAhead = Math.max(maxAhead, socketKeystrokes.filter((e) => e.arrived >= presses[i] && e.arrived < deckKeystrokes[j].arrived).length);
    j++;
  }
  let busyMs = 0;
  for (const e of socketKeystrokes) busyMs += Math.max(0, Math.min(e.finished, presses.at(-1)) - Math.max(e.arrived, presses[0]));
  const share = busyMs / (presses.at(-1) - presses[0]);
  const sorted = [...delays].sort((a, b) => a - b);
  console.log(`       ${socketKeystrokes.length} socket keystrokes (longest ${longest} ms), ${busyReplies} busy replies; helper busy with them ${(share * 100).toFixed(0)}% of the time`);
  console.log(`       press -> keystroke at helper: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms; most socket keystrokes ahead of a press: ${maxAhead}`);
  check('every press reached the helper', delays.length === presses.length);
  check('the flood was real: helper busy with socket keystrokes at least 80% of the time', share >= 0.8 && busyReplies > 100);
  check('no press waited behind more than one socket keystroke', maxAhead <= 1);
  check(`every press within one socket keystroke plus 50 ms (${sorted.at(-1)} <= ${longest + 50})`, sorted.at(-1) <= longest + 50);
  check('nothing held after the flood', (await keysDown()).length === 0);
}

// ---------------------------------------------------------------------------
console.log('CLI');
{
  const CLI = path.join(REPO, 'dist/cli.js');
  const cli = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, DECKHAND_SOCKET: daemon.socket, ...env }, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
  check('no command -> usage, exit 2', (await cli([])).code === 2);
  let r = await cli(['status']);
  check('status -> readable, exit 0', r.code === 0 && /active profile: Home \(home\)/.test(r.stdout));
  check('status --json parses', JSON.parse((await cli(['status', '--json'])).stdout).protocol === 1);
  check('decks -> geometry line', /XL1\s+Fake XL \(xl\) — 32 keys, 4×8, 96 px/.test((await cli(['decks'])).stdout));
  r = await cli(['profile', 'FFXIV Raid']);
  check('profile with a space in the name', r.code === 0 && /switched to FFXIV Raid/.test(r.stdout) && daemon.profiles.activeProfile() === 'raid');
  check('unknown profile -> exit 1', (await cli(['profile', 'nope'])).code === 1);
  check('run with --deck', (await cli(['run', '--deck', 'XL1', '{"type":"hotkey","keys":"f23"}'])).code === 0);
  check('run without --deck and two decks running -> exit 2 listing them', /V21, XL1/.test((await cli(['run', '{"type":"noop"}'])).stderr));
  check('run with bad JSON -> exit 2', (await cli(['run', '--deck', 'XL1', '{nope'])).code === 2);
  check('sinks marks the default', /^\* Example Headset Analog Stereo/m.test((await cli(['sinks'])).stdout));
  check('raw -> reply printed; error reply exit 1', (await cli(['raw', '{"cmd":"status"}'])).code === 0 && (await cli(['raw', '{"cmd":"nosuch"}'])).code === 1);
  const watcher = spawn(process.execPath, [CLI, 'watch'], { env: { ...process.env, DECKHAND_SOCKET: daemon.socket } });
  let watched = '';
  watcher.stdout.on('data', (chunk) => { watched += chunk; });
  await sleep(600);
  await daemon.profiles.switchTo('home', daemon.sessions);
  await sleep(300);
  watcher.kill('SIGINT');
  check('watch prints a state event', /state .*"id":"home"/.test(watched));
  check('daemon not running -> exit 3 with a hint', /not running/.test((await cli(['status'], { DECKHAND_SOCKET: path.join(TMP, 'n.sock') })).stderr));
}

client.close();
await daemon.stop();
input.stop();
await sleep(200);
await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
