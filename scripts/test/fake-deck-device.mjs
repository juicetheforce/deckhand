/**
 * A fake Stream Deck for a child process running the real `dist/index.js`.
 *
 * `listStreamDecks()` reads the JSON file named by `FAKE_DECKS_FILE`, so a
 * test can plug a deck in and out while the daemon runs by rewriting that
 * file. `openStreamDeck()` returns a deck-shaped object and **appends a line
 * to `FAKE_DECKS_LOG` for every open and every close**, which is how
 * scripts/smoke-unattached.mjs proves a scan does not reopen a deck it already
 * knows.
 *
 * Key presses: when `FAKE_DECKS_PRESS` names a file, every write of
 * `{ "id": …, "serial": …, "index": …, "holdMs": … }` to it presses that key
 * on that deck and releases it holdMs later — watched, not polled, and a file
 * rather than a signal: SIGUSR2 is the forced scan, and SIGUSR1 would start
 * Node's inspector.
 *
 * The surface is the one scripts/test/control-harness.mjs's FakeDeck provides,
 * plus `getSerialNumber()`, because `src/index.ts` attach() reads the serial
 * from the opened device rather than from the enumeration entry.
 *
 * Substituted for '@elgato-stream-deck/node' by
 * scripts/test/fake-decks-hooks.mjs, in the child only.
 */
import { appendFileSync, readFileSync, watch } from 'node:fs';

const LOG = process.env.FAKE_DECKS_LOG;
/** Open fake decks by serial, for FAKE_DECKS_PRESS. */
const open = new Map();

const PRESS = process.env.FAKE_DECKS_PRESS;
if (PRESS) {
  let last = null;
  watch(PRESS, () => {
    let press;
    try {
      press = JSON.parse(readFileSync(PRESS, 'utf8'));
    } catch {
      return; // a write still in progress; its last event comes
    }
    if (press.id === last) return;
    last = press.id;
    const deck = open.get(press.serial);
    deck?.handlers.down?.({ type: 'button', index: press.index });
    setTimeout(() => deck?.handlers.up?.({ type: 'button', index: press.index }), press.holdMs ?? 30);
  }).unref();
}

function record(event, detail) {
  if (LOG) appendFileSync(LOG, `${event} ${detail}\n`);
}

/**
 * The plugged-in decks right now: `[{ model, path, serialNumber, columns?,
 * rows?, pixels?, productName? }]`. Read on every call, never cached, so
 * rewriting the file is an unplug or a plug-in.
 */
function devices() {
  const file = process.env.FAKE_DECKS_FILE;
  if (!file) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

export async function listStreamDecks() {
  return devices().map((d) => ({ model: d.model ?? 'xl', path: d.path, serialNumber: d.serialNumber }));
}

export async function openStreamDeck(devicePath) {
  const spec = devices().find((d) => d.path === devicePath);
  if (!spec) throw new Error(`no fake deck at ${devicePath}`);
  record('open', spec.serialNumber);
  const deck = new FakeStreamDeck(spec);
  open.set(spec.serialNumber, deck);
  return deck;
}

class FakeStreamDeck {
  constructor({ serialNumber, model = 'xl', productName = 'Fake XL', columns = 8, rows = 4, pixels = 96 }) {
    this.serialNumber = serialNumber;
    this.MODEL = model;
    this.PRODUCT_NAME = productName;
    this.CONTROLS = Array.from({ length: columns * rows }, (_, i) => ({
      type: 'button',
      index: i,
      hidIndex: i,
      row: Math.floor(i / columns),
      column: i % columns,
      feedbackType: 'lcd',
      pixelSize: { width: pixels, height: pixels },
    }));
    this.handlers = {};
  }
  async getSerialNumber() {
    return this.serialNumber;
  }
  on(event, callback) {
    this.handlers[event] = callback;
  }
  async fillKeyBuffer() {}
  async clearPanel() {}
  async setBrightness() {}
  async close() {
    if (open.get(this.serialNumber) === this) open.delete(this.serialNumber);
    record('close', this.serialNumber);
  }
}
