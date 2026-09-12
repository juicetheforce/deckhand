/**
 * Offline smoke test — exercises rendering, page navigation and action
 * dispatch against a fake device. No Stream Deck, no /dev/uinput needed.
 *
 *   npm run build && npm run smoke
 *
 * Useful when you change the render pipeline and don't want to unplug
 * anything to find out you broke it.
 */
import { DeckSession } from '../dist/deck.js';

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

const config = {
  name: 'Test XL',
  brightness: 55,
  startPage: 'main',
  pages: {
    main: {
      buttons: {
        0: { label: 'Hello', background: '#203040' },
        1: { label: 'Games', action: { type: 'page', to: 'games' } },
        2: { label: 'Clock', action: { type: 'clock' } },
        3: { label: 'Multi\nline', labelPosition: 'center' },
      },
    },
    games: {
      buttons: {
        0: { label: 'Back', action: { type: 'page', back: true } },
        1: { label: 'Push', action: { type: 'hotkey', keys: 'ctrl+alt+3' } },
      },
    },
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

const fake = new FakeDeck();
const session = new DeckSession(fake, 'FAKE0001', config, {});

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

console.log('failing action does not crash');
await session.goToPage('games');
fake.press(1);
fake.release(1);
await sleep(600);
check('session still alive after hotkey attempt', session.currentPage() === 'games');

await session.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
