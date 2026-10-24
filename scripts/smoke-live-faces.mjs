/**
 * Offline test of the state the editor's grid draws a key with states in
 * (src/deck.ts's liveFaces, the control socket's status `live`):
 *
 * - every action with states says when it is in its active state (`active`),
 *   the one definition describe() draws by;
 * - the status reports each shown key with states — its built-in's state and
 *   whether its active icon applies — and no key with one face;
 * - **a key redrawn in another state tells the editor** (onStateChange), as
 *   Input mode switched in Discord itself must: before, the grid drew voice
 *   activity whatever the deck showed. Redrawn in the same state, it does not.
 *
 * A real DeckSession over a fake deck; Input mode's state is stubbed, as a
 * Discord event would change it. The 500 ms tick runs for real.
 *
 *   npm run build:ts && node scripts/smoke-live-faces.mjs
 */
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { hidDevice } = await import(path.join(REPO, 'dist/drivers/hid.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));
const { hasStates } = await import(path.join(REPO, 'dist/state-icons.js'));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withStates = Object.keys(registry).filter((type) => hasStates({ type }));
check(
  `every action with states says when it is active (${withStates.length})`,
  withStates.length >= 17 && withStates.every((t) => typeof registry[t].active === 'function'),
  withStates.filter((t) => typeof registry[t].active !== 'function').join(', '),
);
check(
  'and no action with one face does',
  Object.keys(registry).filter((t) => !withStates.includes(t)).every((t) => registry[t].active === undefined),
);

// Input mode, its state stubbed: what Discord's VOICE_SETTINGS_UPDATE would set.
let pushToTalk = false;
const mode = registry['discord.inputMode'];
mode.iconState = () => ({ active: !pushToTalk });
mode.active = () => pushToTalk;

const controls = Array.from({ length: 3 }, (_, i) => ({ type: 'button', index: i, row: 0, column: i, feedbackType: 'lcd', pixelSize: { width: 72, height: 72 } }));
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
        0: { action: { type: 'discord.inputMode' } },
        1: { action: { type: 'toggle', keys: 'shift' } },
        2: { action: { type: 'hotkey', keys: 'ctrl+c' } },
      },
    },
  },
};
let told = 0;
const session = new DeckSession(hidDevice(raw, 'FAKE'), {
  serial: 'FAKE',
  hardware: {},
  layout,
  defaults: {},
  switchProfile: async () => {},
  failures: new KeyFailures(),
  profileOf: () => 'default',
  onStateChange: () => told++,
});
await session.start();

const faces = session.liveFaces();
check(
  'the status names each shown key with states, in the state it is drawn in',
  JSON.stringify(faces['0']) === JSON.stringify({ state: { active: true }, active: false }) &&
    JSON.stringify(faces['1']) === JSON.stringify({ state: { latched: false }, active: false }),
  JSON.stringify(faces),
);
check('and not a key with one face', !('2' in faces), JSON.stringify(faces));

const before = told;
session.invalidateByType(['discord.inputMode']);
await sleep(700);
check('redrawn in the same state: the editor is not told', told === before, `${told - before} notices`);

pushToTalk = true;
session.invalidateByType(['discord.inputMode']);
await sleep(700);
check('switched to push-to-talk in Discord, and redrawn: the editor is told', told > before, `${told - before} notices`);
check('and the status says push-to-talk: its active state', JSON.stringify(session.liveFaces()['0']) === JSON.stringify({ state: { active: false }, active: true }), JSON.stringify(session.liveFaces()['0']));

await session.close();
console.log(failures === 0 ? '\nlive faces: all checks passed' : `\nlive faces: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
