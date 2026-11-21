// Edit layout's precision tools (scope §7, round 2b): the grid and snapping,
// nudging, and several controls moved, aligned, distributed and matched
// (src/shared/layout-arrange.ts).

import assert from 'node:assert/strict';
import type { PanelControlDef, PanelDef } from '../../src/types.js';
import {
  align,
  cleanGuides,
  DEFAULT_GUIDES,
  distribute,
  groupPosition,
  inMarquee,
  match,
  moveGroupTo,
  moveTogether,
  nudge,
  placeGroup,
  placeMoved,
  placeResized,
  snapTargets,
  type Placing,
} from '../src/shared/layout-arrange.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${(err as Error).message.split('\n').join('\n       ')}`);
  }
}

const free = (controls: PanelControlDef[]): PanelDef => ({ size: { width: 1920, height: 720 }, controls, preset: 'free' });
const of = (p: PanelDef, id: string) => p.controls.find((c) => c.id === id)!;
const panel = free([
  { id: 'a', x: 100, y: 100, w: 200, h: 200 },
  { id: 'b', x: 600, y: 120, w: 100, h: 100 },
  { id: 'c', x: 1000, y: 300, w: 300, h: 150 },
]);
const how = (p: PanelDef, moving: string[], over: Partial<Placing> = {}): Placing => ({ grid: false, pitch: 40, snap: true, reach: 6, targets: snapTargets(p, new Set(moving)), ...over });

console.log('Snapping and the grid');
check('a move within reach of another control\'s edge snaps to it, with a guide naming it', () => {
  // b's left edge 4 px right of a's right edge (300): snaps to 300.
  const { box, guides } = placeMoved({ x: 304, y: 520, w: 100, h: 100 }, panel.size, how(panel, ['b']));
  assert.equal(box.x, 300);
  assert.deepEqual(guides.map((g) => [g.axis, g.at, g.label]), [['x', 300, 'right edge of Key 1']]);
});
check('centres snap too, and the panel\'s own centre', () => {
  const { box, guides } = placeMoved({ x: 912, y: 500, w: 100, h: 100 }, panel.size, how(panel, ['b']));
  assert.equal(box.x + box.w / 2, 960);
  assert.equal(guides[0].label, "the panel's centre");
});
check('out of reach, nothing snaps; with the grid off, the box stays where the pointer put it', () => {
  const { box, guides } = placeMoved({ x: 333, y: 517, w: 100, h: 100 }, panel.size, how(panel, ['b']));
  assert.deepEqual([box.x, box.y, guides.length], [333, 517, 0]);
});
check('the grid alone: the left and top edges land on its lines', () => {
  const { box } = placeMoved({ x: 333, y: 517, w: 100, h: 100 }, panel.size, how(panel, ['b'], { grid: true, snap: false }));
  assert.deepEqual([box.x, box.y], [320, 520]);
});
check('Shift (neither switch): free to the pixel, even right beside an edge', () => {
  const { box } = placeMoved({ x: 303, y: 517, w: 100, h: 100 }, panel.size, how(panel, ['b'], { grid: false, snap: false }));
  assert.deepEqual([box.x, box.y], [303, 517]);
});
check('snapping wins over the grid where both are on', () => {
  const { box } = placeMoved({ x: 304, y: 517, w: 100, h: 100 }, panel.size, how(panel, ['b'], { grid: true }));
  assert.deepEqual([box.x, box.y], [300, 520]);
});
check('a snapped or gridded box still never leaves the canvas', () => {
  const { box } = placeMoved({ x: 1890, y: 700, w: 100, h: 100 }, panel.size, how(panel, ['b'], { grid: true }));
  assert.deepEqual([box.x, box.y], [1820, 620]);
});
check('a resize snaps the moving edge, the opposite one fixed', () => {
  // a's right edge dragged to 596: within reach of b's left edge (600).
  const { box, guides } = placeResized(of(panel, 'a'), 'e', 296, 0, panel.size, false, how(panel, ['a']));
  assert.deepEqual(box, { x: 100, y: 100, w: 500, h: 200 });
  assert.equal(guides[0].label, 'left edge of Key 2');
});
check('a resize on the grid: the moving edge on a line', () => {
  // Right edge 300 + 117 = 417 → 400; bottom 300 + 33 = 333 → 320.
  const { box } = placeResized(of(panel, 'a'), 'se', 117, 33, panel.size, false, how(panel, ['a'], { grid: true, snap: false }));
  assert.deepEqual(box, { x: 100, y: 100, w: 300, h: 220 });
});
check('a resize with Lock proportions keeps the ratio after snapping', () => {
  const { box } = placeResized(of(panel, 'a'), 'e', 296, 0, panel.size, true, how(panel, ['a']));
  assert.equal(box.w / box.h, 1);
});
check('the stored guides: defaults for anything not one, a pitch within limits', () => {
  assert.deepEqual(cleanGuides(null), DEFAULT_GUIDES);
  assert.deepEqual(cleanGuides({ grid: true, pitch: 60, snap: false }), { grid: true, pitch: 60, snap: false });
  assert.equal(cleanGuides({ pitch: 1 }).pitch, 40);
  assert.equal(cleanGuides({ pitch: 12.5 }).pitch, 40);
});

console.log('Nudging');
check('the arrows nudge by 1 px, or one grid step with the grid on', () => {
  assert.equal(of(nudge(panel, ['a'], 1, 0, { ...DEFAULT_GUIDES, grid: false }), 'a').x, 101);
  assert.equal(of(nudge(panel, ['a'], 0, -1, { ...DEFAULT_GUIDES, grid: true, pitch: 60 }), 'a').y, 40);
});
check('several nudge together, and stop together at an edge', () => {
  const p = nudge(panel, ['a', 'c'], 0, -1, { grid: true, pitch: 120, snap: true });
  // a can go up 100 only: both move 100, so they keep their places relative to each other.
  assert.deepEqual([of(p, 'a').y, of(p, 'c').y], [0, 200]);
});

console.log('Several selected');
check('a marquee takes every control it touches, in reading order', () => {
  assert.deepEqual(inMarquee(panel, { x: 250, y: 50, w: 400, h: 100 }), ['a', 'b']);
  assert.deepEqual(inMarquee(panel, { x: 0, y: 0, w: 50, h: 50 }), []);
});
check('moving together keeps their places relative to each other, stopped at the canvas\'s edge', () => {
  const p = moveTogether(panel, ['a', 'b'], -500, 0);
  assert.deepEqual([of(p, 'a').x, of(p, 'b').x, of(p, 'c').x], [0, 500, 1000]);
});
check('a group dragged snaps by its bounds and keeps its shape', () => {
  const from = ['a', 'b'].map((id) => ({ ...of(panel, id) }));
  const { panel: p, guides } = placeGroup(panel, ['a', 'b'], from, 0, 196, how(panel, ['a', 'b']));
  // The group's bottom (300 + 196 = 496) is within reach of nothing; its top (296) of nothing; c's top 300 from b? b's top 316. a's top 296 → c's top 300 within 6.
  assert.equal(of(p, 'b').x - of(p, 'a').x, 500);
  assert.equal(of(p, 'b').y - of(p, 'a').y, 20);
  assert.equal(of(p, 'a').y, 300);
  assert.equal(guides[0].label, 'top edge of Key 3');
});
check('align six ways, against the selection\'s own bounds', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(align(panel, ids, 'left').controls.map((c) => c.x), [100, 100, 100]);
  assert.deepEqual(align(panel, ids, 'right').controls.map((c) => c.x + c.w), [1300, 1300, 1300]);
  assert.deepEqual(align(panel, ids, 'centre').controls.map((c) => c.x + c.w / 2), [700, 700, 700]);
  assert.deepEqual(align(panel, ids, 'top').controls.map((c) => c.y), [100, 100, 100]);
  assert.deepEqual(align(panel, ids, 'bottom').controls.map((c) => c.y + c.h), [450, 450, 450]);
  assert.deepEqual(align(panel, ids, 'middle').controls.map((c) => c.y + c.h / 2), [275, 275, 275]);
  // The others are untouched.
  assert.deepEqual(align(panel, ['a', 'b'], 'top').controls[2], panel.controls[2]);
});
check('distribute across and down: equal gaps, the outer two fixed; two or fewer change nothing', () => {
  const p = distribute(panel, ['c', 'a', 'b'], 'across');
  // From 100 to 1300, 600 of widths: two gaps of 300. b goes to 300 + 300 = 600 — already there.
  assert.deepEqual([of(p, 'a').x, of(p, 'b').x, of(p, 'c').x], [100, 600, 1000]);
  const q = distribute(free([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 150, y: 0, w: 100, h: 100 }, { id: 'c', x: 900, y: 0, w: 100, h: 100 }]), ['a', 'b', 'c'], 'across');
  assert.equal(of(q, 'b').x, 450);
  const d = distribute(free([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 0, y: 120, w: 100, h: 100 }, { id: 'c', x: 0, y: 600, w: 100, h: 100 }]), ['a', 'b', 'c'], 'down');
  assert.equal(of(d, 'b').y, 300);
  assert.equal(distribute(panel, ['a', 'b'], 'across'), panel);
});
check('match width or height to the first one selected; Lock proportions keeps a shape', () => {
  const p = match(panel, ['c', 'a', 'b'], 'w');
  assert.deepEqual([of(p, 'a').w, of(p, 'b').w, of(p, 'c').w], [300, 300, 300]);
  assert.deepEqual([of(p, 'a').h, of(p, 'b').h], [200, 100]);
  const locked = free([{ id: 'a', x: 0, y: 0, w: 100, h: 50 }, { id: 'b', x: 200, y: 0, w: 80, h: 80, keepRatio: true }]);
  assert.deepEqual([of(match(locked, ['a', 'b'], 'h'), 'b').w, of(match(locked, ['a', 'b'], 'h'), 'b').h], [50, 50]);
});
check('a typed X or Y with several: their bounds moved there together, stopped at the edge', () => {
  assert.deepEqual(groupPosition(panel, ['b', 'c']), { x: 600, y: 120 });
  const p = moveGroupTo(panel, ['b', 'c'], { x: 1800 });
  assert.deepEqual([of(p, 'b').x, of(p, 'c').x], [1220, 1620]);
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nlayout arrange: all checks passed');
