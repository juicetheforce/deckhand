/**
 * Offline test for virtual decks, the daemon's half (src/drivers/virtual.ts,
 * src/drivers/panel-frames.ts, geometryOfPanel, the panel's config rules,
 * and DeckSession taking its controls from the layout):
 *
 * - a screen is listed only while its connector is connected (a scratch
 *   /sys/class/drm), and only if the config names it a virtual deck;
 * - opening one starts the helper (scripts/test/fake-panel.mjs) on that
 *   output; the session sends the canvas, then one image per key, at the
 *   key's place and size;
 * - a key drawn again before its first image went sends only the newest;
 * - a profile whose panel differs gives the deck those controls;
 * - a resize redraws everything; the screen going closes nothing by itself
 *   but asks for a scan, and a failed helper is not restarted at once;
 * - closing quits the helper.
 *
 *   npm run build:ts && node scripts/smoke-virtual.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-virtual-'));
const DRM = path.join(TMP, 'drm');
const LOG = path.join(TMP, 'panel.log');
process.env.DECKHAND_DRM_DIR = DRM;
process.env.DECKHAND_PANEL_BIN = path.join(REPO, 'scripts/test/fake-panel.mjs');
process.env.FAKE_PANEL_LOG = LOG;

const { createVirtualDriver, outputConnected } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
const { canvasFrame, imageFrame } = await import(path.join(REPO, 'dist/drivers/panel-frames.js'));
const { geometryOfPanel } = await import(path.join(REPO, 'dist/geometry.js'));
const { validateConfig } = await import(path.join(REPO, 'dist/config.js'));
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    check(`${name} (threw)`, false, err.stack ?? String(err));
  }
};
const frames = async () => (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

async function plug(connector, status) {
  await fs.mkdir(path.join(DRM, `card1-${connector}`), { recursive: true });
  await fs.writeFile(path.join(DRM, `card1-${connector}`, 'status'), `${status}\n`);
}

/** A 2 × 3 grid of 240 px keys on a 1920 × 720 canvas, as a preset would make it. */
function grid(prefix, rows, columns, pitch, size = { width: 1920, height: 720 }) {
  const controls = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) controls.push({ id: `${prefix}${r * columns + c + 1}`, x: c * pitch + 12, y: r * pitch + 12, w: pitch - 24, h: pitch - 24 });
  return { size, controls, preset: 'test' };
}

console.log('the panel config');
const base = (panel, deck = { virtual: { output: 'DP-4' } }) => ({ decks: { PANEL: deck }, profiles: { p: { layouts: { PANEL: { panel, pages: { main: { buttons: {} } } } } } } });
const refused = (candidate) => {
  try {
    validateConfig(candidate);
    return false;
  } catch {
    return true;
  }
};
check('a panel of controls on its canvas validates', !refused(base(grid('k', 2, 3, 240))));
check('two controls with one id are refused', refused(base({ size: { width: 100, height: 100 }, controls: [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'a', x: 20, y: 0, w: 10, h: 10 }] })));
check('a control off the canvas is refused', refused(base({ size: { width: 100, height: 100 }, controls: [{ id: 'a', x: 95, y: 0, w: 10, h: 10 }] })));
check('a control id with ":" is refused', refused(base({ size: { width: 100, height: 100 }, controls: [{ id: 'a:b', x: 0, y: 0, w: 10, h: 10 }] })));
check('a shape other than square is refused, for now', refused(base({ size: { width: 100, height: 100 }, controls: [{ id: 'a', x: 0, y: 0, w: 10, h: 10, shape: 'round' }] })));
check('a canvas of 0 is refused', refused(base({ size: { width: 0, height: 100 }, controls: [] })));
check('virtual.output must name a connector', refused(base(grid('k', 1, 1, 100), { virtual: { output: 'DP 4; rm' } })) && refused(base(grid('k', 1, 1, 100), { virtual: {} })));

console.log('geometry from a panel');
const scrambled = { size: { width: 1920, height: 720 }, controls: [...grid('k', 2, 3, 240).controls].reverse() };
const g = geometryOfPanel(scrambled, 'Panel');
check('controls in reading order, whatever the config order', g.keys.map((k) => k.id).join() === 'k1,k2,k3,k4,k5,k6', g.keys.map((k) => k.id).join());
check('rows and columns are the distinct tops and lefts', g.rows === 2 && g.columns === 3 && g.keys[4].row === 1 && g.keys[4].column === 1);
check('each key has a screen of its own size, in pixels of the canvas', g.units === 'pixels' && g.keys.every((k) => k.width === 216 && k.height === 216) && g.canvas.width === 1920);
check('no panel: no keys', geometryOfPanel(undefined, 'Panel').keyCount === 0);

console.log('frames');
const k = canvasFrame(1920, 720, [1, 2, 3]);
check('canvas: length 12, type K, size, background', k.readUInt32LE(0) === 12 && k[4] === 75 && k.readUInt32LE(5) === 1920 && k.readUInt32LE(9) === 720 && k[13] === 1 && k[15] === 3);
const img = imageFrame(10, 20, 2, 1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
check('image: length, type I, place, size, pixels', img.readUInt32LE(0) === 1 + 16 + 8 && img[4] === 73 && img.readInt32LE(5) === 10 && img.readInt32LE(9) === 20 && img.readUInt32LE(13) === 2 && img[21] === 1);
let threw = false;
try {
  imageFrame(0, 0, 2, 2, Buffer.alloc(4));
} catch {
  threw = true;
}
check('an image whose pixels do not match its size is refused', threw);

console.log('listing');
let config = validateConfig({
  decks: { PANEL: { name: 'Panel', virtual: { output: 'DP-4' } }, XL: {} },
  profiles: {
    one: { layouts: { PANEL: { panel: grid('k', 2, 3, 240), pages: { main: { buttons: { k1: { label: 'one' }, k5: { label: 'five' } } } } } } },
    two: { layouts: { PANEL: { panel: grid('t', 1, 2, 360), pages: { main: { buttons: { t2: { label: 'two' } } } } } } },
  },
});
const asked = [];
const driver = createVirtualDriver(() => config);
driver.watch((why) => asked.push(why));
check('no such connector: not listed', (await driver.list()).length === 0 && !outputConnected('DP-4', DRM));
await plug('DP-4', 'disconnected');
check('connector disconnected: not listed', (await driver.list()).length === 0);
await plug('DP-4', 'connected');
let found = await driver.list();
check('connected: listed by its id, without opening it', found.length === 1 && found[0].id === 'PANEL', JSON.stringify(found.map((f) => f.id)));

let session;
let device;
await settle('opening', async () => {
  device = await found[0].open();
  check('opening starts the helper on that output', device !== null && (await frames()).some((f) => f.type === 'start' && f.output === 'DP-4'));
  session = new DeckSession(device, {
    serial: 'PANEL',
    hardware: config.decks.PANEL,
    layout: config.profiles.one.layouts.PANEL,
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'one',
  });
  await session.start();
  check('the session has the panel\'s six keys', session.keyCount === 6 && session.hasKey('k6') && !session.hasKey('0'));
  check('…and no brightness to set, without failing', session.currentBrightness() > 0);
  await until(async () => (await frames()).filter((f) => f.type === 'I').length >= 6);
  const all = await frames();
  const firstCanvas = all.findIndex((f) => f.type === 'K');
  const images = all.filter((f) => f.type === 'I');
  check('the canvas first, at the panel\'s size', firstCanvas >= 0 && all[firstCanvas].width === 1920 && all[firstCanvas].height === 720 && all.findIndex((f) => f.type === 'I') > firstCanvas);
  check('one image per key, at its place and size', images.length === 6 && images.some((f) => f.x === 252 && f.y === 252 && f.w === 216 && f.h === 216 && f.bytes === 216 * 216 * 4), JSON.stringify(images.map((f) => [f.x, f.y, f.w])));
});

console.log('drawing');
await settle('newest wins', async () => {
  // A helper slow to answer, and one key drawn five times while its first
  // image is still on its way: only the first and the newest are sent.
  config.decks.SLOW = { virtual: { output: 'DP-5' } };
  await plug('DP-5', 'connected');
  process.env.FAKE_PANEL_ACK_MS = '300';
  const slow = await (await driver.list()).find((f) => f.id === 'SLOW').open();
  delete process.env.FAKE_PANEL_ACK_MS;
  slow.showGeometry(geometryOfPanel(grid('s', 1, 1, 100), 'Slow'));
  const before = (await frames()).filter((f) => f.type === 'I').length;
  for (let shade = 1; shade <= 5; shade++) await slow.draw('s1', Buffer.alloc(76 * 76 * 4, shade));
  await sleep(900);
  const sent = (await frames()).filter((f) => f.type === 'I').slice(before);
  check(`five draws of one key while the helper is busy: two sent, the first and the newest (${sent.map((f) => f.first[0]).join()})`, sent.length === 2 && sent[0].first[0] === 1 && sent[1].first[0] === 5);
  await slow.close();
  delete config.decks.SLOW;
  await plug('DP-5', 'disconnected');
});

console.log('a profile with another panel');
await settle('relayout', async () => {
  const before = (await frames()).length;
  await session.setLayout(config.profiles.two.layouts.PANEL);
  await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I').length >= 2);
  const after = (await frames()).slice(before);
  check('the deck takes the other panel\'s two keys', session.keyCount === 2 && session.hasKey('t2') && !session.hasKey('k1'));
  check('a new canvas, then its keys at their places', after[0]?.type === 'K' && after.filter((f) => f.type === 'I').every((f) => f.w === 336) && after.some((f) => f.type === 'I' && f.x === 372), JSON.stringify(after.slice(0, 4)));
  check('the socket\'s geometry is the new one', session.geometry.keys.map((k) => k.id).join() === 't1,t2');
});

console.log('the helper\'s own events');
await settle('resize', async () => {
  const before = (await frames()).length;
  const start = (await frames()).find((f) => f.type === 'start');
  process.kill(start.pid, 'SIGUSR1');
  await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I').length >= 2);
  const after = (await frames()).slice(before);
  check('a resize: the canvas again, and every key drawn again', after[0]?.type === 'K' && after.filter((f) => f.type === 'I').length >= 2);
});
await settle('screen gone', async () => {
  const start = (await frames()).find((f) => f.type === 'start' && f.output === 'DP-4');
  process.kill(start.pid, 'SIGUSR2');
  check('the screen going asks the daemon to scan', await until(async () => asked.length === 1));
  await plug('DP-4', 'disconnected');
  check('…which finds it gone', (await driver.list()).length === 0);
  await session.close();
  await plug('DP-4', 'connected');
  check('plugged back in: listed again at once', (await driver.list()).length === 1);
});

console.log('a helper that fails');
await settle('failing', async () => {
  process.env.FAKE_PANEL_FAIL = 'no-output';
  const [again] = await driver.list();
  check('a helper that cannot show the panel opens nothing', (await again.open()) === null);
  delete process.env.FAKE_PANEL_FAIL;
  check('…and the deck is not listed again straight away, so it cannot respawn in a loop', (await driver.list()).length === 0);
});

console.log('closing');
await settle('quit', async () => {
  config = validateConfig({ decks: { PANEL2: { virtual: { output: 'HDMI-A-1' } } }, profiles: { p: { layouts: { PANEL2: { panel: grid('k', 1, 1, 200), pages: { main: { buttons: {} } } } } } } });
  await plug('HDMI-A-1', 'connected');
  const [d] = await driver.list();
  const dev = await d.open();
  const before = (await frames()).length;
  await dev.close();
  check('closing sends quit and the helper exits', (await frames()).slice(before).some((f) => f.type === 'Q'));
  check('a close the daemon asked for is not a failure: no scan asked', asked.length === 1);
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\nvirtual: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
