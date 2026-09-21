/**
 * Offline test of keys a deck holds down (M7, docs/scope.md §6): the release a
 * Press/Release key is waiting for, and — once it exists — the latching
 * toggle. Fake decks and the fake input helper; no Stream Deck and no
 * /dev/uinput.
 *
 *   npm run build:ts && node scripts/smoke-latch.mjs     (npm run smoke runs it too)
 *
 * The question every check here answers is the same one the control socket's
 * "stuck keys" section answers for socket clients: **can anything leave a key
 * held down at the evdev layer with nothing able to release it?** For a deck
 * key that means the page changing, the profile switching, the config
 * reloading or the deck going away under a finger.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-latch-'));

// Fakes first: src/input.js reads DECKHAND_INPUT_BIN when it is imported.
const INPUT_LOG = path.join(TMP, 'input.log');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');
process.env.FAKE_INPUT_LOG = INPUT_LOG;

const { FakeDeck, startDaemon, check, failureCount, sleep, commands } = await import('./test/control-harness.mjs');
const { input } = await import(path.join(REPO, 'dist/input.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));

input.start();
// The helper is spawned, not instant: a press before READY would be sent
// later than the check looks, and every "it was released" check would then
// pass for the wrong reason (nothing was ever held). A tap waits for READY
// and leaves nothing down.
await input.tap('f24');

/** Keycodes the fake helper has down after its most recent command. */
async function keysDown() {
  const text = await fs.readFile(INPUT_LOG, 'utf8').catch(() => '');
  if (text.trim() === '') return [];
  const entries = text.trim().split('\n').map((line) => JSON.parse(line));
  return entries[entries.length - 1].down;
}

/** Let the daemon's own promises settle: a press dispatches without being awaited. */
const settle = () => sleep(150);

const SERIAL = 'LATCH-XL';
const F24 = 194;

/** A Press/Release key (keyHold down, keyHold up) on key 0, and a page key on key 1. */
const CONFIG = {
  profiles: {
    home: {
      name: 'Home',
      layouts: {
        [SERIAL]: {
          startPage: 'one',
          pages: {
            one: {
              name: 'One',
              buttons: {
                0: { action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } },
                1: { action: { type: 'page', to: 'two' } },
              },
            },
            two: { name: 'Two', buttons: { 0: { action: { type: 'page', back: true } } } },
          },
        },
      },
    },
    other: {
      name: 'Other',
      layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } } },
    },
  },
};

const daemon = await startDaemon(TMP, CONFIG);
const fake = new FakeDeck();
await daemon.attach(SERIAL, fake);
const session = daemon.sessions.get(SERIAL);

/** Press a key on the deck, as a finger does, and let the dispatch finish. */
async function press(index) {
  fake.press(index);
  await settle();
}
async function release(index) {
  fake.release(index);
  await settle();
}

// The bug these replace (found by reading, 2026-09-20): the page changing
// under a finger *discarded* the pending release, so lifting the finger
// released nothing and f24 stayed down with no key left to release it.
console.log('a held key is released, never discarded');

await press(0);
check('a Press/Release key holds its combo down while the finger is on it', (await keysDown()).includes(F24));
await release(0);
check('lifting the finger releases it', (await keysDown()).length === 0);

// The page changing under the finger.
await press(0);
check('held again, before the page changes', (await keysDown()).includes(F24));
await session.goToPage('two');
check('a page change under a held key releases it, rather than dropping the release', (await keysDown()).length === 0);
await release(0); // the finger comes up on the new page: nothing left to do
check('the late release presses nothing', (await keysDown()).length === 0);

// Going back, the profile switching, the config reloading, the deck closing.
await session.goToPage('one');
await press(0);
await session.goBack();
check('going back releases a held key too', (await keysDown()).length === 0);
await release(0);

await session.goToPage('one');
await press(0);
await session.setLayout(CONFIG.profiles.other.layouts[SERIAL]);
check('a profile switch releases a held key', (await keysDown()).length === 0);
await release(0);

await session.setLayout(CONFIG.profiles.home.layouts[SERIAL]);
await press(0);
await session.reconfigure({}, CONFIG.profiles.other.layouts[SERIAL], {}, false);
check('a config reload that moves the deck releases a held key', (await keysDown()).length === 0);
await release(0);

await session.reconfigure({}, CONFIG.profiles.home.layouts[SERIAL], {}, false);
await press(0);
await session.close();
check('the deck closing — unplugged, or the daemon stopping — releases a held key', (await keysDown()).length === 0);

// --- Latching toggles --------------------------------------------------------

console.log('\nlatching toggles');

const SHIFT = 42;
const CTRL = 29;
const TOGGLE_CONFIG = {
  profiles: {
    home: {
      name: 'Home',
      layouts: {
        [SERIAL]: {
          startPage: 'one',
          pages: {
            one: {
              name: 'One',
              buttons: {
                0: { action: { type: 'toggle', keys: 'shift' } },
                1: { action: { type: 'page', to: 'two' } },
                2: { action: { type: 'toggle', keys: 'shift+ctrl' } },
                3: { action: { type: 'toggle', keys: 'ctrl' } },
                4: { action: { type: 'toggle' } },
                // Isolate the two halves of the face. Key 5 sets its own icons,
                // so only describe() can change it; key 6 sets neither icon and
                // the same background both ways, so only the built-in default
                // pair (iconState) can.
                5: { action: { type: 'toggle', keys: 'f13', iconOn: 'builtin:toggle', iconOff: 'builtin:toggle-off' } },
                6: { action: { type: 'toggle', keys: 'f14', onBackground: '#101014', offBackground: '#101014' } },
              },
            },
            two: { name: 'Two', buttons: { 0: { action: { type: 'page', back: true } } } },
          },
        },
      },
    },
    other: {
      name: 'Other',
      layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } } },
    },
  },
};

const fake2 = new FakeDeck();
await daemon.attach(SERIAL, fake2);
const toggles = daemon.sessions.get(SERIAL);
await toggles.reconfigure({}, TOGGLE_CONFIG.profiles.home.layouts[SERIAL], {}, false);
const press2 = async (index) => {
  fake2.press(index);
  await settle();
  fake2.release(index); // the finger comes up; a latch ignores it
  await settle();
};

await press2(0);
check('one press latches the combo down, and the physical release does not lift it', (await keysDown()).includes(SHIFT));
check('the session reports it latched, for the face and the socket', toggles.isLatched(0) && toggles.latchedKeys().includes(0));
await press2(0);
check('a second press releases it', (await keysDown()).length === 0 && !toggles.isLatched(0));

// Overlapping combos: refused rather than allowed to steal the release.
await press2(0);
await press2(2); // shift+ctrl overlaps the latched shift
check('a second key latching an overlapping combo is refused', !toggles.isLatched(2));
check('the refused press badges the key, and the first latch is untouched', daemon.failures.forDeck(SERIAL).some((f) => f.key === 2) && toggles.isLatched(0) && (await keysDown()).includes(SHIFT));
await press2(3); // ctrl overlaps nothing held
check('a key latching a combo that overlaps nothing is allowed', toggles.isLatched(3) && (await keysDown()).includes(CTRL));
await press2(3);
await press2(0);
check('both released again', (await keysDown()).length === 0 && toggles.latchedKeys().length === 0);

// A toggle with no keys fails the press rather than latching nothing.
await press2(4);
check('a toggle with no "keys" fails and latches nothing', !toggles.isLatched(4) && daemon.failures.forDeck(SERIAL).some((f) => f.key === 4));

// The face: the built-in default pair, and the key really redrawn.
check('the default icon is the toggle pair, by state', defaultIconFor({ type: 'toggle' }, { latched: true }) === 'toggle' && defaultIconFor({ type: 'toggle' }, { latched: false }) === 'toggle-off');
const faceOff = fake2.images.get(0);
await press2(0);
const faceOn = fake2.images.get(0);
check('latching redraws the key with a different face', Buffer.isBuffer(faceOff) && Buffer.isBuffer(faceOn) && !faceOff.equals(faceOn));
await press2(0);
check('releasing draws it back the way it was', fake2.images.get(0).equals(faceOff));

// Each half of the face on its own, so one working cannot hide the other.
const describeOff = fake2.images.get(5);
await press2(5);
check("describe() reads the latch: a key with its own icons changes face", Buffer.isBuffer(describeOff) && !fake2.images.get(5).equals(describeOff));
await press2(5);
const defaultOff = fake2.images.get(6);
await press2(6);
check('the built-in default pair reads the latch: a key with no icons and one background still changes face', Buffer.isBuffer(defaultOff) && !fake2.images.get(6).equals(defaultOff));
await press2(6);
check('both released', (await keysDown()).length === 0);

// Every way off the page.
await press2(0);
await toggles.goToPage('two');
check('leaving the page releases a latched key', (await keysDown()).length === 0 && toggles.latchedKeys().length === 0);

await toggles.goToPage('one');
await press2(0);
await toggles.setLayout(TOGGLE_CONFIG.profiles.other.layouts[SERIAL]);
check('a profile switch releases a latched key', (await keysDown()).length === 0 && toggles.latchedKeys().length === 0);

await toggles.setLayout(TOGGLE_CONFIG.profiles.home.layouts[SERIAL]);
await press2(0);
await toggles.setPreview(0, { label: 'unsaved' });
check('a preview over a latched key releases it, since a previewed key cannot be pressed', (await keysDown()).length === 0 && !toggles.isLatched(0));
await toggles.clearPreview(0);

// A config reload: the same toggle keeps its latch, a changed key loses it.
await press2(0);
await press2(3);
await toggles.reconfigure({}, TOGGLE_CONFIG.profiles.home.layouts[SERIAL], {}, true);
check('a reload that leaves the key alone keeps the latch', toggles.isLatched(0) && (await keysDown()).includes(SHIFT));
const edited = structuredClone(TOGGLE_CONFIG.profiles.home.layouts[SERIAL]);
edited.pages.one.buttons['3'] = { action: { type: 'toggle', keys: 'alt' } }; // retargeted
await toggles.reconfigure({}, edited, {}, true);
check('a key edited under a latch releases it', !toggles.isLatched(3) && !(await keysDown()).includes(CTRL));
check('and the untouched key is still latched', toggles.isLatched(0) && (await keysDown()).includes(SHIFT));
const cleared = structuredClone(edited);
delete cleared.pages.one.buttons['0'];
await toggles.reconfigure({}, cleared, {}, true);
check('a key cleared under a latch releases it', !toggles.isLatched(0) && (await keysDown()).length === 0);

// The status the editor's grid reads.
await toggles.reconfigure({}, TOGGLE_CONFIG.profiles.home.layouts[SERIAL], {}, true);
await press2(0);
// The same snapshot the socket's status and state events carry.
const snapshot = commands.stateSnapshot(daemon.deps);
const deckStatus = snapshot.decks.find((d) => d.serial === SERIAL);
check('the socket status reports the latched key', Array.isArray(deckStatus?.latched) && deckStatus.latched.includes(0));

// The helper dying takes the keyboard with it: the latch must not survive it.
input.stop();
await sleep(200);
check('the virtual keyboard going away drops the latch, rather than drawing a key as held', toggles.latchedKeys().length === 0);

await daemon.stop();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nall checks passed' : `\n${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
