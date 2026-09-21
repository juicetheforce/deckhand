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
 * The surface is the one scripts/test/control-harness.mjs's FakeDeck provides,
 * plus `getSerialNumber()`, because `src/index.ts` attach() reads the serial
 * from the opened device rather than from the enumeration entry.
 *
 * Substituted for '@elgato-stream-deck/node' by
 * scripts/test/fake-decks-hooks.mjs, in the child only.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const LOG = process.env.FAKE_DECKS_LOG;

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
  return new FakeStreamDeck(spec);
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
    record('close', this.serialNumber);
  }
}
