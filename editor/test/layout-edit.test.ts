// Edit layout (scope §7, round 2a): the arithmetic of the mode
// (src/shared/layout-edit.ts), the setLayout edit (src/main/config-document.ts),
// and Change layout… from a custom page (src/shared/panel-size.ts).

import assert from 'node:assert/strict';
import type { Config, PanelDef } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';
import { makePanel, newButtonSide } from '../../src/panel-presets.js';
import { applyEdit } from '../src/main/config-document.js';
import type { Edit } from '../src/shared/edits.js';
import { regridPage } from '../src/shared/panel-size.js';
import {
  addButton,
  bringToFront,
  buttonsFor,
  clampBox,
  controlNames,
  deleteControl,
  duplicateControl,
  DUPLICATE_OFFSET,
  freshControlId,
  layoutChanges,
  madeCustom,
  moveControl,
  overlaps,
  resizeBox,
  sendToBack,
  setShape,
  shapesOverlap,
  verySmallMm,
  withControl,
} from '../src/shared/layout-edit.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const CANVAS = { width: 1920, height: 720 };
const free = (controls: PanelDef['controls']): PanelDef => ({ size: CANVAS, controls, preset: 'free' });

console.log('moving and resizing');
check('a move stops at the canvas\'s edges, the size kept', () => {
  const p = free([{ id: 'a', x: 100, y: 100, w: 200, h: 200 }]);
  assert.deepEqual(moveControl(p, 'a', -50, 900).controls[0], { id: 'a', x: 0, y: 520, w: 200, h: 200 });
  assert.deepEqual(moveControl(p, 'a', 1800, -3).controls[0], { id: 'a', x: 1720, y: 0, w: 200, h: 200 });
});
check('a typed size larger than the canvas is the canvas', () => {
  assert.deepEqual(clampBox({ x: 10, y: 10, w: 5000, h: 5000 }, CANVAS), { x: 0, y: 0, w: 1920, h: 720 });
});
check('the east handle moves the right edge only; the west the left, the right edge fixed', () => {
  const from = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeBox(from, 'e', 50, 999, CANVAS, false), { x: 100, y: 100, w: 250, h: 100 });
  assert.deepEqual(resizeBox(from, 'w', -50, 0, CANVAS, false), { x: 50, y: 100, w: 250, h: 100 });
});
check('a handle stops at the canvas and at the smallest size', () => {
  const from = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeBox(from, 'w', -500, 0, CANVAS, false), { x: 0, y: 100, w: 300, h: 100 });
  assert.deepEqual(resizeBox(from, 's', 0, -500, CANVAS, false), { x: 100, y: 100, w: 200, h: 8 });
});
check('Lock proportions: an edge keeps the ratio, centred on the other axis; a corner follows the larger move', () => {
  const from = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeBox(from, 'e', 100, 0, CANVAS, true), { x: 100, y: 75, w: 300, h: 150 });
  assert.deepEqual(resizeBox(from, 'se', 10, 100, CANVAS, true), { x: 100, y: 100, w: 400, h: 200 });
});
check('Lock proportions near an edge: stops where the ratio still fits', () => {
  const from = { x: 1700, y: 600, w: 100, h: 100 };
  const r = resizeBox(from, 'se', 500, 500, CANVAS, true);
  assert.equal(r.w, r.h);
  assert.ok(r.x + r.w <= 1920 && r.y + r.h <= 720, JSON.stringify(r));
});
check('a radius follows a box made smaller: never past a full pill', () => {
  const p = free([{ id: 'a', x: 0, y: 0, w: 300, h: 300, shape: 'rectangle', radius: 120 }]);
  assert.equal(withControl(p, 'a', { w: 100, h: 60 }).controls[0].radius, 30);
});

console.log('adding, duplicating, deleting, order');
check('a new Button is Medium\'s key, about 30 mm, centred where it was dropped, on top', () => {
  const p = free([{ id: 'c1', x: 0, y: 0, w: 50, h: 50 }]);
  const { panel, id } = addButton(p, { x: 960, y: 360 }, SCREEN);
  const side = newButtonSide(SCREEN);
  assert.equal(id, 'c2');
  assert.deepEqual(panel.controls[1], { id: 'c2', x: Math.round(960 - side / 2), y: Math.round(360 - side / 2), w: side, h: side });
});
check('dropped at a corner, it stays on the canvas', () => {
  const { panel } = addButton(free([]), { x: 1919, y: 0 }, SCREEN);
  const c = panel.controls[0];
  assert.ok(c.x + c.w === 1920 && c.y === 0);
});
check('a new id is never one the page had when the mode opened', () => {
  assert.equal(freshControlId(free([{ id: 'c1', x: 0, y: 0, w: 9, h: 9 }]), ['c2', 'c3']), 'c4');
});
check('Duplicate: one more control, the same size and shape, offset one grid step, with the key it shows', () => {
  const p = free([{ id: 'c1', x: 100, y: 100, w: 200, h: 150, shape: 'hexagon' }]);
  const page = { buttons: { c1: { label: 'Mic', action: { type: 'noop' } } } };
  const d = duplicateControl(p, page, 'c1')!;
  assert.deepEqual(d.panel.controls[1], { id: 'c2', x: 100 + DUPLICATE_OFFSET, y: 100 + DUPLICATE_OFFSET, w: 200, h: 150, shape: 'hexagon' });
  assert.deepEqual(d.button, page.buttons.c1);
  assert.notEqual(d.button, page.buttons.c1);
});
check('Duplicate of an empty control carries no key', () => {
  assert.equal(duplicateControl(free([{ id: 'c1', x: 0, y: 0, w: 9, h: 9 }]), { buttons: {} }, 'c1')!.button, null);
});
check('Bring to front and Send to back change the order and nothing else', () => {
  const p = free([{ id: 'a', x: 0, y: 0, w: 9, h: 9 }, { id: 'b', x: 0, y: 0, w: 9, h: 9 }, { id: 'c', x: 0, y: 0, w: 9, h: 9 }]);
  assert.deepEqual(bringToFront(p, 'a').controls.map((c) => c.id), ['b', 'c', 'a']);
  assert.deepEqual(sendToBack(p, 'c').controls.map((c) => c.id), ['c', 'a', 'b']);
  assert.deepEqual(deleteControl(p, 'b').controls.map((c) => c.id), ['a', 'c']);
});
check('a shape changed away from a rectangle drops its radius', () => {
  const p = free([{ id: 'a', x: 0, y: 0, w: 90, h: 90, shape: 'rectangle', radius: 10 }]);
  assert.equal(setShape(p, 'a', 'round').controls[0].radius, undefined);
  assert.equal(setShape(p, 'a', 'round').controls[0].shape, 'round');
});

console.log('overlap, names, very small');
check('overlap is judged on real shapes: touching hexagons in a honeycomb do not overlap', () => {
  // Point-up hexagons 100 wide side by side, the next row offset by half and up by a quarter.
  const a = { id: 'a', x: 0, y: 0, w: 100, h: 116 };
  const b = { id: 'b', x: 50, y: 87, w: 100, h: 116 };
  assert.equal(shapesOverlap({ ...a, shape: 'hexagon' }, { ...b, shape: 'hexagon' }), false);
  assert.equal(shapesOverlap(a, b), true);
});
check('two round controls whose boxes overlap only at the corners do not', () => {
  assert.equal(shapesOverlap({ id: 'a', x: 0, y: 0, w: 100, h: 100, shape: 'round' }, { id: 'b', x: 90, y: 90, w: 100, h: 100, shape: 'round' }), false);
});
check('the later control is on top: the earlier is under it', () => {
  const o = overlaps(free([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 50, y: 50, w: 100, h: 100 }, { id: 'c', x: 900, y: 0, w: 10, h: 10 }]));
  assert.deepEqual(o.get('a'), { over: [], under: ['b'] });
  assert.deepEqual(o.get('b'), { over: ['a'], under: [] });
  assert.deepEqual(o.get('c'), { over: [], under: [] });
});
check('names are Key n in reading order, whatever the panel\'s order', () => {
  const names = controlNames(free([{ id: 'x', x: 500, y: 0, w: 9, h: 9 }, { id: 'y', x: 0, y: 0, w: 9, h: 9 }]));
  assert.equal(names.get('y'), 'Key 1');
  assert.equal(names.get('x'), 'Key 2');
});
check('very small under about 15 mm on the shorter side, with the figure; a warning only', () => {
  const p = free([]);
  // 1920 px over 243 mm: 7.9 px per mm.
  assert.deepEqual(verySmallMm(SCREEN, p, { w: 60, h: 60 }), { mm: 8 });
  assert.equal(verySmallMm(SCREEN, p, { w: 200, h: 200 }), null);
  assert.deepEqual(verySmallMm(null, p, { w: 300, h: 80 }), { mm: null });
});

console.log('what Discard puts back');
check('added, moved or resized, deleted — counted against the layout as the mode found it', () => {
  const before = free([{ id: 'a', x: 0, y: 0, w: 9, h: 9 }, { id: 'b', x: 0, y: 0, w: 9, h: 9 }, { id: 'c', x: 0, y: 0, w: 9, h: 9 }]);
  const after = free([{ id: 'a', x: 5, y: 0, w: 9, h: 9 }, { id: 'c', x: 0, y: 0, w: 9, h: 9, shape: 'round' }, { id: 'd', x: 0, y: 0, w: 9, h: 9 }]);
  assert.deepEqual(layoutChanges(before, after), { added: 1, moved: 2, deleted: 1, reordered: false });
  assert.deepEqual(layoutChanges(before, before), { added: 0, moved: 0, deleted: 0, reordered: false });
  assert.equal(layoutChanges(before, bringToFront(before, 'a')).reordered, true);
});
check('a control gone takes its key; the rest keep theirs', () => {
  const page = { buttons: { a: { label: 'A' }, b: { label: 'B' } } };
  assert.deepEqual(buttonsFor(page, free([{ id: 'a', x: 0, y: 0, w: 9, h: 9 }])), { a: { label: 'A' } });
  assert.deepEqual(buttonsFor(page, free([{ id: 'a', x: 0, y: 0, w: 9, h: 9 }, { id: 'n', x: 0, y: 0, w: 9, h: 9 }]), { n: { label: 'N' } }), { a: { label: 'A' }, n: { label: 'N' } });
});

console.log('the setLayout edit');
const KEY = 'GRA-6e4e';
function withPage(): Config {
  return validateConfig({
    decks: { [KEY]: { virtual: { output: 'DP-4', panel: makePanel(SCREEN, 'medium') } } },
    profiles: { p: { layouts: { [KEY]: { pages: { main: { panel: makePanel(SCREEN, 'medium'), buttons: { k1: { label: 'one' }, k2: { label: 'two' } } } } } } } },
  });
}
let n = 0;
const env = { homeDir: '/home/test', randomHex: () => (n++).toString(16).padStart(4, '0') };
const apply = (config: Config, edit: Edit) => {
  applyEdit(config, edit, env);
  return validateConfig(config);
};
const at = { profile: 'p', serial: KEY, page: 'main' };
check('making a preset custom keeps every control and key in place', () => {
  const config = withPage();
  const page = config.profiles.p.layouts[KEY].pages.main;
  const panel = madeCustom(page.panel!);
  const after = apply(config, { kind: 'setLayout', ...at, panel, buttons: page.buttons });
  const p = after.profiles.p.layouts[KEY].pages.main;
  assert.equal(p.panel!.preset, 'free');
  assert.deepEqual(p.panel!.controls, makePanel(SCREEN, 'medium').controls);
  assert.deepEqual(p.buttons, { k1: { label: 'one' }, k2: { label: 'two' } });
});
check('a layout with no controls is refused, never saved', () => {
  assert.throws(() => apply(withPage(), { kind: 'setLayout', ...at, panel: free([]), buttons: {} }), /no controls is never saved/);
});
check('a fixed grid is not edited by it', () => {
  assert.throws(() => apply(withPage(), { kind: 'setLayout', ...at, panel: makePanel(SCREEN, 'small'), buttons: {} }), /only a custom layout/);
});
check('a key for a control the layout does not have is refused', () => {
  assert.throws(() => apply(withPage(), { kind: 'setLayout', ...at, panel: free([{ id: 'c1', x: 0, y: 0, w: 99, h: 99 }]), buttons: { k1: { label: 'one' } } }), /not a control/);
});
check('a Stream Deck has no layout of its own to edit', () => {
  const config = withPage();
  config.decks!.XL = {};
  config.profiles.p.layouts.XL = { pages: { main: { buttons: {} } } };
  assert.throws(() => apply(config, { kind: 'setLayout', profile: 'p', serial: 'XL', page: 'main', panel: free([{ id: 'c1', x: 0, y: 0, w: 9, h: 9 }]), buttons: {} }), /not a virtual deck/);
});
check('shapes and a radius are saved and pass the daemon\'s validation', () => {
  const panel = free([{ id: 'c1', x: 0, y: 0, w: 300, h: 100, shape: 'rectangle', radius: 40, keepRatio: true }, { id: 'c2', x: 400, y: 0, w: 200, h: 231, shape: 'hexagon' }]);
  const after = apply(withPage(), { kind: 'setLayout', ...at, panel, buttons: {} });
  assert.deepEqual(after.profiles.p.layouts[KEY].pages.main.panel, panel);
});

check('restorePage puts a fixed grid back with its keys; never empty either', () => {
  const config = withPage();
  const before = structuredClone(config.profiles.p.layouts[KEY].pages.main);
  let after = apply(config, { kind: 'setLayout', ...at, panel: free([{ id: 'c1', x: 0, y: 0, w: 99, h: 99 }]), buttons: {} });
  after = apply(after, { kind: 'restorePage', ...at, panel: before.panel!, buttons: before.buttons });
  assert.deepEqual(after.profiles.p.layouts[KEY].pages.main, before);
  assert.throws(() => apply(withPage(), { kind: 'restorePage', ...at, panel: free([]), buttons: {} }), /no controls is never saved/);
});

console.log('Change layout… from a custom page');
check('to a fixed grid: every key is lost, buttons included, even where a control sat on the grid', () => {
  const medium = makePanel(SCREEN, 'medium');
  const custom = madeCustom(medium);
  const page = { panel: custom, buttons: { k1: { label: 'one' }, k2: { label: 'two' } } };
  const { page: after, dropped } = regridPage(page, custom, makePanel(SCREEN, 'medium'));
  assert.deepEqual(after.buttons, {});
  assert.deepEqual(dropped.map((d) => d.key), ['k1', 'k2']);
});
check('one fixed grid to another still keeps keys by row and column', () => {
  const page = { panel: makePanel(SCREEN, 'medium'), buttons: { k1: { label: 'one' } } };
  assert.deepEqual(regridPage(page, page.panel, makePanel(SCREEN, 'small')).page.buttons, { k1: { label: 'one' } });
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nlayout edit: all checks passed');
