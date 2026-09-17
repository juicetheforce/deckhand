/**
 * Offline test for the MPRIS player state cache (docs/scope.md §11 item 1, C1
 * piece 4): media key faces read player state kept current from
 * PropertiesChanged, and make no D-Bus call on a refresh. Runs itself under
 * dbus-run-session on a private bus with no service directories, with fake
 * players from scripts/test/fake-mpris-player.mjs — never the desktop's
 * players.
 *
 *   npm run build:ts && node scripts/smoke-mpris.mjs
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  // Same private-bus config as editor/scripts/screenshot.mjs: nothing can be activated on it.
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-mpris-bus-${process.pid}.conf`);
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

const { REPO, check, failureCount, scratchDir, sleep } = await import('./test/control-harness.mjs');
const TMP = await scratchDir();
// Cover art is cached under os.tmpdir(); keep it in the scratch directory.
process.env.TMPDIR = TMP;

const mpris = await import(path.join(REPO, 'dist/services/mpris.js'));
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));
const { startFakePlayer } = await import('./test/fake-mpris-player.mjs');

const describe = (action) => registry[action.type].describe({ log: () => undefined }, action);
const control = { type: 'media.control', method: 'playpause', iconPlaying: '/icons/pause.svg', iconPaused: '/icons/play.svg' };
const info = { type: 'media.info', show: 'title+artist' };

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}

let changes = 0;
const stop = mpris.subscribe(() => changes++);
await sleep(200);

console.log('no players');
{
  check('no player: nothing cached', mpris.cachedTrackInfo() === null);
  check('no player: now-playing shows the idle label', (await describe(info))?.label === 'No music');
}

console.log('a player appears and changes');
const a = await startFakePlayer('fakeA', { status: 'Paused', track: { title: 'First', artist: 'Band' } });
{
  check('its state is cached once it appears', await until(() => mpris.cachedTrackInfo()?.title === 'First'));
  const t = mpris.cachedTrackInfo();
  check('...status, title and artist', t.status === 'Paused' && t.artist === 'Band' && t.player === 'fakeA');
  check('...and the change listener fired', await until(() => changes > 0));
  check('paused: play/pause shows iconPaused', (await describe(control))?.icon === '/icons/play.svg');
  check('...and the default icon state says not playing', registry['media.control'].iconState({ type: 'media.control', method: 'playpause' }).playing === false);
  check('now-playing shows title and artist', (await describe(info))?.label === 'First\nBand');

  const before = changes;
  a.set({ status: 'Playing' });
  check('PlaybackStatus from the signal reaches the cache', await until(() => mpris.cachedTrackInfo()?.status === 'Playing', 500));
  check('playing: play/pause shows iconPlaying', (await describe(control))?.icon === '/icons/pause.svg');
  check('...and the default icon state says playing, from the cache', registry['media.control'].iconState({ type: 'media.control', method: 'playpause' }).playing === true);
  check('...and the change listener fired again', await until(() => changes > before));

  a.set({ track: { title: 'Second', artist: 'Band' } });
  check('a track change from the signal reaches the face', await until(async () => (await describe(info))?.label === 'Second\nBand', 500));

  const calls = a.calls.length;
  const started = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) {
    await describe(control);
    await describe(info);
  }
  const perFace = Number(process.hrtime.bigint() - started) / 200 / 1e6;
  await sleep(100);
  check(`200 face refreshes make no D-Bus call to the player (${perFace.toFixed(3)} ms each)`, a.calls.length === calls);

  const getsBefore = a.calls.filter((c) => c.endsWith('.Get')).length;
  a.setSilently({ track: { title: 'Third', artist: 'Band' } });
  a.invalidate(['Metadata']);
  check('an invalidated-only signal re-reads the player', await until(() => mpris.cachedTrackInfo()?.title === 'Third', 1000));
  check('...with direct reads', a.calls.filter((c) => c.endsWith('.Get')).length > getsBefore);

  await mpris.call('PlayPause');
  check('a press still reaches the player', a.calls.includes('org.mpris.MediaPlayer2.Player.PlayPause'));
  check('...and its result comes back through the cache', await until(() => mpris.cachedTrackInfo()?.status === 'Paused', 500));
}

console.log('cover art');
{
  const artFile = path.join(TMP, 'cover.png');
  await fs.writeFile(artFile, 'not really a png');
  a.set({ track: { title: 'Local', artist: 'Band', artUrl: `file://${artFile}` } });
  check('file:// art: the cached path is the file', await until(() => mpris.cachedTrackInfo()?.artPath === artFile, 1000));
  check('...and now-playing uses it as the icon', (await describe(info))?.icon === artFile);

  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    setTimeout(() => res.end('art-bytes'), req.url.startsWith('/slow') ? 800 : 0);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  a.set({ track: { title: 'Remote', artist: 'Band', artUrl: `${base}/slow` } });
  await until(() => mpris.cachedTrackInfo()?.title === 'Remote', 500);
  const t0 = Date.now();
  const face = await describe(info);
  check('a new track shows at once, without waiting for its art', face?.label === 'Remote\nBand' && face.icon === undefined && Date.now() - t0 < 50);
  // Let the track change's own (debounced, 150 ms) notification land first,
  // so the count below can only move for the art. The download takes 800 ms.
  await sleep(300);
  const beforeArt = changes;
  check('...the art arrives in the background', await until(() => mpris.cachedTrackInfo()?.artPath !== undefined, 3000));
  check('...and the change listener fires for it (debounced 150 ms)', await until(() => changes > beforeArt, 500));
  check('...then the face shows it', (await describe(info))?.icon === mpris.cachedTrackInfo().artPath);

  a.set({ track: { title: 'Slow again', artist: 'Band', artUrl: `${base}/slow?2` } });
  await sleep(100);
  a.set({ track: { title: 'No art', artist: 'Band' } });
  await sleep(1200);
  check('(the slow download really was requested)', requests >= 2);
  check('art that finishes after the track changed is not shown', mpris.cachedTrackInfo()?.title === 'No art' && mpris.cachedTrackInfo()?.artPath === undefined);
  server.close();
}

console.log('several players, a Chromium-like one, and leaving');
const b = await startFakePlayer('chromium.instance1', { status: 'Paused', track: { title: 'Tab', artist: 'Site' }, emptyIntrospection: true });
{
  check('a player with no introspection data is cached', await until(() => mpris.cachedTrackInfo('chromium')?.title === 'Tab'));
  // Prove the fake is Chromium-like: a proxy built from its introspection has no Properties interface.
  const dbus = (await import('dbus-next')).default;
  const probe = dbus.sessionBus();
  let plainProxyFails = false;
  try {
    (await probe.getProxyObject('org.mpris.MediaPlayer2.chromium.instance1', '/org/mpris/MediaPlayer2')).getInterface('org.freedesktop.DBus.Properties');
  } catch {
    plainProxyFails = true;
  }
  probe.disconnect();
  check('...a player a plain introspected proxy cannot read, as Chromium', plainProxyFails);
  b.set({ status: 'Playing' });
  check('...and its PropertiesChanged is followed', await until(() => mpris.cachedTrackInfo('chromium')?.status === 'Playing', 1000));
  check('with none hinted, the playing player is chosen', mpris.cachedTrackInfo()?.player === 'chromium.instance1');
  check('a hint chooses the named player', mpris.cachedTrackInfo('fakeA')?.title === 'No art');
  b.set({ status: 'Paused' });
  await until(() => mpris.cachedTrackInfo('chromium')?.status === 'Paused', 500);
  check('nothing playing: the last player that played is chosen', mpris.cachedTrackInfo()?.player === 'chromium.instance1');

  await b.stop();
  check('a player that leaves is dropped', await until(() => mpris.cachedTrackInfo()?.player === 'fakeA'));
  await a.stop();
  check('with every player gone, nothing is cached', await until(() => mpris.cachedTrackInfo() === null));
  check('...and now-playing is idle again', (await describe(info))?.label === 'No music');

  const again = await startFakePlayer('fakeA', { status: 'Playing', track: { title: 'Back', artist: 'Band' } });
  check('a player that comes back is read fresh', await until(() => mpris.cachedTrackInfo()?.title === 'Back'));
  stop();
  check('stopping the subscription clears the cache', mpris.cachedTrackInfo() === null);
  await again.stop();
}

mpris.disconnect();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nmpris: all checks passed' : `\nmpris: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
