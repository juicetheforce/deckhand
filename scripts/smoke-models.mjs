/**
 * Offline test: **every model the Stream Deck library knows**, driven by
 * Deckhand's DeckSession, with the library's own deck object for that model
 * on a fake HID device — so the library's own checks judge every image
 * Deckhand sends: the right size for that key's screen, and only to a key
 * that has one. Nothing here lists a model: whatever the installed library
 * knows is tested, and a model a library update adds is tested too.
 *
 * The cases this was written for: a Stream Deck Studio's keys
 * are 144×112, and every write was refused for being drawn square; a Neo's
 * two touch keys have no screen and were written to on every repaint; a
 * Pedal has no screen at all and every render failed. **None of the three
 * has been seen on hardware** — this checks Deckhand against the library,
 * not against a device.
 *
 *   npm run build:ts && node scripts/smoke-models.mjs
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { DEVICE_MODELS2 } = await import(path.join(REPO, 'node_modules/@elgato-stream-deck/core/dist/index.js'));
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { hidDevice } = await import(path.join(REPO, 'dist/drivers/hid.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

/** A HID device that answers everything and sends nowhere. */
class FakeHid extends EventEmitter {
  constructor(productId, vendorId) {
    super();
    this.info = { path: '/fake/hid', productId, vendorId };
  }
  async close() {}
  async sendFeatureReport() {}
  async getFeatureReport(_id, length) {
    return new Uint8Array(length);
  }
  async sendReports() {}
  async getDeviceInfo() {
    return this.info;
  }
  async getChildDeviceInfo() {
    return null;
  }
}

const options = { encodeJPEG: async () => new Uint8Array(16) };
const tested = [];

for (const [model, spec] of Object.entries(DEVICE_MODELS2)) {
  let deck;
  try {
    deck = await spec.factory(new FakeHid(spec.productIds[0], spec.vendorId), options);
  } catch (err) {
    console.log(`  --   ${model}: the library cannot make one on a fake device (${err.message}); not tested`);
    continue;
  }
  const buttons = deck.CONTROLS.filter((c) => c.type === 'button');
  if (buttons.length === 0) continue; // a dock or other device with no keys: nothing for a deck session to drive
  tested.push(model);
  const screens = buttons.filter((c) => c.feedbackType === 'lcd');

  // Every key gets a label and a built-in icon, so every key with a screen draws something.
  const layout = { startPage: 'main', pages: { main: { name: 'Main', buttons: Object.fromEntries(buttons.map((c) => [String(c.index), { label: `K${c.index}`, icon: 'builtin:play' }])) } } };
  const written = [];
  const refused = [];
  const realFill = deck.fillKeyBuffer.bind(deck);
  deck.fillKeyBuffer = async (index, buffer, opts) => {
    written.push(index);
    try {
      await realFill(index, buffer, opts);
    } catch (err) {
      refused.push(`${index}: ${err.message}`);
      throw err;
    }
  };
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const session = new DeckSession(hidDevice(deck, `FAKE-${model}`), {
    serial: `FAKE-${model}`,
    hardware: {},
    layout,
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'default',
  });
  try {
    await session.start();
    await session.close();
  } finally {
    console.error = realError;
  }

  const name = `${model} (${buttons.length} keys, ${screens.length} with a screen${screens[0] ? `, ${screens[0].pixelSize.width}×${screens[0].pixelSize.height}` : ''})`;
  check(`${name}: the library accepts every image`, refused.length === 0, refused.slice(0, 2).join('; '));
  check(`${name}: every key with a screen is drawn once, and no other`, written.length === screens.length && screens.every((c) => written.includes(c.index)), `wrote ${JSON.stringify(written)}`);
  check(`${name}: nothing logged as failed`, logged.length === 0, logged.slice(0, 2).join('; '));
}

check('the models this was written for are among those tested: studio, neo, pedal', ['studio', 'neo', 'pedal'].every((m) => tested.includes(m)), `tested: ${tested.join(', ')}`);

console.log(failures === 0 ? `\nmodels: all checks passed (${tested.length} models)` : `\nmodels: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
