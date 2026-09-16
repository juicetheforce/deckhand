// M4 phase B, B2: the page and profile inspectors, end to end in real Electron.
//
// What this is for: a key bound in the editor has to actually move the deck
// when it is pressed. Everything up to now proved the inspector writes
// plausible JSON; this presses the key on a fake deck through the daemon's own
// DeckSession and watches what happens.
//
// Usage: npm run check:navigate   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-navigate-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { loadConfig, watchConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist/config.js')).href);

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

const SERIAL = 'NAV-XL';
// "Second" starts with no way off it, so the guard has something to flag.
const CONFIG = {
  decks: { [SERIAL]: {} },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [SERIAL]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: {} },
            second: { name: 'Second', buttons: {} },
          },
        },
      },
    },
    other: { name: 'Other', layouts: { [SERIAL]: { startPage: 'hotbar', pages: { hotbar: { name: 'Hotbar', buttons: {} } } } } },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
const fake = new FakeDeck();
await daemon.attach(SERIAL, fake);

const stopWatching = watchConfig(async () => {
  try {
    const { config } = await loadConfig();
    daemon.state.config = config;
    daemon.state.lastReload = { ok: true, at: new Date().toISOString() };
    daemon.events.config();
    await daemon.profiles.applyReload(config, daemon.sessions);
  } catch (err) {
    daemon.state.lastReload = { ok: false, at: new Date().toISOString(), error: err.message };
    daemon.events.config();
  }
});

// When the renderer signals with a preview on key 31, press the key it bound —
// key 2, switch profile. This is the whole point: a key configured in the
// editor is pressed on the real deck path and the daemon dispatches it.
//
// It waits for the daemon to have *reloaded* the key as well as for the
// signal: the editor autosaves 400 ms after the last edit, so the press would
// otherwise land on a key the daemon has never read (which is exactly what
// happened on the first run).
let pressedProfileKey = false;
const presser = setInterval(() => {
  const session = daemon.sessions.get(SERIAL);
  const bound =
    daemon.state.config?.profiles?.default?.layouts?.[SERIAL]?.pages?.main?.buttons?.['2']?.action?.type === 'profile';
  if (!pressedProfileKey && bound && session?.previewKeys().includes(31)) {
    pressedProfileKey = true;
    fake.press(2);
  }
}, 25);

const output = await runElectronCheck('navigate', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 90_000);
clearInterval(presser);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('the guard flags the page with no way off it, and only that page', () => {
    // "Second" has no keys at all; "Main" is the start page but also has none,
    // so both are flagged before anything is bound.
    // The last entry is the "+" menu, which shares the .tab class.
    assert.deepEqual(r.tabsAtStart, ['Main⚠', 'Second⚠', '+'], 'before anything is bound');
  });

  check('the page inspector lists the pages in this layout, and writes the page ID', () => {
    assert.deepEqual(r.pageTargets, ['Main — this page', 'Second']);
    assert.equal(r.pageKeySaved, true, 'the action was not written as { type: page, to: second }');
  });

  check('binding a Go to page key clears the guard on the page it leaves', () => {
    assert.deepEqual(r.tabsAfterLinking, ['Main', 'Second⚠', '+'], 'Main now has a way off; Second still does not');
  });

  check('the profile inspector lists profiles with the decks each one changes', () => {
    // The harness's fake deck reports "Fake XL", and this config sets no name
    // for it, so that is what the coverage line should say.
    assert.deepEqual(r.profileTargets, [
      'Default — the one you are editingchanges Fake XL',
      'Otherchanges Fake XL',
    ]);
    assert.deepEqual(r.profileKeyAction, { type: 'profile', to: 'other' }, 'written by profile ID');
  });

  check('switching a page key to Back is one step, and replaces the target', () => {
    assert.equal(r.backSaved, true);
  });

  check('a key bound in the editor really switches the deck when it is pressed', () => {
    assert.equal(pressedProfileKey, true, 'the stand-in press never happened');
    assert.equal(r.deckFollowedTheProfileKey, true, 'the deck did not move to the Other profile');
  });
}

check('the deck ended on the profile the pressed key selected', () => {
  assert.equal(daemon.profiles.activeProfile(), 'other');
  assert.equal(daemon.sessions.get(SERIAL).currentPage(), 'hotbar');
});

const finalConfig = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
check('the saved config holds exactly the two keys the editor bound', () => {
  const buttons = finalConfig.profiles.default.layouts[SERIAL].pages.main.buttons;
  assert.deepEqual(Object.keys(buttons).sort(), ['1', '2']);
  assert.deepEqual(buttons['1'], { action: { type: 'page', back: true } });
  assert.deepEqual(buttons['2'], { action: { type: 'profile', to: 'other' } });
});

if (failures > 0) console.log(`\nrenderer report:\n${JSON.stringify(r, null, 2)}`);
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
