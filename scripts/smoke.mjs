/**
 * Offline smoke test — exercises rendering, page navigation, action
 * dispatch, config validation and profile switching against fake devices. No
 * Stream Deck, no /dev/uinput needed.
 *
 *   npm run build && npm run smoke
 *
 * Useful when you change the render pipeline and don't want to unplug
 * anything to find out you broke it.
 */
import { DeckSession } from '../dist/deck.js';
import { registry } from '../dist/actions/index.js';
import { startProfileOf, validateConfig } from '../dist/config.js';
import { Profiles } from '../dist/profiles.js';
import { KeyFailures } from '../dist/key-failures.js';

class FakeDeck {
  constructor() {
    this.PRODUCT_NAME = 'Fake XL';
    this.MODEL = 'xl';
    this.CONTROLS = Array.from({ length: 32 }, (_, i) => ({
      type: 'button',
      index: i,
      row: Math.floor(i / 8),
      column: i % 8,
      feedbackType: 'lcd',
      pixelSize: { width: 96, height: 96 },
    }));
    this.handlers = {};
    this.writes = 0;
    this.brightness = null;
  }
  on(event, cb) {
    this.handlers[event] = cb;
  }
  press(index) {
    this.handlers.down?.({ type: 'button', index });
  }
  release(index) {
    this.handlers.up?.({ type: 'button', index });
  }
  async fillKeyBuffer(index, buffer, options) {
    if (options.format !== 'rgba') throw new Error(`unexpected format ${options.format}`);
    const expected = 96 * 96 * 4;
    if (buffer.length !== expected) {
      throw new Error(`key ${index}: buffer is ${buffer.length}, expected ${expected}`);
    }
    this.writes++;
  }
  async clearPanel() {}
  async setBrightness(v) {
    this.brightness = v;
  }
  async close() {}
}

const layout = {
  startPage: 'main',
  pages: {
    main: {
      buttons: {
        0: { label: 'Hello', background: '#203040' },
        1: { label: 'Games', action: { type: 'page', to: 'games' } },
        2: { label: 'Clock', action: { type: 'clock' } },
        3: { label: 'Multi\nline', labelPosition: 'center' },
        4: { label: 'Combat', action: { type: 'page', to: 'Combat' } },
      },
    },
    games: {
      buttons: {
        0: { label: 'Back', action: { type: 'page', back: true } },
        1: { label: 'Push', action: { type: 'hotkey', keys: 'ctrl+alt+3' } },
      },
    },
    pg_7c1e: { name: 'Combat', buttons: {} },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    failures++;
  }
}

/** A session outside any Profiles, for tests that do not switch profile. */
function standaloneSession(fake, serial, sessionLayout, hardware = {}) {
  return new DeckSession(fake, {
    serial,
    hardware,
    layout: sessionLayout,
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'standalone',
  });
}

const press = async (fakeDeck, index) => {
  fakeDeck.press(index);
  fakeDeck.release(index);
  await sleep(300);
};

const fake = new FakeDeck();
const session = standaloneSession(fake, 'FAKE0001', layout, { name: 'Test XL', brightness: 55 });

console.log('geometry');
check('32 keys detected', session.keyCount === 32);
check('96px icons detected', session.iconSize === 96);

await session.start();
await sleep(400);

console.log('initial render');
check('every key written', fake.writes >= 32);
check('brightness applied', fake.brightness === 55);

console.log('page navigation');
fake.press(1);
fake.release(1);
await sleep(400);
check('moved to games page', session.currentPage() === 'games');

fake.press(0);
fake.release(0);
await sleep(400);
check('back returned to main', session.currentPage() === 'main');

await press(fake, 4);
check('page action resolves a name ("Combat") to its ID (pg_7c1e)', session.currentPage() === 'pg_7c1e');
await session.goBack();
await session.goToPage('nonexistent');
check('unknown page leaves the deck where it was', session.currentPage() === 'main');

console.log('failing action does not crash');
await session.goToPage('games');
fake.press(1);
fake.release(1);
await sleep(600);
check('session still alive after hotkey attempt', session.currentPage() === 'games');

await session.close();

console.log('brightness is per deck');
// Two decks with different configured brightness, each with a +10 key.
// A shared brightness value would make one deck's nudge start from the
// other deck's level, or from a hardcoded default.
const nudgeLayout = {
  startPage: 'main',
  pages: { main: { buttons: { 0: { action: { type: 'brightness', delta: 10 } } } } },
};
const fakeA = new FakeDeck();
const fakeB = new FakeDeck();
const sessionA = standaloneSession(fakeA, 'FAKEA', nudgeLayout, { brightness: 55 });
const sessionB = standaloneSession(fakeB, 'FAKEB', nudgeLayout, { brightness: 30 });
await sessionA.start();
await sessionB.start();

fakeB.press(0);
fakeB.release(0);
await sleep(200);
check('deck B nudges from its own configured level (30 -> 40)', fakeB.brightness === 40);
check('deck A untouched by deck B (55)', fakeA.brightness === 55);

fakeA.press(0);
fakeA.release(0);
await sleep(200);
check('deck A nudges from its own configured level (55 -> 65)', fakeA.brightness === 65);
check('deck B still at 40', fakeB.brightness === 40);

await sessionA.close();
await sessionB.close();

console.log('multi pauses after each step');
// scope §6: a step's delayMs is a pause after it runs, not before. Brightness
// steps are timestamped on the fake deck.
{
  const multiLayout = {
    startPage: 'main',
    pages: { main: { buttons: { 0: { action: { type: 'multi', steps: [{ type: 'brightness', value: 20, delayMs: 300 }, { type: 'brightness', value: 40 }] } } } } },
  };
  const fakeM = new FakeDeck();
  const sessionM = standaloneSession(fakeM, 'FAKEM', multiLayout, { brightness: 50 });
  await sessionM.start();
  const times = [];
  const setBrightness = fakeM.setBrightness.bind(fakeM);
  fakeM.setBrightness = async (v) => {
    times.push({ v, at: Date.now() });
    return setBrightness(v);
  };
  const pressedAt = Date.now();
  fakeM.press(0);
  fakeM.release(0);
  await sleep(700);
  const first = times.find((t) => t.v === 20);
  const second = times.find((t) => t.v === 40);
  check('the first step runs at once, not after its delay', first !== undefined && first.at - pressedAt < 150);
  check("the next step runs after the first step's delay", first !== undefined && second !== undefined && second.at - first.at >= 280);
  await sessionM.close();
}

console.log('tick does not overlap itself');
// A describe() slower than the 500 ms tick, like a hung pactl call. Without
// a guard, the next tick starts while the last is still awaiting it, and the
// same key is described twice at once.
let activeDescribes = 0;
let maxActiveDescribes = 0;
registry['test.slow'] = {
  async describe() {
    activeDescribes++;
    maxActiveDescribes = Math.max(maxActiveDescribes, activeDescribes);
    await sleep(1300);
    activeDescribes--;
    return { label: 'slow' };
  },
};
const fakeSlow = new FakeDeck();
const sessionSlow = standaloneSession(fakeSlow, 'FAKESLOW', {
  startPage: 'main',
  pages: { main: { buttons: { 0: { refreshMs: 100, action: { type: 'test.slow' } } } } },
});
await sessionSlow.start();
maxActiveDescribes = 0; // ignore the initial full-page render; watch ticks only
await sleep(3000);
check(`at most one describe() in flight (saw ${maxActiveDescribes})`, maxActiveDescribes <= 1);
await sessionSlow.close();
await sleep(1400); // let any in-flight describe finish before exit
delete registry['test.slow'];

console.log('config validation');
/** The error message validateConfig throws, or null if it accepts the config. */
function rejection(candidate) {
  try {
    validateConfig(candidate);
    return null;
  } catch (err) {
    return err.message;
  }
}
const onePage = { pages: { main: { buttons: {} } } };

check(
  'minimal config accepted (no "decks", no startProfile)',
  rejection({ profiles: { p: { layouts: { S: onePage } } } }) === null,
);
check(
  'v0.1 config refused, naming the migration script',
  rejection({ decks: { S: { startPage: 'main', pages: { main: { buttons: {} } } } } })?.includes(
    'migrate-config.mjs',
  ),
);
check(
  'two pages with the same name refused',
  rejection({
    profiles: { p: { layouts: { S: { pages: { a: { name: 'X', buttons: {} }, b: { name: 'X', buttons: {} } } } } } },
  })?.includes('both named "X"'),
);
check(
  "a page named after another page's ID refused",
  rejection({
    profiles: { p: { layouts: { S: { pages: { main: { buttons: {} }, b: { name: 'main', buttons: {} } } } } } },
  })?.includes("another page's ID"),
);
check(
  'two profiles with the same name refused',
  rejection({ profiles: { a: { name: 'X', layouts: {} }, b: { name: 'X', layouts: {} } } })?.includes(
    'both named "X"',
  ),
);
check(
  'startPage that matches nothing refused',
  rejection({ profiles: { p: { layouts: { S: { startPage: 'nope', pages: { main: { buttons: {} } } } } } } }) !==
    null,
);
check(
  'startPage by name accepted',
  rejection({
    profiles: { p: { layouts: { S: { startPage: 'Main', pages: { pg_1: { name: 'Main', buttons: {} } } } } } },
  }) === null,
);
check(
  'startProfile by name resolves to the ID',
  startProfileOf(
    validateConfig({ profiles: { a: { layouts: {} }, prof_9: { name: 'FFXIV', layouts: {} } }, startProfile: 'FFXIV' }),
  ) === 'prof_9',
);
check('non-numeric button key refused', rejection({ profiles: { p: { layouts: { S: { pages: { main: { buttons: { x: {} } } } } } } } }) !== null);

console.log('attach order');
// a covers X; b (startProfile) covers X, Y, Z; c covers Y, W.
const orderProfiles = new Profiles(
  validateConfig({
    profiles: {
      a: { layouts: { X: onePage } },
      b: { layouts: { X: onePage, Y: onePage, Z: onePage } },
      c: { layouts: { Y: onePage, W: onePage } },
    },
    startProfile: 'b',
  }),
);
await orderProfiles.switchTo('a', new Map());
check('1. the active profile, when it covers the deck', orderProfiles.chooseProfileFor('X') === 'a');
check('3. startProfile, when active does not cover and the deck was never shown', orderProfiles.chooseProfileFor('Y') === 'b');
check('4. the first profile covering the deck, when neither does', orderProfiles.chooseProfileFor('W') === 'c');
check('null when no profile covers the deck', orderProfiles.chooseProfileFor('Q') === null);
orderProfiles.markShown('Y', 'c');
check('2. the profile last shown beats startProfile', orderProfiles.chooseProfileFor('Y') === 'c');

console.log('profile switching');
// home covers both decks; game covers only the XL; streaming covers both.
const buttonsOn = (buttons) => ({ buttons });
const profileConfig = {
  profiles: {
    home: {
      name: 'Home',
      layouts: {
        XL: {
          startPage: 'main',
          pages: {
            main: buttonsOn({
              0: { action: { type: 'profile', to: 'Game' } },
              1: { action: { type: 'profile', to: 'nope' } },
            }),
            other: buttonsOn({}),
          },
        },
        V2: { pages: { launcher: buttonsOn({}), extra: buttonsOn({}) } },
      },
    },
    game: {
      name: 'Game',
      layouts: {
        XL: {
          startPage: 'Combat',
          // "other" has the same ID as a page in home's XL layout, so the
          // back-history check below can tell cleared history from history
          // that merely points at pages the new layout lacks.
          pages: { emotes: buttonsOn({}), combat: { name: 'Combat', buttons: {} }, other: buttonsOn({}) },
        },
      },
    },
    streaming: {
      layouts: { XL: { pages: { scenes: buttonsOn({}) } }, V2: { pages: { mixer: buttonsOn({}) } } },
    },
  },
  startProfile: 'Home',
};

const profiles = new Profiles(validateConfig(structuredClone(profileConfig)));
const sessions = new Map();
const fakes = { XL: new FakeDeck(), V2: new FakeDeck() };

/** Attach a fake deck the way index.ts attach() does. */
async function attachFake(serial) {
  const profileId = profiles.chooseProfileFor(serial);
  const deckSession = new DeckSession(fakes[serial], {
    serial,
    hardware: {},
    layout: profiles.layoutFor(profileId, serial),
    defaults: {},
    switchProfile: (ref) => profiles.switchTo(ref, sessions),
    failures: new KeyFailures(),
    profileOf: () => profiles.shownProfileFor(serial) ?? profileId,
  });
  await deckSession.start();
  sessions.set(serial, deckSession);
  profiles.markShown(serial, profileId);
  return deckSession;
}
const page = (serial) => sessions.get(serial)?.currentPage();

await attachFake('XL');
await attachFake('V2');
check('starts on startProfile given by name (Home -> home)', profiles.activeProfile() === 'home');
check('XL on its start page', page('XL') === 'main');
check('V2 on its first page (no startPage)', page('V2') === 'launcher');

await sessions.get('V2').goToPage('extra');
await press(fakes.XL, 0);
check('a profile key switched the active profile (to "Game" by name)', profiles.activeProfile() === 'game');
check("covered XL went to the new layout's start page (Combat -> combat)", page('XL') === 'combat');
check('uncovered V2 kept its layout and page', page('V2') === 'extra');

await sessions.get('XL').goToPage('other');
await sessions.get('XL').goToPage('emotes'); // history now ends with "other"
await profiles.switchTo('game', sessions);
check('switching to the active profile does nothing', page('XL') === 'emotes');

await profiles.switchTo('home', sessions);
check('switching back: XL to start page', page('XL') === 'main');
check('switching back: V2, covered again, to its start page', page('V2') === 'launcher');
await sessions.get('XL').goBack();
check('back history cleared by the switch', page('XL') === 'main');

await press(fakes.XL, 1);
check('unknown profile: action fails, nothing changes', profiles.activeProfile() === 'home' && page('XL') === 'main');

// Replug: V2 last showed streaming; the active profile (game) does not cover it.
await profiles.switchTo('streaming', sessions);
await profiles.switchTo('game', sessions);
check('V2 kept streaming while game is active', page('V2') === 'mixer');
await sessions.get('V2').close();
sessions.delete('V2');
await attachFake('V2');
check('replugged V2 comes back on the profile it last showed (streaming), not startProfile', page('V2') === 'mixer');

console.log('reload');
await profiles.switchTo('home', sessions);
await sessions.get('XL').goToPage('other');

let edited = structuredClone(profileConfig);
edited.profiles.home.layouts.XL.pages.other.buttons['5'] = { label: 'new' };
await profiles.applyReload(validateConfig(edited), sessions);
check('same profile, page still exists: XL stays on its page', page('XL') === 'other');

edited = structuredClone(edited);
delete edited.profiles.home.layouts.XL.pages.other;
await profiles.applyReload(validateConfig(edited), sessions);
check('same profile, page removed: XL to start page', page('XL') === 'main');

// Active profile deleted: falls back to startProfile.
await profiles.switchTo('streaming', sessions);
edited = structuredClone(edited);
delete edited.profiles.streaming;
await profiles.applyReload(validateConfig(edited), sessions);
check('active profile deleted: startProfile becomes active', profiles.activeProfile() === 'home');
check('...and decks move to its start pages', page('XL') === 'main' && page('V2') === 'launcher');

// Uncovered deck, then a reload adds a layout for it to the active profile.
await profiles.switchTo('game', sessions);
check('V2 uncovered under game, still on home', page('V2') === 'launcher');
edited = structuredClone(edited);
// The new layout also has a "launcher" page — the ID V2 is on — so this checks
// that moving to another profile goes to the start page even when the current
// page ID happens to exist there too.
edited.profiles.game.layouts.V2 = { startPage: 'gamepad', pages: { gamepad: buttonsOn({}), launcher: buttonsOn({}) } };
await profiles.applyReload(validateConfig(edited), sessions);
check("reload that covers V2 in the active profile moves V2 onto its start page", page('V2') === 'gamepad');

// A deck no profile covers any more is detached.
edited = structuredClone(edited);
for (const p of Object.values(edited.profiles)) delete p.layouts.V2;
await profiles.applyReload(validateConfig(edited), sessions);
check('deck with no layout in any profile is detached', !sessions.has('V2') && sessions.has('XL'));

for (const s of sessions.values()) await s.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
