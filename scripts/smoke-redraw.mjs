/**
 * Offline test for when a key is redrawn (src/deck.ts's tick, and
 * ActionHandler.redraw):
 *
 * - **OBS, VTube Studio and Twitch keys are never redrawn on a clock**: their
 *   faces read a state cache only their service's events change, so they are
 *   drawn when shown, and again only when told (invalidateByType) — once;
 * - every OBS, VTS and Twitch action in the registry says so;
 * - a clock, whose face is the time, is still redrawn on its interval;
 *
 * Counts describe() calls on a real DeckSession over a fake deck; the 500 ms
 * render tick runs for real, so this takes a few seconds.
 *
 *   npm run build:ts && node scripts/smoke-redraw.mjs
 */
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { hidDevice } = await import(path.join(REPO, 'dist/drivers/hid.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const integrationTypes = Object.keys(registry).filter((t) => /^(obs|vts|twitch)\./.test(t));
check(
  `every OBS, VTube Studio and Twitch action is redrawn on events only (${integrationTypes.length})`,
  integrationTypes.length >= 13 && integrationTypes.every((t) => registry[t].redraw === 'events'),
  integrationTypes.filter((t) => registry[t].redraw !== 'events').join(', '),
);

// Count describe() calls per type.
const calls = {};
for (const type of ['obs.scene', 'vts.hotkey', 'twitch.marker', 'clock']) {
  const handler = registry[type];
  const describe = handler.describe.bind(handler);
  calls[type] = 0;
  handler.describe = async (...args) => {
    calls[type]++;
    return describe(...args);
  };
}

const controls = Array.from({ length: 4 }, (_, i) => ({ type: 'button', index: i, row: 0, column: i, feedbackType: 'lcd', pixelSize: { width: 72, height: 72 } }));
const raw = {
  MODEL: 'fake',
  PRODUCT_NAME: 'Fake',
  CONTROLS: controls,
  on() {},
  async fillKeyBuffer() {},
  async clearPanel() {},
  async setBrightness() {},
  async close() {},
};
const layout = {
  startPage: 'main',
  pages: {
    main: {
      name: 'Main',
      buttons: {
        0: { action: { type: 'obs.scene', scene: 'Live' } },
        1: { action: { type: 'vts.hotkey', hotkey: 'wave' } },
        2: { action: { type: 'twitch.marker' } },
        3: { action: { type: 'clock' } },
      },
    },
  },
};
const session = new DeckSession(hidDevice(raw, 'FAKE'), {
  serial: 'FAKE',
  hardware: {},
  layout,
  defaults: { refreshMs: 1000 },
  switchProfile: async () => {},
  failures: new KeyFailures(),
  profileOf: () => 'default',
});
await session.start();
check('shown: each key drawn once', calls['obs.scene'] === 1 && calls['vts.hotkey'] === 1 && calls['twitch.marker'] === 1, JSON.stringify(calls));

await sleep(3200);
check('3 s later, nothing told them anything: OBS, VTS and Twitch keys not drawn again', calls['obs.scene'] === 1 && calls['vts.hotkey'] === 1 && calls['twitch.marker'] === 1, JSON.stringify(calls));
check('while the clock was redrawn on its interval (at least twice more)', calls.clock >= 3, JSON.stringify(calls));

session.invalidateByType(['obs.scene']);
await sleep(700);
check('told OBS changed: the OBS key drawn once more, by the next tick', calls['obs.scene'] === 2, JSON.stringify(calls));
check('and only it', calls['vts.hotkey'] === 1 && calls['twitch.marker'] === 1, JSON.stringify(calls));
await sleep(1200);
check('once: not again after that', calls['obs.scene'] === 2, JSON.stringify(calls));

session.invalidateByType(['vts.hotkey', 'twitch.marker']);
await sleep(700);
check('told VTube Studio and Twitch changed: each drawn once more', calls['vts.hotkey'] === 2 && calls['twitch.marker'] === 2, JSON.stringify(calls));

await session.close();
console.log(failures === 0 ? '\nredraw: all checks passed' : `\nredraw: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
