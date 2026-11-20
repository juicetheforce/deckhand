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
// No logind here: the lock state is unknown, as it must be for a test that
// reads nothing of this machine (smoke-virtual-touch.mjs has a fake one).
process.env.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${path.join(TMP, 'no-bus')}`;
// Turning a virtual deck off writes to the state directory: a scratch one, never this machine's.
process.env.DECKHAND_STATE_DIR = path.join(TMP, 'state');

const { createVirtualDriver } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
const { listScreens } = await import(path.join(REPO, 'dist/screens.js'));
const { sleep: sleepCoordinator } = await import(path.join(REPO, 'dist/sleep.js'));
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
const shaped = (extra) => base({ size: { width: 100, height: 100 }, controls: [{ id: 'a', x: 0, y: 0, w: 10, h: 10, ...extra }] });
check('rectangle, round, hexagon and the old square are accepted', ['square', 'rectangle', 'round', 'hexagon'].every((shape) => !refused(shaped({ shape }))));
check('any other shape is refused', refused(shaped({ shape: 'triangle' })) && refused(shaped({ shape: 7 })));
check('a corner radius must be a number, 0 or more', !refused(shaped({ shape: 'rectangle', radius: 4 })) && refused(shaped({ radius: -1 })) && refused(shaped({ radius: '4' })));
check('keepRatio must be true or false', !refused(shaped({ keepRatio: true })) && refused(shaped({ keepRatio: 'yes' })));
check('a canvas of 0 is refused', refused(base({ size: { width: 0, height: 100 }, controls: [] })));
check('virtual.output must name a connector', refused(base(grid('k', 1, 1, 100), { virtual: { output: 'DP 4; rm' } })) && refused(base(grid('k', 1, 1, 100), { virtual: {} })));

console.log('geometry from a panel');
const scrambled = { size: { width: 1920, height: 720 }, controls: [...grid('k', 2, 3, 240).controls].reverse() };
const g = geometryOfPanel(scrambled, 'Panel');
check('controls in reading order, whatever the config order', g.keys.map((k) => k.id).join() === 'k1,k2,k3,k4,k5,k6', g.keys.map((k) => k.id).join());
check('rows and columns are the distinct tops and lefts', g.rows === 2 && g.columns === 3 && g.keys[4].row === 1 && g.keys[4].column === 1);
check('each key has a screen of its own size, in pixels of the canvas', g.units === 'pixels' && g.keys.every((k) => k.width === 216 && k.height === 216) && g.canvas.width === 1920);
check('no panel: no keys', geometryOfPanel(undefined, 'Panel').keyCount === 0);

console.log('sizes: Small, Medium, Large, Custom');
const { gridFor, makePanel, plausibleSize } = await import(path.join(REPO, 'dist/panel-presets.js'));
const PANEL = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const XENEON = { width: 2560, height: 720, widthMm: 364, heightMm: 113 };
const counts = (screen) => ['small', 'medium', 'large'].map((size) => { const g = gridFor(screen, size); return `${g.rows}x${g.columns}`; }).join(' ');
check('the 10.3" panel: 4 × 10, 3 × 8, 2 × 5 (scope §7\'s table)', counts(PANEL) === '4x10 3x8 2x5', counts(PANEL));
check('the Xeneon Edge: 5 × 17, 4 × 14, 3 × 10', counts(XENEON) === '5x17 4x14 3x10', counts(XENEON));
check('a size reported wrong is not trusted: the ILITEK\'s 528 × 300 mm on a 1920 × 720 screen', !plausibleSize({ width: 1920, height: 720, widthMm: 528, heightMm: 300 }) && plausibleSize(PANEL));
check('…and then pixel pitches (180, 240, 360 px): the panel\'s own counts', counts({ width: 1920, height: 720, widthMm: 528, heightMm: 300 }) === '4x10 3x8 2x5' && counts({ width: 1920, height: 720 }) === '4x10 3x8 2x5');
check('portrait: the same rule along the short side, the EDID turned to match', counts({ width: 720, height: 1920, widthMm: 243, heightMm: 91 }) === '4x10 3x8 2x5');
const custom = gridFor(PANEL, 'custom', { rows: 5 });
check('Custom: the rows chosen, columns worked out so keys stay square', custom.rows === 5 && custom.columns === 13 && custom.pitch === 144, JSON.stringify(custom));
const customBoth = gridFor(PANEL, 'custom', { rows: 2, columns: 12 });
check('Custom with columns too: keys as large as fit both ways, still square', customBoth.rows === 2 && customBoth.columns === 12 && customBoth.pitch === 160, JSON.stringify(customBoth));
check('Custom is capped: at most 12 rows and 24 columns', (() => { const g = gridFor(PANEL, 'custom', { rows: 40, columns: 99 }); return g.rows === 12 && g.columns === 24; })());
check('very small keys are flagged, never refused', gridFor(PANEL, 'custom', { rows: 8 }).verySmall === true && gridFor(PANEL, 'small').verySmall === false && makePanel(PANEL, 'custom', { rows: 8 }).controls.length > 0);
const medium = makePanel(PANEL, 'medium');
check('a panel: k1… in reading order, a 12% gap, centred, every key on the canvas', medium.controls.length === 24 && medium.controls[0].id === 'k1' && medium.controls[8].y > medium.controls[7].y && medium.controls[0].w === 211 && medium.controls.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 1920 && c.y + c.h <= 720), JSON.stringify(medium.controls.slice(0, 2)));
check('…which the config accepts', !refused(base({ ...medium })) && ['small', 'large'].every((size) => !refused(base(makePanel(XENEON, size)))));

console.log('display events');
{
  const { screenChangeFilter } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
  let wanted = true;
  await fs.mkdir(path.join(DRM, 'card1-DP-9'), { recursive: true });
  await fs.writeFile(path.join(DRM, 'card1-DP-9', 'status'), 'connected\n');
  const changed = screenChangeFilter(() => wanted, DRM);
  check('a display event with no screen changed: no rescan, however many', [changed(), changed(), changed()].every((c) => c === false));
  await fs.writeFile(path.join(DRM, 'card1-DP-9', 'status'), 'disconnected\n');
  check('a screen going: a rescan, once', changed() === true && changed() === false);
  await fs.writeFile(path.join(DRM, 'card1-DP-9', 'status'), 'connected\n');
  wanted = false;
  check('with no virtual deck configured, display events are ignored', changed() === false);
  await fs.rm(path.join(DRM, 'card1-DP-9'), { recursive: true });
}

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
  decks: { 'output-DP-4': { name: 'Panel', virtual: { output: 'DP-4' } }, XL: {} },
  profiles: {
    one: { layouts: { 'output-DP-4': { panel: grid('k', 2, 3, 240), pages: { main: { buttons: { k1: { label: 'one' }, k5: { label: 'five' } } } } } } },
    two: { layouts: { 'output-DP-4': { panel: grid('t', 1, 2, 360), pages: { main: { buttons: { t2: { label: 'two' } } } } } } },
  },
});
const asked = [];
const driver = createVirtualDriver(() => config);
driver.watch((why) => asked.push(why));
check('no such connector: not listed', (await driver.list()).length === 0 && listScreens(DRM).length === 0);
await plug('DP-4', 'disconnected');
check('connector disconnected: not listed', (await driver.list()).length === 0);
await plug('DP-4', 'connected');
let found = await driver.list();
check('connected: listed by its screen\'s key — with no EDID, its connector — without opening it', found.length === 1 && found[0].id === 'output-DP-4', JSON.stringify(found.map((f) => f.id)));

let session;
let device;
await settle('opening', async () => {
  device = await found[0].open();
  check('opening starts the helper on that output', device !== null && (await frames()).some((f) => f.type === 'start' && f.output === 'DP-4'));
  session = new DeckSession(device, {
    serial: 'output-DP-4',
    hardware: config.decks['output-DP-4'],
    layout: config.profiles.one.layouts['output-DP-4'],
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'one',
  });
  await session.start();
  check('the session has the panel\'s six keys', session.keyCount === 6 && session.hasKey('k6') && !session.hasKey('0'));
  check('…drawn at full brightness, with no level sent: defaults.brightness is for a backlight', session.currentBrightness() === 100 && !(await frames()).some((f) => f.type === 'B'));
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
  config.decks['output-DP-5'] = { virtual: { output: 'DP-5' } };
  await plug('DP-5', 'connected');
  process.env.FAKE_PANEL_ACK_MS = '300';
  const slow = await (await driver.list()).find((f) => f.id === 'output-DP-5').open();
  delete process.env.FAKE_PANEL_ACK_MS;
  slow.showGeometry(geometryOfPanel(grid('s', 1, 1, 100), 'Slow'));
  const before = (await frames()).filter((f) => f.type === 'I').length;
  for (let shade = 1; shade <= 5; shade++) await slow.draw('s1', Buffer.alloc(76 * 76 * 4, shade));
  await sleep(900);
  const sent = (await frames()).filter((f) => f.type === 'I').slice(before);
  check(`five draws of one key while the helper is busy: two sent, the first and the newest (${sent.map((f) => f.first[0]).join()})`, sent.length === 2 && sent[0].first[0] === 1 && sent[1].first[0] === 5);
  await slow.close();
  delete config.decks['output-DP-5'];
  await plug('DP-5', 'disconnected');
});

console.log('brightness: drawn darker by the helper');
await settle('brightness', async () => {
  const newFrames = async (before) => (await frames()).slice(before);
  let before = (await frames()).length;
  await session.setBrightness(40);
  check('the level, then the canvas, then every key again', await until(async () => (await newFrames(before)).filter((f) => f.type === 'I').length >= 6));
  const sent = await newFrames(before);
  check('…in that order, at the level', sent[0]?.type === 'B' && sent[0].percent === 40 && sent[1]?.type === 'K', JSON.stringify(sent.slice(0, 2)));
  before = (await frames()).length;
  await session.setBrightness(40);
  await sleep(100);
  check('the same level again sends nothing', (await newFrames(before)).length === 0);
  before = (await frames()).length;
  sleepCoordinator.toggleAll({ mode: 'off' });
  check('Sleep all decks off: level 0', await until(async () => (await newFrames(before)).some((f) => f.type === 'B' && f.percent === 0)));
  before = (await frames()).length;
  sleepCoordinator.toggleAll({ mode: 'off' });
  check('…and back at its own level, its keys drawn again', await until(async () => {
    const f = await newFrames(before);
    return f.some((x) => x.type === 'B' && x.percent === 40) && f.filter((x) => x.type === 'I').length >= 6;
  }));
  before = (await frames()).length;
  await session.setBrightness(100);
  await until(async () => (await newFrames(before)).filter((f) => f.type === 'I').length >= 6);
  await sleep(300);
});

console.log('a profile with another panel');
await settle('relayout', async () => {
  const before = (await frames()).length;
  await session.setLayout(config.profiles.two.layouts['output-DP-4']);
  await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I').length >= 2);
  const after = (await frames()).slice(before);
  check('the deck takes the other panel\'s two keys', session.keyCount === 2 && session.hasKey('t2') && !session.hasKey('k1'));
  check('a new canvas, then its keys at their places', after[0]?.type === 'K' && after.filter((f) => f.type === 'I').every((f) => f.w === 336) && after.some((f) => f.type === 'I' && f.x === 372), JSON.stringify(after.slice(0, 4)));
  check('the socket\'s geometry is the new one', session.geometry.keys.map((k) => k.id).join() === 't1,t2');
});

console.log('overlapping controls (custom layouts)');
await settle('overlap', async () => {
  // Driven directly, as "newest wins" is: a 20 × 20 square under a round control at 10,10.
  config.decks['output-DP-5'] = { virtual: { output: 'DP-5' } };
  await plug('DP-5', 'connected');
  const dev = await (await driver.list()).find((f) => f.id === 'output-DP-5').open();
  dev.showGeometry(geometryOfPanel({ size: { width: 100, height: 100 }, controls: [{ id: 'low', x: 0, y: 0, w: 20, h: 20 }, { id: 'top', x: 10, y: 10, w: 20, h: 20, shape: 'round' }] }, 'Overlap'));
  const red = Buffer.alloc(20 * 20 * 4);
  for (let i = 0; i < 400; i++) red.set([255, 0, 0, 255], i * 4);
  // The round control's face as renderFace draws it: blue on the circle, clear outside.
  const blue = Buffer.alloc(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if ((x - 9.5) ** 2 + (y - 9.5) ** 2 <= 100) blue.set([0, 0, 255, 255], (y * 20 + x) * 4);
  const before = (await frames()).filter((f) => f.type === 'I').length;
  await dev.draw('low', red);
  await dev.draw('top', blue);
  await dev.draw('low', red);
  await until(async () => (await frames()).filter((f) => f.type === 'I').length >= before + 3);
  const [lowFirst, topImage, lowAgain] = (await frames()).filter((f) => f.type === 'I').slice(before);
  const pixel = (frame, x, y) => [...Buffer.from(frame.rgba, 'base64').subarray((y * frame.w + x) * 4, (y * frame.w + x) * 4 + 4)].join();
  check('a control alone in its box is sent as its own face', pixel(lowFirst, 15, 15) === '255,0,0,255' && lowFirst.w === 20);
  check('the round control on top: its box carries the square under its clear corner', topImage.x === 10 && pixel(topImage, 0, 0) === '255,0,0,255' && pixel(topImage, 9, 9) === '0,0,255,255', JSON.stringify([pixel(topImage, 0, 0), pixel(topImage, 9, 9)]));
  check('…and is clear where neither control is (no gap filled)', pixel(topImage, 19, 19) === '0,0,0,0', pixel(topImage, 19, 19));
  check('the square redrawn under it: the round one stays on top in its image', pixel(lowAgain, 0, 0) === '255,0,0,255' && pixel(lowAgain, 19, 19) === '0,0,255,255', pixel(lowAgain, 19, 19));
  // Draws piling up behind one in flight: low red, top, then low green. The queue holds low (green)
  // before top, so top goes last — and must carry green where the square shows through, never the
  // red it would have carried had it been combined when queued (a stale face nothing redraws).
  const green = Buffer.alloc(20 * 20 * 4);
  for (let i = 0; i < 400; i++) green.set([0, 255, 0, 255], i * 4);
  const queued = (await frames()).filter((f) => f.type === 'I').length;
  await dev.draw('top', blue);
  await dev.draw('low', red);
  await dev.draw('top', blue);
  await dev.draw('low', green);
  await until(async () => (await frames()).filter((f) => f.type === 'I').length >= queued + 3);
  await sleep(100);
  const lastTop = (await frames()).filter((f) => f.type === 'I' && f.x === 10).at(-1);
  check('queued behind a frame in flight, the control on top is combined when sent: the latest face under it, not the one when queued', pixel(lastTop, 0, 0) === '0,255,0,255', pixel(lastTop, 0, 0));
  // No layout with no controls ever reaches the screen (Ryan, 2026-11-18): one written by hand falls back as a page with no panel does.
  const empty = dev.layoutFrom({ pages: { e: { panel: { size: { width: 1920, height: 720 }, controls: [], preset: 'free' }, buttons: {} } } }, 'e');
  check('a page whose panel has no controls is shown with a grid, never with none', empty.keyCount > 0, String(empty.keyCount));
  await dev.close();
  delete config.decks['output-DP-5'];
  await plug('DP-5', 'disconnected');
});

console.log('a page with its own panel (every page has its own layout)');
await settle('page layouts', async () => {
  const pages = {
    startPage: 'main',
    pages: {
      main: { name: 'Main', panel: grid('k', 2, 3, 240), buttons: { k1: { label: 'one' } } },
      wide: { name: 'Wide', panel: grid('w', 1, 2, 360), buttons: { w2: { label: 'two' } } },
      twin: { name: 'Twin', panel: grid('w', 1, 2, 360), buttons: { w1: { label: 'twin' } } },
    },
  };
  const since = async (before) => (await frames()).slice(before);
  const laidOut = (await frames()).length;
  await session.setLayout(pages);
  check('the start page\'s own panel', session.keyCount === 6 && session.hasKey('k1') && session.currentPage() === 'main', String(session.keyCount));
  // Every key of the start page drawn before the page change is measured: setLayout returns before
  // the images reach the helper, and k1's, with its label, came after it often (31 runs in 40).
  await until(async () => (await since(laidOut)).filter((f) => f.type === 'I').length >= 6);
  let before = (await frames()).length;
  await session.goToPage('wide');
  await until(async () => (await since(before)).filter((f) => f.type === 'I').length >= 2);
  let sent = await since(before);
  check('a page with another panel: a new canvas, then its two keys at their places', session.keyCount === 2 && session.hasKey('w2') && !session.hasKey('k1') && sent[0]?.type === 'K' && sent.filter((f) => f.type === 'I').length === 2, JSON.stringify(sent.map((f) => f.type)));
  check('…and the socket\'s geometry is that page\'s', session.geometry.keys.map((k) => k.id).join() === 'w1,w2');
  before = (await frames()).length;
  await session.goToPage('twin');
  await until(async () => (await since(before)).filter((f) => f.type === 'I').length >= 1);
  await sleep(200);
  sent = await since(before);
  check('a page with the same panel: no canvas — the screen is not cleared — only its changed keys', !sent.some((f) => f.type === 'K') && sent.filter((f) => f.type === 'I').length <= 2, JSON.stringify(sent.map((f) => f.type)));
  before = (await frames()).length;
  await session.goBack();
  await sleep(200);
  sent = await since(before);
  check('back to the page before, the same panel: still no canvas', session.currentPage() === 'wide' && !sent.some((f) => f.type === 'K'), JSON.stringify(sent.map((f) => f.type)));
  before = (await frames()).length;
  await session.goToPage('main');
  await until(async () => (await since(before)).filter((f) => f.type === 'I').length >= 6);
  sent = await since(before);
  check('back to the six-key page: a canvas, then its six keys', session.keyCount === 6 && sent[0]?.type === 'K' && sent.filter((f) => f.type === 'I').length === 6, JSON.stringify(sent.map((f) => f.type)));
  // An edited config that changes only the page shown's panel re-lays it out where it is.
  const edited = structuredClone(pages);
  edited.pages.main.panel = grid('e', 1, 3, 300);
  before = (await frames()).length;
  await session.reconfigure(config.decks['output-DP-4'], edited, {}, true);
  await until(async () => (await since(before)).filter((f) => f.type === 'I').length >= 3);
  sent = await since(before);
  check('a reload changing the shown page\'s panel: same page, its new keys, a new canvas', session.currentPage() === 'main' && session.keyCount === 3 && session.hasKey('e3') && sent.some((f) => f.type === 'K'), JSON.stringify(sent.map((f) => f.type)));
  // A reload that drops the shown page goes to the start page, laid out as that page.
  const dropped = { startPage: 'wide', pages: { wide: structuredClone(pages.pages.wide) } };
  await session.reconfigure(config.decks['output-DP-4'], dropped, {}, true);
  check('a reload dropping the page shown: the start page, with its own panel', session.currentPage() === 'wide' && session.keyCount === 2 && session.hasKey('w2'), `${session.currentPage()} ${session.keyCount}`);
  await sleep(300);
});

console.log('a profile with no panel of its own (made after the deck was added)');
await settle('default panel', async () => {
  // Found on both machines, 2026-10-17: a profile created later had no panel
  // for the deck, and the deck attached with "0 keys, no screens".
  const bare = { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } };
  config.decks['output-DP-4'].virtual.panel = grid('d', 2, 4, 300);
  await session.setLayout(bare);
  check('the deck\'s default panel: its eight keys', session.keyCount === 8 && session.hasKey('d8'), String(session.keyCount));
  delete config.decks['output-DP-4'].virtual.panel;
  await session.setLayout(structuredClone(bare));
  check('no default (a config from before defaults): the first profile\'s panel', session.keyCount === 6 && session.hasKey('k6'), String(session.keyCount));
  const saved = config.profiles;
  config = { ...config, profiles: { lone: { layouts: { 'output-DP-4': bare } } } };
  await session.setLayout(structuredClone(bare));
  check('no panel anywhere: a Medium grid for the screen — never zero keys', session.keyCount > 0 && session.geometry.canvas?.width === 1920, String(session.keyCount));
  config = { ...config, profiles: saved };
  const before = (await frames()).length;
  await session.setLayout(config.profiles.one.layouts['output-DP-4']);
  // Its six keys drawn before the next section counts frames.
  await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I').length >= 6);
  await sleep(200);
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
await settle('output lost and back', async () => {
  const start = (await frames()).find((f) => f.type === 'start' && f.output === 'DP-4');
  process.kill(start.pid, 'SIGUSR2');
  await sleep(300);
  check('the output going, the screen still plugged in (a wake): no scan asked, the deck stays', asked.length === 0 && (await driver.list()).length === 1);
  const before = (await frames()).length;
  process.kill(start.pid, 'SIGHUP');
  check('…and when it is back, the canvas again and every key drawn again', await until(async () => {
    const after = (await frames()).slice(before);
    return after[0]?.type === 'K' && after.filter((f) => f.type === 'I').length >= 2;
  }));
});
await settle('screen unplugged', async () => {
  await plug('DP-4', 'disconnected');
  check('a scan finds the screen gone', (await driver.list()).length === 0);
  const before = (await frames()).length;
  await session.close();
  check('…the session closing quits the helper, which is not a failure: no scan asked', (await frames()).slice(before).some((f) => f.type === 'Q') && asked.length === 0);
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

console.log('a helper that stops unasked, its screen still connected');
await settle('stopped', async () => {
  config = validateConfig({ decks: { 'output-HDMI-A-2': { virtual: { output: 'HDMI-A-2' } } }, profiles: { p: { layouts: { 'output-HDMI-A-2': { panel: grid('k', 1, 1, 200), pages: { main: { buttons: {} } } } } } } });
  await plug('HDMI-A-2', 'connected');
  const [d] = await driver.list();
  const dev = await d.open();
  const askedBefore = asked.length;
  const start = (await frames()).findLast((f) => f.type === 'start' && f.output === 'HDMI-A-2');
  process.kill(start.pid, 'SIGKILL');
  check('a scan is asked', await until(async () => asked.length === askedBefore + 1));
  check('…which leaves the deck out, so its session closes rather than keep a helper that is gone', (await driver.list()).length === 0);
  check('…and not straight back either, so a broken helper cannot loop', (await driver.list()).length === 0);
  void dev;
});

console.log('closing');
await settle('quit', async () => {
  config = validateConfig({ decks: { 'output-HDMI-A-1': { virtual: { output: 'HDMI-A-1' } } }, profiles: { p: { layouts: { 'output-HDMI-A-1': { panel: grid('k', 1, 1, 200), pages: { main: { buttons: {} } } } } } } });
  await plug('HDMI-A-1', 'connected');
  const [d] = await driver.list();
  const dev = await d.open();
  const before = (await frames()).length;
  const askedBefore = asked.length;
  await dev.close();
  check('closing sends quit and the helper exits', (await frames()).slice(before).some((f) => f.type === 'Q'));
  await sleep(200);
  check('a close the daemon asked for is not a failure: no scan asked', asked.length === askedBefore);
});

console.log('Virtual deck on/off: its own icon for each state');
{
  const power = await import(path.join(REPO, 'dist/services/virtual-power.js'));
  const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));
  const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));
  power.setKnownDecks(() => new Set(['GRA-6e4e']));
  const key = { type: 'virtual.power', deck: 'GRA-6e4e', iconActive: '~/off.png' };
  const face = async (a) => (await registry['virtual.power'].describe({}, a))?.icon;
  check('on — its default state — nothing of its own: its Default icon, or the built-in', (await face(key)) === undefined);
  power.setPower('GRA-6e4e', false);
  await power.saved();
  check('off — its active state — its active icon', (await face(key)) === '~/off.png');
  check('off with no active icon: the built-in faded deck', (await face({ type: 'virtual.power', deck: 'GRA-6e4e' })) === undefined && defaultIconFor(key, registry['virtual.power'].iconState(key)) === 'virtual-deck-off');
  check('drawn on events only, never on the clock', registry['virtual.power'].redraw === 'events');
  check('the off state written to the scratch state directory', JSON.parse(await fs.readFile(path.join(TMP, 'state', 'virtual-off.json'), 'utf8')).off[0] === 'GRA-6e4e');
}

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\nvirtual: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
