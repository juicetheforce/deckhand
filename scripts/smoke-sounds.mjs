/**
 * Offline test for the soundboard (src/services/sounds.ts, src/actions/sound.ts):
 * every press behaviour, Stop all, a file that cannot be played, an output
 * that is not there, pw-play and the paplay fallback, and a key's face
 * following its player starting and ending — on a real DeckSession, with no
 * timer of its own. Runs against scripts/test/fake-sound-player.sh on PATH as
 * pw-play and paplay, which plays nothing; and fake-pactl for the outputs.
 *
 *   npm run build:ts && node scripts/smoke-sounds.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FakeDeck, KeyFailures, REPO, DeckSession, check, commands, failureCount, hidDevice, scratchDir, sleep } from './test/control-harness.mjs';

const TMP = await scratchDir();
const BIN = path.join(TMP, 'bin');
const LOG = path.join(TMP, 'sound.log');
await fs.mkdir(BIN);
const player = path.join(REPO, 'scripts/test/fake-sound-player.sh');
await fs.symlink(player, path.join(BIN, 'pw-play'));
await fs.symlink(player, path.join(BIN, 'paplay'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(BIN, 'pactl'));
// Only the fakes, and node for them: a real pw-play on this machine must
// never be found — and node's own directory is usually /usr/bin, where it is.
await fs.symlink(process.execPath, path.join(BIN, 'node'));
process.env.PATH = BIN;
process.env.FAKE_SOUND_LOG = LOG;
process.env.DECKHAND_SOUND_CONFIRM_MS = '150';

const sounds = await import(path.join(REPO, 'dist/services/sounds.js'));
const audio = await import(path.join(REPO, 'dist/services/audio.js'));
const { registry, attempt, runRelease } = await import(path.join(REPO, 'dist/actions/index.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));

/** A sound file the fake plays for `ms`, or refuses ("bad"). */
async function soundFile(name, text) {
  const file = path.join(TMP, name);
  await fs.writeFile(file, String(text));
  return file;
}
const starts = async () => (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const clearLog = () => fs.writeFile(LOG, '');

// What the service logs on its own (a failure after the press was judged).
const errors = [];
const consoleError = console.error;
console.error = (...args) => {
  errors.push(args.join(' '));
  consoleError(...args);
};

const logs = [];
const ctx = { deck: null, key: '0', source: 'deck', switchProfile: async () => undefined, invalidateByType: () => undefined, log: (m) => logs.push(m) };
const press = (action) => attempt(ctx, action);
const idOf = (action) => sounds.soundId({ file: action.file, node: action.node ?? null, volume: action.volume ?? 100 }, action.mode ?? 'playStop');
/** Wait until nothing of this sound plays, or give up. */
async function ended(id, ms = 3000) {
  const until = Date.now() + ms;
  while (sounds.isPlaying(id) && Date.now() < until) await sleep(20);
  return !sounds.isPlaying(id);
}

let changes = 0;
sounds.subscribe(() => changes++);

const LONG = await soundFile('long.wav', 5000);
const SHORT = await soundFile('short.wav', 300);
const BLIP = await soundFile('blip.wav', 20);
const BAD = await soundFile('bad.mp3', 'bad');
const DECK = await soundFile('deck.wav', 1200);

console.log('Play/Stop, the default');
{
  await clearLog();
  const action = { type: 'sound.play', file: LONG };
  const id = idOf(action);
  const before = changes;
  check('a press plays it', (await press(action)) === null && sounds.isPlaying(id));
  check('...through pw-play, at the file\'s own level, on the default output', (await starts())[0] === `pw-play --volume 1.000 ${LONG}`);
  check('...and its start is announced', changes > before);
  check('its face is the playing block', defaultIconFor(action, registry['sound.play'].iconState(action)) === 'sound-playing');
  check('…or, with its own active icon, that', (await registry['sound.play'].describe(ctx, { ...action, iconActive: '~/p.png' }))?.icon === '~/p.png');
  check('a second press stops it', (await press(action)) === null && (await ended(id)));
  check('...starting nothing', (await starts()).length === 1);
  check('...and its face is the idle pad again', defaultIconFor(action, registry['sound.play'].iconState(action)) === 'sound-play');
  check('…and with its active icon, nothing of its own while not playing: its Default icon, or the built-in', (await registry['sound.play'].describe(ctx, { ...action, iconActive: '~/p.png' })) === null);
  check('the sound key is redrawn on events only, never on the clock', registry['sound.play'].redraw === 'events');
  check('a stopped pw-play (exit 1 on SIGTERM) is not taken for a failure', !errors.some((l) => l.includes('could not play')));
}

console.log('a sound that ends by itself');
{
  const action = { type: 'sound.play', file: SHORT };
  const id = idOf(action);
  await press(action);
  check('plays', sounds.isPlaying(id));
  check('...and is not playing once it has ended', await ended(id));
  check('a press after it ended plays it again, rather than stopping nothing', (await press(action)) === null && sounds.isPlaying(id));
  await ended(id);
}

console.log('Play/Restart');
{
  await clearLog();
  const action = { type: 'sound.play', file: LONG, mode: 'playRestart' };
  const id = idOf(action);
  await press(action);
  await press(action);
  await sleep(100);
  check('a press while it plays starts it again', (await starts()).length === 2);
  check('...and only one of it is playing', sounds.playerCount(id) === 1);
  sounds.stop(id);
  check('...stopped', await ended(id));
}

console.log('Play/Overlap');
{
  await clearLog();
  const action = { type: 'sound.play', file: SHORT, mode: 'playOverlap' };
  const id = idOf(action);
  await Promise.all([press(action), press(action), press(action)]);
  check('every press plays it once more', (await starts()).length === 3 && sounds.playerCount(id) === 3);
  check('...and it is playing until the last ends', await ended(id));
}

console.log('Loop/Stop');
{
  await clearLog();
  const action = { type: 'sound.play', file: SHORT, mode: 'loopStop' };
  const id = idOf(action);
  await press(action);
  check('a press loops it', sounds.isLooping(id));
  check('its face is the looping block', defaultIconFor(action, registry['sound.play'].iconState(action)) === 'sound-looping');
  await sleep(800);
  check('...started again each time it ends', (await starts()).length >= 2);
  await press(action);
  check('the next press stops it', await ended(id));
  const count = (await starts()).length;
  await sleep(500);
  check('...and it is not started again', (await starts()).length === count);
  const blip = { type: 'sound.play', file: BLIP, mode: 'loopStop' };
  await clearLog();
  await press(blip);
  await sleep(300);
  check('a sound that ends within 250 ms is not looped (no respawn loop)', (await starts()).length === 1 && !sounds.isPlaying(idOf(blip)));
}

console.log('Hold to play');
{
  const action = { type: 'sound.play', file: LONG, mode: 'hold' };
  const id = idOf(action);
  await press(action);
  check('a press plays it', sounds.isPlaying(id));
  check('letting go stops it, and counts as acting', (await runRelease(ctx, action, 400)) === null && (await ended(id)));
  check('a release with nothing playing does nothing (the press keeps its mark)', (await runRelease(ctx, action, 400)) === undefined);
  check('a release of another mode does nothing', (await runRelease(ctx, { type: 'sound.play', file: LONG }, 400)) === undefined);
  // Let go before the press has finished waiting to see the player start.
  const pressed = press(action);
  await sleep(40);
  await runRelease(ctx, action, 40);
  check('a quick tap: the press is not failed by its own release stopping the player', (await pressed) === null && (await ended(id)));
  check('...and nothing is logged as a failure', !errors.some((l) => l.includes('could not play')));
}

console.log('Stop all sounds');
{
  const a = { type: 'sound.play', file: LONG };
  const b = { type: 'sound.play', file: LONG, mode: 'loopStop', volume: 40 };
  await press(a);
  await press(b);
  check('two sounds playing', sounds.isPlaying(idOf(a)) && sounds.isPlaying(idOf(b)) && sounds.anyPlaying());
  check('Stop all stops both, loop included', (await press({ type: 'sound.stopAll' })) === null && (await ended(idOf(a))) && (await ended(idOf(b))));
  check('...and nothing is playing', !sounds.anyPlaying());
  check('Stop all with nothing playing is not a failure', (await press({ type: 'sound.stopAll' })) === null);
  check('its face is the stop-all icon', defaultIconFor({ type: 'sound.stopAll' }) === 'sound-stop-all');
}

console.log('what cannot be played fails the press');
{
  const bad = await press({ type: 'sound.play', file: BAD });
  check('a file the player refuses: the press fails, saying why', bad !== null && bad.message.includes('could not play bad.mp3') && bad.message.includes('open failed'));
  const missing = await press({ type: 'sound.play', file: path.join(TMP, 'nothing-here.wav') });
  check('a file that is not there', missing !== null && missing.message.includes('is not there'));
  const dir = await press({ type: 'sound.play', file: TMP });
  check('a folder', dir !== null && dir.message.includes('is not a file'));
  const none = await press({ type: 'sound.play' });
  check('no file at all', none !== null && none.message.includes('needs a "file"'));
  check('a key with no file draws the idle pad without throwing', defaultIconFor({ type: 'sound.play' }, registry['sound.play'].iconState({ type: 'sound.play' })) === 'sound-play');
}

console.log('outputs');
{
  await audio.refreshCache();
  const HEADSET = 'alsa_output.usb-Example_Headset-00.analog-stereo';
  await clearLog();
  const there = { type: 'sound.play', file: SHORT, node: HEADSET, label: 'Example Headset', volume: 50 };
  check('an output that is there: played on it', (await press(there)) === null && (await starts())[0] === `pw-play --volume 0.500 --target ${HEADSET} ${SHORT}`);
  await ended(idOf(there));
  const gone = await press({ type: 'sound.play', file: SHORT, node: 'alsa_output.usb-Unplugged-00.analog-stereo', label: 'Unplugged' });
  check('an output that is not there fails the press rather than play elsewhere', gone !== null && gone.message.includes('"Unplugged"') && gone.message.includes('is not present'));
}

console.log('paplay, where pw-play is missing');
{
  await fs.rm(path.join(BIN, 'pw-play'));
  await clearLog();
  const action = { type: 'sound.play', file: SHORT, node: 'alsa_output.usb-Example_Headset-00.analog-stereo', volume: 25 };
  check('plays through paplay', (await press(action)) === null && (await starts())[0] === `paplay --client-name=Deckhand --volume=16384 --device=alsa_output.usb-Example_Headset-00.analog-stereo ${SHORT}`);
  sounds.stop(idOf(action));
  check('...and stops (paplay exits 0 on SIGTERM)', await ended(idOf(action)));
  await fs.rm(path.join(BIN, 'paplay'));
  const neither = await press({ type: 'sound.play', file: SHORT });
  check('neither installed: the press fails, naming both', neither !== null && neither.message.includes('neither pw-play nor paplay'));
  await fs.symlink(player, path.join(BIN, 'pw-play'));
}

console.log("the editor's preview of a clip (sound.preview)");
{
  const deps = { sessions: new Map(), profiles: () => null, unattachedDecks: () => new Map() };
  const handlers = commands.createHandlers(deps);
  const snapshot = () => commands.stateSnapshot(deps);
  const key = { type: 'sound.play', file: LONG };
  await press(key);
  await clearLog();
  const reply = await handlers['sound.preview']({ file: SHORT, node: 'alsa_output.usb-Example_Headset-00.analog-stereo', volume: 40 });
  check('a preview plays the clip, on the output and at the volume given', reply.playing === true && (await starts())[0] === `pw-play --volume 0.400 --target alsa_output.usb-Example_Headset-00.analog-stereo ${SHORT}`);
  check('…and the state says which clip', snapshot().previewingSound === SHORT && sounds.previewing() === SHORT);
  check("…beside a key's sound, which it leaves alone", sounds.isPlaying(idOf(key)));
  await handlers['sound.preview']({ file: LONG });
  await sleep(100);
  check('a second preview replaces the first', sounds.previewing() === LONG && snapshot().previewingSound === LONG);
  check('…one preview at a time', sounds.playerCount('preview') === 1);
  check('stop: true stops it', (await handlers['sound.preview']({ stop: true })).stopped === true && (await ended('preview')) && !('previewingSound' in snapshot()));
  check("…and the key's sound plays on", sounds.isPlaying(idOf(key)));
  await handlers['sound.preview']({ file: SHORT });
  check('a clip that ends by itself leaves the state', (await ended('preview')) && sounds.previewing() === null);
  let refused = null;
  try {
    await handlers['sound.preview']({ file: path.join(TMP, 'nothing-here.wav') });
  } catch (err) {
    refused = err;
  }
  check('a file that is not there: action_failed, saying so', refused?.code === 'action_failed' && refused.message.includes('is not there'));
  sounds.stopAll();
  await ended(idOf(key));
}

console.log('a key on a deck shows its sound playing, and stops showing it when it ends');
{
  const raw = new FakeDeck({ columns: 2, rows: 1, pixels: 72 });
  const session = new DeckSession(hidDevice(raw, 'SOUND'), {
    serial: 'SOUND',
    hardware: {},
    layout: { startPage: 'main', pages: { main: { buttons: { 0: { action: { type: 'sound.play', file: DECK } }, 1: { label: 'x' } } } } },
    defaults: {},
    switchProfile: async () => undefined,
    failures: new KeyFailures(),
    profileOf: () => 'default',
  });
  // As src/index.ts does.
  const stopWatching = sounds.subscribe(() => session.invalidateByType(['sound.play']));
  await session.start();
  const idle = raw.images.get(0);
  raw.press(0);
  raw.release(0);
  await sleep(400);
  const playing = raw.images.get(0);
  check('pressed: the key is redrawn as playing', playing !== undefined && !playing.equals(idle));
  check('...while it plays', sounds.isPlaying(idOf({ file: DECK })));
  await ended(idOf({ file: DECK }));
  await sleep(700);
  check('ended: drawn idle again, with no press', raw.images.get(0).equals(idle));
  const writes = raw.writes.get(0);
  await sleep(1200);
  check('...and not drawn again at rest', raw.writes.get(0) === writes);
  stopWatching();
  await session.close();
}

sounds.stopAll();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nsounds: all checks passed' : `\nsounds: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
