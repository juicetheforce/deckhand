// A key whose press failed on the deck is badged in the editor's grid too, end
// to end in real Electron.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus, against the control-socket test harness with a fake deck. Keys are
// pressed on the fake deck; the daemon marks the key and sends a state event;
// what is checked is the grid in the editor's page. The failing action is a
// real one — go to a page that does not exist — because the editor validates
// the config with its own copy of the daemon's code and would refuse a
// test-only action type.
//
// Usage: npm run check:failures   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_FAILURES_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-failures-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const XL = 'FAILURES-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                // Fails until a page named "Later" exists; then the same key, unedited, succeeds.
                0: { label: 'to later', action: { type: 'page', to: 'Later' } },
                3: { label: 'to nowhere', action: { type: 'page', to: 'nowhere' } },
                5: { label: 'shows only' },
              },
            },
          },
        },
      },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
const fake = new FakeDeck();
await daemon.attach(XL, fake);
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

/** Which keys the grid badges, with each badge's tooltip. */
const badges = (editor) =>
  inPage(
    editor,
    'editor',
    "Object.fromEntries([...document.querySelectorAll('.grid .key')].map((k, i) => [i, k.querySelector('.key-failed')?.getAttribute('title') ?? null]).filter(([, t]) => t !== null))",
  );
const at = (index) => ({ profile: 'default', serial: XL, page: 'main', index });

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
try {
  if (!(await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000))) throw new Error('the editor never reported ready');
  if (!(await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null && document.querySelectorAll('.grid .key').length === 32")) === true, 20_000)))
    throw new Error('the grid never appeared, connected');
  r.none = await badges(editor);

  // Two failing presses: the grid follows the deck's state event.
  fake.press(0);
  fake.press(3);
  r.twoFailed = await until(async () => Object.keys(await badges(editor)).length === 2);
  r.afterPresses = await badges(editor);
  // Measured inside the key's border: the padding box is the key's screen,
  // where its icon is drawn, as the deck's badge is placed on its image. (No
  // // comments inside the page script: inPage sends it as one line.)
  r.placement = await inPage(
    editor,
    'editor',
    `(() => {
      const screen = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, right: r.left + el.clientLeft + el.clientWidth };
      };
      const keys = document.querySelectorAll('.grid .key');
      const key = screen(keys[0]);
      const badge = keys[0].querySelector('.key-failed').getBoundingClientRect();
      const markKey = screen(keys[5]);
      const mark = keys[5].querySelector('.key-mark')?.getBoundingClientRect();
      return {
        widthShare: badge.width / key.width,
        rightGap: (key.right - badge.right) / key.width,
        topGap: (badge.top - key.top) / key.width,
        markLeftGap: mark ? mark.left - markKey.left : null,
        markInLeftHalf: mark ? mark.right < markKey.left + markKey.width * 0.75 : null,
        hasSvg: keys[0].querySelector('.key-failed svg circle') !== null,
      };
    })()`,
  );

  // Editing key 3 clears its mark; key 0, not edited, keeps its own.
  editor.send(`edit ${JSON.stringify({ kind: 'setLabel', at: at(3), label: 'to nowhere, edited' })}`);
  r.editClears = await until(async () => {
    const b = await badges(editor);
    return b[3] === undefined && b[0] !== undefined;
  }, 8000);

  // Add a page named "Later": key 0, unchanged, now works. Its press moves the
  // deck to that page, so the editor follows; back on Main, key 0 is clean.
  editor.send(`edit ${JSON.stringify({ kind: 'addPage', profile: 'default', serial: XL, name: 'Later' })}`);
  const laterSaved = () => Object.values(daemon.state.config.profiles.default.layouts[XL].pages).some((p) => p.name === 'Later');
  if (!(await until(laterSaved, 8000))) throw new Error('the page "Later" never reached the daemon');
  await sleep(500);
  r.stillMarkedAfterUnrelatedEdit = daemon.failures.forDeck(XL).some((f) => f.key === 0);
  fake.press(0);
  r.successClears = await until(() => !daemon.failures.forDeck(XL).some((f) => f.key === 0), 5000);
  await daemon.sessions.get(XL).goToPage('main');
  r.cleanOnMain = await until(async () => Object.keys(await badges(editor)).length === 0, 5000);
} catch (err) {
  r.stoppedAt = err.message;
  console.log(`the run stopped early: ${err.message}`);
}
editor.child.kill();

check('the run reached the end', () => assert.equal(r.stoppedAt, undefined));
check('no key is badged before anything fails', () => assert.deepEqual(r.none, {}));
check('a failed press on the deck badges that key in the grid, with the error as its tooltip', () => {
  assert.equal(r.twoFailed, true);
  assert.match(r.afterPresses[0], /^Its last press failed: .*Later/);
  assert.match(r.afterPresses[3], /nowhere/);
  assert.deepEqual(Object.keys(r.afterPresses).sort(), ['0', '3']);
});
check('the badge is where and as big as the deck draws it: 30% of the key, top right, inset 4%', () => {
  assert.equal(r.placement.hasSvg, true);
  assert.ok(Math.abs(r.placement.widthShare - 0.3) < 0.02, `width ${r.placement.widthShare}`);
  assert.ok(Math.abs(r.placement.rightGap - 0.04) < 0.02, `right ${r.placement.rightGap}`);
  assert.ok(Math.abs(r.placement.topGap - 0.04) < 0.02, `top ${r.placement.topGap}`);
});
check('the "no action" mark is top left now, clear of the badge', () => {
  assert.ok(r.placement.markLeftGap !== null && r.placement.markLeftGap < 8, `left gap ${r.placement.markLeftGap}`);
  assert.equal(r.placement.markInLeftHalf, true);
});
check('editing a failed key clears its badge; a key not edited keeps its own', () => assert.equal(r.editClears, true));
check('an edit elsewhere in the config leaves the mark', () => assert.equal(r.stillMarkedAfterUnrelatedEdit, true));
check('a press of the same key that now succeeds clears it, in the daemon and in the grid', () => {
  assert.equal(r.successClears, true);
  assert.equal(r.cleanOnMain, true);
});

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
