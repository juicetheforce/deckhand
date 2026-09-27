// Several decks shown at once, end to end in real Electron against two fake
// decks, an XL (8×4) and an Original V2 (5×3): SHOW IN EDITOR, a panel per
// deck stacked in the Device list's order, click-to-focus, each deck's own
// page, and nothing done on one deck reaching the other (scope §10,
// "Multi-deck editing"); and the canvas — Fit all and zoom, work at 50%, a
// deck dragged and snapped, an overlap butted, positions remembered across a
// hide and a reopen. The one-deck case is check:one-deck's.
//
// Usage: npm run check:multi-deck   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-multi-deck-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

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

// The same serials as the renderer half (src/renderer/checks.ts, multiDeck).
const XL = 'MULTI-XL';
const V2 = 'MULTI-V2';
const JUMP = { label: 'Jump', action: { type: 'hotkey', keys: 'ctrl+1' } };
const SPRINT = { label: 'Sprint', action: { type: 'hotkey', keys: 'ctrl+2' } };
const EXTRA = { label: 'Extra key', action: { type: 'hotkey', keys: 'f9' } };
const TO_EXTRA = { label: 'To extra', action: { type: 'page', to: 'extra' } };
const TO_MAIN = { label: 'To main', action: { type: 'page', to: 'main' } };
const CONFIG = {
  decks: { [XL]: { name: 'Big deck' }, [V2]: { name: 'Little deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: JUMP, 1: SPRINT, 2: { label: 'Stay', action: { type: 'profile', to: 'default' } } } } } },
        [V2]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: { 4: TO_EXTRA } },
            extra: { name: 'Extra', buttons: { 0: EXTRA, 4: TO_MAIN } },
          },
        },
      },
    },
    // No V2 layout: a shown V2 keeps its panel, with the "Add a layout" card.
    solo: { name: 'Solo', layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'Back', action: { type: 'profile', to: 'default' } } } } } } } },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Fake V2' }));
const stopWatching = await reloadLikeTheDaemon(daemon);

const stateDir = path.join(scratch, 'state');
const output = await runElectronCheck('multi-deck', { configDir, stateDir, socket: daemon.socket }, 90_000);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, `${r.error}\nprogress: ${JSON.stringify(r, null, 2)}`);
});

if (r && !r.error) {
  check('opt-in: with two decks connected the editor opens showing one, as before — no panels', () => {
    assert.equal(r.opens.grids, 1);
    assert.deepEqual(r.opens.panels, []);
    assert.equal(r.opens.edited, XL);
    assert.equal(r.opens.trigger, 'Big deck');
  });
  check('with two decks connected the Device crumb is SHOW IN EDITOR, not the dropdown', () => assert.equal(r.opens.deviceIsSelect, false));
  check('SHOW IN EDITOR lists both connected decks, columns × rows, and the last shown one cannot be unticked', () => {
    assert.deepEqual(r.menu.rows, [
      { serial: XL, name: 'Big deck', size: '8 × 4', checked: true, disabled: true },
      { serial: V2, name: 'Little deck', size: '5 × 3', checked: false, disabled: false },
    ]);
    assert.equal(r.menu.footer, "Hidden decks keep working. They just aren't shown in the editor.");
  });
  check('ticking a deck adds it below, in the Device list\'s order; the focus stays; only the other deck has Page ▾', () => {
    assert.equal(r.ticked.grids, 2);
    assert.deepEqual(r.ticked.panels, [XL, V2]);
    assert.equal(r.ticked.focused, XL);
    assert.deepEqual(r.ticked.editing, [XL]);
    assert.deepEqual(r.ticked.pageMenus, [V2]);
    assert.equal(r.ticked.trigger, 'Big deck + Little deck');
    assert.deepEqual(r.ticked.tabs, ['Main'], 'the toolbar\'s tabs are the focused deck\'s');
    assert.deepEqual(r.ticked.sizes, ['8 × 4', '5 × 3']);
  });
  check('another deck\'s Page ▾ moves only that deck, on screen and on the deck', () =>
    assert.deepEqual(r.pageMenu, { deck: true, face: true, xlStayed: true }));
  check('a key on another deck focuses it, with only that key selected; the toolbar follows it', () => {
    assert.equal(r.clickFocus.focused, V2);
    assert.equal(r.clickFocus.edited, V2);
    assert.deepEqual(r.clickFocus.xlSelected, [], 'the XL\'s selection went with its focus');
    assert.deepEqual(r.clickFocus.v2Selected, [2]);
    assert.deepEqual(r.clickFocus.tabs, ['Main', 'Extra']);
    assert.equal(r.clickFocus.selectedTab, 'Extra', 'on the page the V2 was showing');
    assert.equal(r.clickFocus.title, 'Key 3');
    assert.deepEqual(r.clickFocus.pageMenus, [XL], 'the XL now has the Page ▾');
    assert.equal(r.clickFocus.xlPageMenu, 'main');
  });
  check('Ctrl+click never spans decks: on the other deck it focuses it with that key alone', () =>
    assert.deepEqual(r.ctrlAcross, { focused: XL, xlSelected: [1], v2Selected: [] }));
  check('a key dragged on the unfocused deck swaps there, focuses it, and leaves the other deck alone', () => {
    assert.deepEqual(r.dragOther.v2, { 1: EXTRA, 4: TO_MAIN });
    assert.equal(r.dragOther.xlUnchanged, true);
    assert.equal(r.dragOther.focused, V2);
    assert.deepEqual(r.dragOther.v2Selected, [1]);
  });
  check('a key dragged from one deck onto the other changes nothing (not built until session 3)', () =>
    assert.equal(r.dragAcross.unchanged, true));
  check('a library drop on the unfocused deck makes the button there and focuses that deck', () => {
    assert.equal(r.libraryOther.v2Key3?.action?.type, 'hotkey');
    assert.equal(r.libraryOther.xlKey3, null, 'not on the XL\'s key of the same number');
    assert.equal(r.libraryOther.focused, V2);
    assert.deepEqual(r.libraryOther.v2Selected, [3]);
  });
  check('clicking a name in SHOW IN EDITOR shows that deck alone', () => {
    assert.equal(r.showOnly.grids, 1);
    assert.deepEqual(r.showOnly.panels, []);
    assert.equal(r.showOnly.edited, XL);
    assert.equal(r.showOnly.trigger, 'Big deck');
  });
  check('unticking the focused deck focuses the one left, on its own page, alone', () => {
    assert.equal(r.untickFocused.grids, 1);
    assert.deepEqual(r.untickFocused.panels, []);
    assert.equal(r.untickFocused.edited, V2);
    assert.deepEqual(r.untickFocused.tabs, ['Main', 'Extra']);
    assert.equal(r.untickFocused.selectedTab, 'Extra');
  });
  check('a shown deck with no layout in the profile keeps its panel, with the "Add a layout" card', () => {
    assert.deepEqual(r.noLayout.panels, [XL, V2]);
    assert.equal(r.noLayout.grids, 1);
    assert.equal(r.noLayout.kind, 'no-layout');
    assert.equal(r.noLayout.button, 'Add a layout for Little deck');
  });
  check('its "Add a layout" button gives that deck a layout, drawn in its panel', () => assert.equal(r.layoutAdded, true));

  // The canvas (session 2). canvas.ts: a key is 88 px and a pitch 98 px at
  // 100%; a butted deck is a 16 px gutter away.
  const near = (actual, expected, tolerance, what) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);
  check('two decks shown are drawn on a canvas, at Fit all, never above 100%', () => {
    assert.equal(r.canvas.exists, true);
    assert.ok(r.canvas.zoom > 0 && r.canvas.zoom <= 1, `zoom ${r.canvas.zoom}`);
    assert.equal(r.canvas.label, `${Math.round(r.canvas.zoom * 100)}%`);
  });
  check('every deck\'s keys are the same size — real proportions in key units', () => {
    near(r.canvas.keyWidths[0], 88, 0.6, 'XL key at 100%');
    near(r.canvas.keyWidths[1], 88, 0.6, 'V2 key at 100%');
  });
  check('never arranged, the second deck is stacked below the first, left edges aligned, a gutter apart', () => {
    near(r.canvas.offset.x, 0, 0.01, 'x offset');
    near(r.canvas.gap, 16, 0.6, 'gap in px at 100%');
  });
  check('zoom: Reset is 100%, + and − step, Fit all returns to the fitted zoom', () => {
    assert.deepEqual({ zoom: r.zoom.atReset.zoom, label: r.zoom.atReset.label }, { zoom: 1, label: '100%' });
    near(r.zoom.atReset.keyWidth, 88, 0.6, 'a key at 100%');
    assert.equal(r.zoom.zoomedIn, 1.25);
    assert.equal(r.zoom.zoomedOut, 0.9);
    assert.equal(r.zoom.fitAgain, r.canvas.zoom);
  });
  check('at 50%, a key drag and a library drop land on the key under the pointer, and move no deck', () => {
    assert.equal(r.zoomedWork.zoom, 0.5);
    assert.equal(r.zoomedWork.xl?.['9']?.label, 'Back', 'the XL key dragged to key 10');
    assert.equal(r.zoomedWork.xl?.['0'], undefined);
    assert.equal(r.zoomedWork.v2Key6, 'hotkey');
    assert.equal(r.zoomedWork.decksStayed, true);
  });
  check('a deck dragged by its header snaps to the other deck\'s key column, and the guide says so while it moves', () => {
    assert.deepEqual(r.deckDrag.guides, [{ axis: 'x', label: 'snap · aligned to Big deck key column' }]);
    assert.equal(r.deckDrag.guidesAfter, 0, 'the guide goes with the drop');
    assert.equal(r.deckDrag.refused, false);
    near(r.deckDrag.offset.x, 2, 0.005, 'the V2\'s grid at the XL\'s third column');
  });
  check('moving a deck edits nothing and moves no focus', () => {
    assert.equal(r.deckDrag.configUnchanged, true);
    assert.equal(r.deckDrag.focused, XL);
  });
  check('a drop onto another deck, coming from below, is butted below it — a gutter apart, its column kept', () => {
    near(r.overlap.gap, 16, 0.6, 'gap in px at 100%');
    near(r.overlap.offset.x, 2, 0.005, 'x kept');
    assert.equal(r.overlap.refused, false);
  });
  check('a deck hidden and shown again comes back where it was', () => {
    near(r.reshown.after.x, r.reshown.before.x, 0.005, 'x');
    near(r.reshown.after.y, r.reshown.before.y, 0.005, 'y');
  });
}

// The run ended with both decks shown. The shown decks are remembered in the
// editor's preferences, never config.json, and a second opening shows both.
const prefsFile = path.join(stateDir, 'editor', 'preferences.json');
const prefs = JSON.parse(await fs.readFile(prefsFile, 'utf8').catch(() => '{}'));
check('the shown decks are remembered in the editor preferences, by serial', () => assert.deepEqual(prefs.shownDecks, [XL, V2]));
check('positions are remembered in the editor preferences, by serial, in key units — every shown deck, the one never dragged too', () => {
  assert.deepEqual(Object.keys(prefs.deckPositions ?? {}).sort(), [XL, V2].sort());
  assert.deepEqual(prefs.deckPositions[XL], { x: 0, y: 0 });
  assert.equal(prefs.deckPositions[V2].x, 2);
  assert.ok(prefs.deckPositions[V2].y > 4, 'below the XL');
});
const reopened = (await runElectronCheck('multi-deck-reopen', { configDir, stateDir, socket: daemon.socket }, 60_000)).report?.renderer;
check('reopened, the editor shows the decks it was left showing', () =>
  assert.deepEqual({ panels: reopened?.panels, grids: reopened?.grids, edited: reopened?.edited }, { panels: [XL, V2], grids: 2, edited: XL }));
check('reopened, the decks are where they were left, at Fit all', () => {
  assert.ok(reopened?.zoom > 0 && reopened?.zoom <= 1, `zoom ${reopened?.zoom}`);
  const want = { x: prefs.deckPositions[V2].x - prefs.deckPositions[XL].x, y: prefs.deckPositions[V2].y - prefs.deckPositions[XL].y };
  assert.ok(Math.abs(reopened.offset.x - want.x) < 0.01 && Math.abs(reopened.offset.y - want.y) < 0.01, `${JSON.stringify(reopened.offset)} ≠ ${JSON.stringify(want)}`);
});

const saved = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
check('nothing about which decks are shown, or where, is written to config.json', () => {
  assert.equal(JSON.stringify(saved).includes('shown'), false);
  assert.equal(JSON.stringify(saved).includes('osition'), false);
});
check('the V2 layout was added to the profile being edited, and to nothing else', () => {
  assert.ok(saved.profiles.solo.layouts[V2], 'no V2 layout in Solo');
  assert.deepEqual(Object.keys(saved.profiles.solo.layouts).sort(), [XL, V2].sort());
});
check('the XL\'s keys were never touched by anything done on the V2', () => assert.deepEqual(saved.profiles.default.layouts[XL], CONFIG.profiles.default.layouts[XL]));

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
