// The canvas's arithmetic (src/renderer/canvas.ts): placement, snapping,
// overlap and zoom; and the stored positions (src/shared/deck-positions.ts).
// Positions are in key units — a key and its gap — at the grid's top-left.

import assert from 'node:assert/strict';
import {
  arrange,
  fitZoom,
  FOOT_PX,
  GAP_PX,
  GUTTER_PX,
  HEAD_PX,
  MIN_ZOOM,
  overlaps,
  PAD_X_PX,
  panelRect,
  PITCH_PX,
  resolveOverlap,
  snap,
  union,
  zoomIn,
  zoomOut,
  type Neighbour,
} from '../src/renderer/canvas.js';
import { MAX_DECK_POSITIONS, readPositions, withPosition } from '../src/shared/deck-positions.js';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const u = (px: number) => px / PITCH_PX;
const close = (actual: number, expected: number, what = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} ≠ ${expected}`);
const XL = { columns: 8, rows: 4 };
const V2 = { columns: 5, rows: 3 };
const xl: Neighbour = { serial: 'XL', name: 'Deck XL', at: { x: 0, y: 0 }, size: XL };
/** Where a V2 sits butted below the XL at x = 0. */
const belowXL = 4 - u(GAP_PX) + u(FOOT_PX + GUTTER_PX + HEAD_PX);

await check('a panel is its keys and the frame around them; butted a gutter apart is not overlapping', () => {
  const r = panelRect({ x: 0, y: 0 }, XL);
  close(r.right - r.left, (8 * PITCH_PX - GAP_PX + 2 * PAD_X_PX) / PITCH_PX, 'width');
  close(r.bottom - r.top, (4 * PITCH_PX - GAP_PX + HEAD_PX + FOOT_PX) / PITCH_PX, 'height');
  const beside = panelRect({ x: 8 - u(GAP_PX) + u(2 * PAD_X_PX + GUTTER_PX), y: 0 }, V2);
  assert.equal(overlaps(r, beside), false);
  const touching = { ...r, left: r.right, right: r.right + 3 };
  assert.equal(overlaps(r, touching), false, 'touching edges do not overlap');
  assert.equal(overlaps(r, { ...touching, left: r.right - 0.01 }), true);
});

await check('with nothing remembered, the first deck is at the origin and the next stacked below it', () => {
  const at = arrange(['XL', 'V2'], { XL, V2 }, {});
  assert.deepEqual(at.XL, { x: 0, y: 0 });
  close(at.V2.x, 0, 'x');
  close(at.V2.y, belowXL, 'y');
  close(panelRect(at.V2, V2).top - panelRect(at.XL, XL).bottom, u(GUTTER_PX), 'a gutter between');
});

await check('remembered positions are used; a deck without one goes below the lowest, left-aligned', () => {
  const at = arrange(['XL', 'V2', 'MINI'], { XL, V2, MINI: { columns: 3, rows: 2 } }, { XL: { x: 2, y: 1 }, V2: { x: 12, y: 3 } });
  assert.deepEqual(at.XL, { x: 2, y: 1 });
  assert.deepEqual(at.V2, { x: 12, y: 3 });
  const lowest = Math.max(panelRect(at.XL, XL).bottom, panelRect(at.V2, V2).bottom);
  close(panelRect(at.MINI, { columns: 3, rows: 2 }).top, lowest + u(GUTTER_PX), 'below the lowest');
  close(at.MINI.x, 2, 'the leftmost deck’s x');
});

await check('a remembered position overlapping a deck already placed is not used (a hidden deck’s place taken)', () => {
  const at = arrange(['XL', 'V2'], { XL, V2 }, { XL: { x: 0, y: 0 }, V2: { x: 1, y: 1 } });
  close(at.V2.y, belowXL, 'moved below');
  assert.equal(overlaps(panelRect(at.XL, XL), panelRect(at.V2, V2)), false);
});

await check('decks not shown are not placed; a deck with no size yet is skipped, not guessed', () => {
  const at = arrange(['XL', 'V2'], { XL }, { MINI: { x: 5, y: 5 } });
  assert.deepEqual(Object.keys(at), ['XL']);
});

await check('snaps to another deck’s key column within 8 px on screen, and says so', () => {
  const near = snap({ x: 2.05, y: 7 }, V2, [xl], 1); // 0.05 × 98 ≈ 5 px
  assert.equal(near.at.x, 2);
  assert.equal(near.guides.length, 1);
  assert.equal(near.guides[0].axis, 'x');
  assert.equal(near.guides[0].label, 'aligned to Deck XL key column');
  assert.equal(near.guides[0].at, 2, 'the line at the column');
  const far = snap({ x: 2.15, y: 7 }, V2, [xl], 1); // ≈ 15 px
  assert.equal(far.at.x, 2.15);
  assert.equal(far.guides.length, 0);
});

await check('the snap distance is on screen: zoomed out, the same key distance is fewer pixels', () => {
  assert.equal(snap({ x: 2.15, y: 7 }, V2, [xl], 0.5).at.x, 2); // ≈ 7 px at 50%
  assert.equal(snap({ x: 2.15, y: 7 }, V2, [xl], 1).at.x, 2.15);
});

await check('its first and last columns are its edges, named as edges, the line on the panel’s edge', () => {
  const left = snap({ x: -0.04, y: 7 }, V2, [xl], 1);
  assert.equal(left.at.x, 0);
  assert.equal(left.guides[0].label, "aligned to Deck XL's left edge");
  close(left.guides[0].at, panelRect(xl.at, XL).left);
  const right = snap({ x: 3.03, y: 7 }, V2, [xl], 1);
  assert.equal(right.at.x, 3);
  assert.equal(right.guides[0].label, "aligned to Deck XL's right edge");
  close(panelRect(right.at, V2).right, panelRect(xl.at, XL).right, 'right edges line up');
});

await check('butts against another deck, a gutter apart, on either side and above or below', () => {
  const beside = 8 - u(GAP_PX) + u(2 * PAD_X_PX + GUTTER_PX);
  const r = snap({ x: beside + 0.04, y: 0.3 }, V2, [xl], 1);
  close(r.at.x, beside);
  assert.ok(r.guides.some((g) => g.label === 'beside Deck XL'));
  const b = snap({ x: 0.4, y: belowXL - 0.05 }, V2, [xl], 1);
  close(b.at.y, belowXL);
  assert.ok(b.guides.some((g) => g.axis === 'y' && g.label === 'below Deck XL'));
  const above = snap({ x: 0.4, y: -(3 - u(GAP_PX)) - u(HEAD_PX + GUTTER_PX + FOOT_PX) + 0.03 }, V2, [xl], 1);
  close(panelRect(above.at, V2).bottom + u(GUTTER_PX), panelRect(xl.at, XL).top, 'a gutter above');
});

await check('each axis snaps on its own: column and row at once, two lines', () => {
  // A 3 × 2 deck one row down beside a 4-row XL: a middle row, not its bottom edge.
  const r = snap({ x: 1.96, y: 1.04 }, { columns: 3, rows: 2 }, [xl], 1);
  assert.deepEqual(r.at, { x: 2, y: 1 });
  assert.deepEqual(r.guides.map((g) => g.axis).sort(), ['x', 'y']);
  assert.equal(r.guides.find((g) => g.axis === 'y')!.label, 'aligned to Deck XL key row');
});

await check('columns snap only where one of each deck’s columns lines up, not anywhere along the row', () => {
  assert.equal(snap({ x: -6.02, y: 7 }, V2, [xl], 1).at.x, -6.02, 'wholly to the left: no shared column');
});

await check('a drop overlapping a deck is butted against it on the side it came from', () => {
  // Came from below, dropped into the XL's lower half: butted below, x kept.
  const fromBelow = resolveOverlap({ x: 1.5, y: 3 }, V2, { x: 1.5, y: 8 }, [xl])!;
  assert.equal(fromBelow.x, 1.5);
  close(fromBelow.y, belowXL);
  // The same drop, coming from the right: butted to the right, y kept.
  const fromRight = resolveOverlap({ x: 6, y: 1 }, V2, { x: 12, y: 1 }, [xl])!;
  close(panelRect(fromRight, V2).left, panelRect(xl.at, XL).right + u(GUTTER_PX));
  assert.equal(fromRight.y, 1);
  // Coming from the left, even where the right would be nearer.
  const fromLeft = resolveOverlap({ x: 6, y: 1 }, V2, { x: -9, y: 1 }, [xl])!;
  close(panelRect(fromLeft, V2).right + u(GUTTER_PX), panelRect(xl.at, XL).left);
});

await check('coming from a corner, the side needing the smaller move wins', () => {
  // From below-right: just inside the XL's bottom edge, far inside its right edge.
  const r = resolveOverlap({ x: 5, y: belowXL - 0.2 }, V2, { x: 12, y: 9 }, [xl])!;
  assert.equal(r.x, 5);
  close(r.y, belowXL);
});

await check('a drop that overlaps nothing is left alone', () => {
  assert.deepEqual(resolveOverlap({ x: 0, y: 9 }, V2, { x: 0, y: 12 }, [xl]), { x: 0, y: 9 });
});

await check('when butting it still overlaps another deck, the drop is refused (null)', () => {
  const mini: Neighbour = { serial: 'MINI', name: 'Mini', at: { x: 0, y: belowXL }, size: { columns: 3, rows: 2 } };
  assert.equal(resolveOverlap({ x: 0.5, y: 3 }, V2, { x: 0.5, y: 12 }, [xl, mini]), null);
});

await check('Fit all shows everything, never above 100%, never below the smallest step', () => {
  const bounds = union([panelRect({ x: 0, y: 0 }, XL), panelRect({ x: 0, y: belowXL }, V2)]);
  assert.equal(fitZoom(bounds, { width: 4000, height: 4000 }), 1);
  const z = fitZoom(bounds, { width: 600, height: 500 });
  assert.ok(z < 1 && z > MIN_ZOOM);
  const w = (bounds!.right - bounds!.left) * PITCH_PX * z;
  const h = (bounds!.bottom - bounds!.top) * PITCH_PX * z;
  assert.ok(w <= 600 - 48 + 1e-9 && h <= 500 - 48 + 1e-9, 'fits inside the margins');
  assert.ok(Math.abs(w - 552) < 1e-6 || Math.abs(h - 452) < 1e-6, 'and fills one of them');
  assert.equal(fitZoom(bounds, { width: 60, height: 50 }), MIN_ZOOM);
  assert.equal(fitZoom(null, { width: 600, height: 500 }), 1);
  assert.equal(fitZoom(bounds, { width: 0, height: 0 }), 1, 'a window not laid out yet');
});

await check('− and + step through the zoom levels, from a fitted level too', () => {
  assert.equal(zoomIn(1), 1.25);
  assert.equal(zoomOut(1), 0.9);
  assert.equal(zoomIn(0.8), 0.9);
  assert.equal(zoomOut(0.8), 0.75);
  assert.equal(zoomOut(MIN_ZOOM), MIN_ZOOM);
  assert.equal(zoomIn(2), 2);
});

await check('stored positions: junk is dropped, the newest kept past the cap, a moved deck becomes newest', () => {
  assert.deepEqual(readPositions({ A: { x: 1, y: 2 }, B: { x: 'no', y: 1 }, C: { x: Infinity, y: 0 }, '': { x: 0, y: 0 }, D: null, E: { x: 1e9, y: 0 } }), { A: { x: 1, y: 2 } });
  assert.deepEqual(readPositions([{ x: 1, y: 1 }]), {});
  assert.deepEqual(readPositions(null), {});
  let all = {};
  for (let i = 0; i < MAX_DECK_POSITIONS + 3; i++) all = withPosition(all, `S${i}`, { x: i, y: 0 });
  assert.equal(Object.keys(all).length, MAX_DECK_POSITIONS);
  assert.equal(Object.keys(all)[0], 'S3', 'the oldest three forgotten');
  const moved = withPosition(all, 'S3', { x: 99, y: 0 });
  assert.equal(Object.keys(moved).length, MAX_DECK_POSITIONS);
  assert.equal(Object.keys(moved).at(-1), 'S3');
  assert.deepEqual(moved.S3, { x: 99, y: 0 });
});

console.log(failures === 0 ? '\ncanvas: all checks passed' : `\ncanvas: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
