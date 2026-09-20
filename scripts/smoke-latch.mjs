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

const { FakeDeck, startDaemon, check, failureCount, sleep } = await import('./test/control-harness.mjs');
const { input } = await import(path.join(REPO, 'dist/input.js'));

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
console.log('a held key is released, never discarded (M7)');

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

await daemon.stop();
input.stop();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nall checks passed' : `\n${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
