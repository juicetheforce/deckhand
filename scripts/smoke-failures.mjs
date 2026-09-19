/**
 * Offline test of failed-key marking (Ship piece 6, docs/scope.md §7): a key
 * whose press failed wears a badge on the deck and is listed in the control
 * socket's status, until a press of it succeeds or it is edited.
 *
 *   npm run build:ts && node scripts/smoke-failures.mjs      (npm run smoke runs it too)
 *
 * Fake decks, a fake input helper, and test actions that fail on demand. The
 * badge is found by its pixels: a point on the red disc, clear of the X.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');

const { FakeDeck, startDaemon, connect, check, failureCount, sleep, scratchDir, validateConfig, KeyFailures } = await import('./test/control-harness.mjs');
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));

// Test actions: one that fails while `failing` is set, one that counts runs.
let failing = true;
let ran = 0;
registry['test.flaky'] = { async execute() { if (failing) throw new Error('the test says no'); } };
registry['test.count'] = { async execute() { ran++; } };

const CONFIG = {
  decks: { XL1: { name: 'XL' } },
  profiles: {
    home: {
      name: 'Home',
      layouts: {
        XL1: {
          pages: {
            main: {
              buttons: {
                0: { label: 'flaky', action: { type: 'test.flaky' } },
                1: { label: 'other', action: { type: 'test.count' } },
                2: { label: 'multi', action: { type: 'multi', steps: [{ type: 'test.flaky' }, { type: 'test.count' }] } },
                3: { label: 'to nowhere', action: { type: 'page', to: 'nowhere' } },
                4: { label: 'release', action: { type: 'test.count' }, onRelease: { type: 'test.flaky' } },
                5: { label: 'go p2', action: { type: 'page', to: 'p2' } },
              },
            },
            p2: { buttons: { 0: { label: 'back', action: { type: 'page', back: true } } } },
          },
        },
      },
    },
  },
};

const PIXELS = 96;
/** Whether the key's last image has the badge: a point on the red disc above its centre, off the X. */
function badged(fake, index) {
  const image = fake.images.get(index);
  if (!image) return false;
  const d = Math.round(PIXELS * 0.3);
  const inset = Math.round(PIXELS * 0.04);
  const x = Math.round(PIXELS - inset - d / 2);
  const y = Math.round(inset + d / 2 - d * 0.35);
  const at = (y * PIXELS + x) * 4;
  const [r, g, b] = [image[at], image[at + 1], image[at + 2]];
  return r > 200 && g < 110 && b < 110;
}
const failedKeys = async (client) => (await client.request('status')).result.decks.find((d) => d.serial === 'XL1').failed;
const settle = () => sleep(150);

const TMP = await scratchDir();
const daemon = await startDaemon(TMP, CONFIG);
const fake = new FakeDeck();
const session = await daemon.attach('XL1', fake);
await settle();
const client = await connect(daemon.socket);
await client.request('subscribe', { events: ['state'] });
const stateEvents = () => client.events.filter((e) => e.event === 'state').length;

console.log('a failed press marks the key');
{
  check('no key is marked at start', (await failedKeys(client)).length === 0 && !badged(fake, 0));
  const writesBefore = fake.writes.get(0) ?? 0;
  const eventsBefore = stateEvents();
  fake.press(0);
  await settle();
  const failed = await failedKeys(client);
  check('status lists it, with the page, profile and error', failed.length === 1 && failed[0].key === 0 && failed[0].page === 'main' && failed[0].profile === 'home' && failed[0].error === 'the test says no');
  check('the deck draws the badge', badged(fake, 0));
  check('one write, the repaint every press already had', (fake.writes.get(0) ?? 0) - writesBefore === 1);
  check('a state event tells the editor', stateEvents() > eventsBefore);
  check('other keys are not badged', !badged(fake, 1));

  const eventsAgain = stateEvents();
  fake.press(0);
  await settle();
  check('failing again with the same error sends no state event', stateEvents() === eventsAgain);
}

console.log('it survives a page switch, and clears on success');
{
  fake.press(5); // to p2
  await settle();
  check('on another page the key there is not badged', session.currentPage() === 'p2' && !badged(fake, 0));
  fake.press(0); // back
  await settle();
  check('back on the page, the badge is drawn again', session.currentPage() === 'main' && badged(fake, 0));

  failing = false;
  const eventsBefore = stateEvents();
  fake.press(0);
  await settle();
  check('a press that succeeds clears it', (await failedKeys(client)).length === 0 && !badged(fake, 0));
  check('and tells the editor', stateEvents() > eventsBefore);
  const eventsAfter = stateEvents();
  fake.press(0);
  await settle();
  check('another success sends nothing: nothing changed', stateEvents() === eventsAfter);
  failing = true;
}

console.log('the failures that used to be swallowed');
{
  ran = 0;
  fake.press(2);
  await settle();
  check('multi: a failed step marks the key', (await failedKeys(client)).some((f) => f.key === 2 && f.error.startsWith('step 1 failed')));
  check('multi: the steps after it still ran', ran === 1);

  fake.press(3);
  await settle();
  check('go to a page the deck does not have marks the key', (await failedKeys(client)).some((f) => f.key === 3 && f.error.includes('nowhere')));
  const viaSocket = await client.request('action.run', { serial: 'XL1', action: { type: 'page', to: 'nowhere' } });
  check('over the socket it still answers ok, as the editor expects', viaSocket.ok === true);

  fake.press(4);
  fake.release(4);
  await settle();
  check('a failed release marks the key', (await failedKeys(client)).some((f) => f.key === 4) && badged(fake, 4));

  const before = (await failedKeys(client)).length;
  await client.request('action.run', { serial: 'XL1', action: { type: 'test.flaky' } });
  check('an action run over the socket marks nothing', (await failedKeys(client)).length === before);
}

console.log('a preview is never badged');
{
  fake.press(0);
  await settle();
  await client.request('preview.set', { serial: 'XL1', key: 0, button: { label: 'preview' } });
  await settle();
  check('a failed key under a preview shows the preview, unbadged', !badged(fake, 0));
  await client.request('preview.clear', { serial: 'XL1', key: 0 });
  await settle();
  check('the badge is back when the preview ends', badged(fake, 0));
}

console.log('editing a key clears its mark');
{
  const edited = structuredClone(CONFIG);
  edited.profiles.home.layouts.XL1.pages.main.buttons[0].label = 'flaky, edited';
  const next = validateConfig(edited);
  const eventsBefore = stateEvents();
  daemon.failures.prune(next) && daemon.events.state();
  await daemon.profiles.applyReload(next, daemon.sessions);
  await settle();
  const failed = await failedKeys(client);
  check('the edited key is no longer marked, or badged', !failed.some((f) => f.key === 0) && !badged(fake, 0));
  check('keys not edited keep theirs', failed.some((f) => f.key === 2) && failed.some((f) => f.key === 4));
  check('the editor is told', stateEvents() > eventsBefore);
}

console.log('unplugged and plugged back in');
{
  const kept = new KeyFailures();
  kept.mark('XL1', { profile: 'home', page: 'main', key: 1, error: 'earlier' }, CONFIG.profiles.home.layouts.XL1.pages.main.buttons[1]);
  const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
  const replug = new FakeDeck();
  const second = new DeckSession(replug, {
    serial: 'XL1',
    hardware: {},
    layout: validateConfig(structuredClone(CONFIG)).profiles.home.layouts.XL1,
    defaults: {},
    switchProfile: async () => {},
    failures: kept,
    profileOf: () => 'home',
  });
  await second.start();
  check('a new session on the same store draws the mark from the start', badged(replug, 1) && !badged(replug, 0));
  await second.close();
}

client.close();
await daemon.stop();
const failed = failureCount();
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
