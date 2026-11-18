/**
 * Offline test for custom layouts' shapes (scope §7, round 2a): what each
 * shape answers (src/shapes.ts), the hit test on real shapes in the panel's
 * own order (src/hit-test.ts), a shaped control's face (src/render.ts
 * renderFace) and overlapping controls combined (src/drivers/panel-compose.ts).
 *
 *   npm run build:ts && node scripts/smoke-shapes.mjs
 */
import path from 'node:path';
import { REPO, check, failureCount } from './test/control-harness.mjs';

const { insideShape, innerRect, innerPixels, cornerRadius, shapePath, fillsBox } = await import(path.join(REPO, 'dist/shapes.js'));
const { controlAt } = await import(path.join(REPO, 'dist/hit-test.js'));
const { geometryOfPanel } = await import(path.join(REPO, 'dist/geometry.js'));
const { renderButton, renderFace } = await import(path.join(REPO, 'dist/render.js'));
const { composeBox, boxesOverlap } = await import(path.join(REPO, 'dist/drivers/panel-compose.js'));

const near = (a, b, within = 0.01) => Math.abs(a - b) <= within;

console.log('what each shape answers');
{
  const round = { w: 200, h: 100, shape: 'round' };
  check('round: the middle is inside, the box corner is not', insideShape(round, 100, 50) && !insideShape(round, 2, 2) && !insideShape(round, 198, 98));
  check('round: an ellipse — the ends of its long axis are inside', insideShape(round, 1, 50) && insideShape(round, 199, 50) && !insideShape(round, 1, 30));
  const hex = { w: 100, h: 116, shape: 'hexagon' };
  check('hexagon, point-up: its top point and side corners inside, the box corners not', insideShape(hex, 50, 1) && insideShape(hex, 1, 30) && insideShape(hex, 99, 86) && !insideShape(hex, 2, 2) && !insideShape(hex, 97, 113));
  const pill = { w: 200, h: 60, shape: 'rectangle', radius: 999 };
  check('a radius past half the shorter side is a full pill', cornerRadius(pill) === 30);
  check('rounded rectangle: the corner is cut, the edges kept', !insideShape(pill, 1, 1) && insideShape(pill, 100, 1) && insideShape(pill, 1, 30));
  const square = { w: 100, h: 100, shape: 'square' };
  check('"square" (every control before custom layouts) fills its box, edges as before', fillsBox(square) && insideShape(square, 0, 0) && insideShape(square, 99.9, 99.9) && !insideShape(square, 100, 50));
  check('a rectangle with radius 0 fills its box too', fillsBox({ w: 50, h: 80, shape: 'rectangle', radius: 0 }));
  check('every point is outside its box', !insideShape(pill, -1, 30) && !insideShape(round, 200, 50));

  const r = innerRect({ w: 200, h: 100, shape: 'round' });
  check('round: the largest inner rectangle is w/√2 × h/√2, centred', near(r.w, 200 / Math.SQRT2) && near(r.h, 100 / Math.SQRT2) && near(r.x * 2 + r.w, 200) && near(r.y * 2 + r.h, 100));
  const h = innerRect({ w: 100, h: 116, shape: 'hexagon' });
  check('hexagon: the full width, between its side corners', near(h.w, 100) && near(h.y, 29) && near(h.h, 58));
  const sq = innerRect(square);
  check('a square key: the whole box (so its label is exactly as before)', sq.x === 0 && sq.y === 0 && sq.w === 100 && sq.h === 100);
  const rr = innerRect({ w: 100, h: 100, shape: 'rectangle', radius: 20 });
  check('rounded square: inset by r(1 − 1/√2) each way, the most area', near(rr.x, 20 * (1 - Math.SQRT1_2), 0.2) && near(rr.w, 100 - 2 * 20 * (1 - Math.SQRT1_2), 0.4));
  // Every inner rectangle really is inside: its four corners (just inside) on the shape.
  const allInside = [
    { w: 200, h: 100, shape: 'round' },
    { w: 100, h: 116, shape: 'hexagon' },
    { w: 300, h: 80, shape: 'hexagon' },
    { w: 200, h: 60, shape: 'rectangle', radius: 30 },
    { w: 150, h: 150, shape: 'rectangle', radius: 40 },
  ].every((box) => {
    const p = innerPixels(box);
    return [[p.x + 0.01, p.y + 0.01], [p.x + p.w - 0.01, p.y + 0.01], [p.x + 0.01, p.y + p.h - 0.01], [p.x + p.w - 0.01, p.y + p.h - 0.01]].every(([x, y]) => insideShape(box, x, y));
  });
  check('every shape\'s inner rectangle, in whole pixels, lies on the shape', allInside);
  check('each shape has an outline', ['round', 'hexagon', 'rectangle'].every((shape) => shapePath({ w: 10, h: 10, shape, radius: 2 }).endsWith('Z')));
}

console.log('the hit test');
{
  const a = { id: 'a', x: 0, y: 0, w: 100, h: 100 };
  const b = { id: 'b', x: 50, y: 50, w: 100, h: 100 };
  check('overlapping: the later in the panel\'s order is on top', controlAt([a, b], 75, 75) === 'b' && controlAt([b, a], 75, 75) === 'a');
  const round = { id: 'r', x: 50, y: 50, w: 100, h: 100, shape: 'round' };
  check('a touch in a round control\'s corner goes to the control beneath', controlAt([a, round], 55, 55) === 'a' && controlAt([a, round], 75, 75) === 'r');
  check('…and to nothing where nothing is', controlAt([round], 52, 52) === null);
  const hex = { id: 'h', x: 0, y: 0, w: 100, h: 116, shape: 'hexagon' };
  check('a hexagon is tested on its six sides', controlAt([hex], 50, 58) === 'h' && controlAt([hex], 3, 3) === null);

  const g = geometryOfPanel(
    { size: { width: 400, height: 200 }, controls: [{ id: 'top', x: 100, y: 0, w: 50, h: 50, shape: 'round' }, { id: 'under', x: 0, y: 0, w: 120, h: 50, radius: 8 }] },
    'Panel',
  );
  check('geometry: keys in reading order, each with its place in the panel\'s order', g.keys.map((k) => `${k.id}:${k.z}`).join() === 'under:1,top:0', g.keys.map((k) => `${k.id}:${k.z}`).join());
  check('geometry: shape and radius carried', g.keys[0].radius === 8 && g.keys[1].shape === 'round');
}

console.log('a shaped face');
{
  const BG = '#203040';
  const face = (extra = {}) => ({ labelColor: '#ffffff', labelSize: 14, labelPosition: 'bottom', background: BG, iconFit: 'cover', ...extra });
  const alpha = (buf, w, x, y) => buf[(y * w + x) * 4 + 3];
  const rgb = (buf, w, x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)).join();

  const square = await renderFace(face({ label: 'Hi' }), { width: 96, height: 96, shape: 'square' });
  const button = await renderButton(face({ label: 'Hi' }), 96);
  check('a square key with square corners is renderButton\'s key, byte for byte', Buffer.compare(square, button) === 0);

  // Alpha: 255 on the shape, 0 off it, anything only within a pixel of its edge.
  for (const box of [
    { width: 200, height: 120, shape: 'round' },
    { width: 120, height: 139, shape: 'hexagon' },
    { width: 220, height: 80, shape: 'rectangle', radius: 40 },
  ]) {
    const buf = await renderFace(face(), box);
    const sb = { w: box.width, h: box.height, shape: box.shape, radius: box.radius };
    let wrong = 0;
    for (let y = 0; y < box.height; y++) {
      for (let x = 0; x < box.width; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const deep = [[-1, 0], [1, 0], [0, -1], [0, 1], [0, 0]].every(([dx, dy]) => insideShape(sb, cx + dx, cy + dy));
        const out = [[-1, 0], [1, 0], [0, -1], [0, 1], [0, 0]].every(([dx, dy]) => !insideShape(sb, cx + dx, cy + dy));
        const a = alpha(buf, box.width, x, y);
        if ((deep && a !== 255) || (out && a !== 0)) wrong++;
      }
    }
    check(`${box.shape}: opaque on the shape, fully transparent off it (${wrong} wrong pixels)`, wrong === 0);
    check(`${box.shape}: the fill covers the shape`, rgb(buf, box.width, Math.floor(box.width / 2), Math.floor(box.height / 2)) === '32,48,64');
  }

  // The label and the failed badge are laid out in the inner rectangle: every pixel they change is inside it.
  for (const box of [
    { width: 200, height: 200, shape: 'round' },
    { width: 160, height: 185, shape: 'hexagon' },
    { width: 240, height: 90, shape: 'rectangle', radius: 45 },
  ]) {
    const inner = innerPixels({ w: box.width, h: box.height, shape: box.shape, radius: box.radius });
    const plain = await renderFace(face(), box);
    for (const [what, extra] of [
      ['a long two-line label at the bottom', { label: 'WWWWWWWWWWWWWWWWWWWW\nSecond line here' }],
      ['a label at the top', { label: 'Top label', labelPosition: 'top' }],
      ['the failed badge', { failed: true }],
    ]) {
      const marked = await renderFace(face(extra), box);
      let changed = 0;
      let outside = 0;
      for (let y = 0; y < box.height; y++) {
        for (let x = 0; x < box.width; x++) {
          const i = (y * box.width + x) * 4;
          if (plain.readUInt32BE(i) === marked.readUInt32BE(i)) continue;
          changed++;
          if (x < inner.x || x >= inner.x + inner.w || y < inner.y || y >= inner.y + inner.h) outside++;
        }
      }
      check(`${box.shape}: ${what} stays in the largest inner rectangle (${changed} pixels drawn, ${outside} outside)`, changed > 0 && outside === 0);
    }
  }
}

console.log('overlapping controls, combined');
{
  // A 4 × 4 opaque red control at 0,0 and a 4 × 4 control at 2,2 whose top-left and bottom-right pixels are clear, the rest blue.
  const red = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) red.set([255, 0, 0, 255], i * 4);
  const blue = Buffer.alloc(64);
  for (let i = 1; i < 15; i++) blue.set([0, 0, 255, 255], i * 4);
  const lower = { x: 0, y: 0, w: 4, h: 4, rgba: red };
  const upper = { x: 2, y: 2, w: 4, h: 4, rgba: blue };
  check('boxes that touch only at an edge do not overlap', !boxesOverlap({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 }) && boxesOverlap(lower, upper));
  const px = (buf, w, x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)).join();
  const forLower = composeBox(lower, [lower, upper]);
  check('the lower control\'s image keeps the upper one on top', px(forLower, 4, 3, 3) === '0,0,255,255' && px(forLower, 4, 1, 1) === '255,0,0,255');
  check('…and shows the lower one through the upper one\'s clear pixel', px(forLower, 4, 2, 2) === '255,0,0,255');
  const forUpper = composeBox(upper, [lower, upper]);
  check('the upper control\'s image: the lower one under its clear pixel', px(forUpper, 4, 0, 0) === '255,0,0,255' && px(forUpper, 4, 1, 1) === '0,0,255,255');
  check('…and no gap filled: clear where no control is', px(forUpper, 4, 3, 3) === '0,0,0,0', px(forUpper, 4, 3, 3));
  const alone = composeBox({ x: 10, y: 10, w: 2, h: 2 }, [lower]);
  check('a box nothing covers stays fully transparent', alone.every((b) => b === 0));
  const half = { x: 0, y: 0, w: 1, h: 1, rgba: Buffer.from([0, 0, 255, 128]) };
  const blended = composeBox({ x: 0, y: 0, w: 1, h: 1 }, [{ ...half, rgba: Buffer.from([255, 0, 0, 255]) }, half]);
  check('a soft edge over a control blends with it, opaque', px(blended, 1, 0, 0) === '127,0,128,255', px(blended, 1, 0, 0));
  const lone = composeBox({ x: 0, y: 0, w: 1, h: 1 }, [half]);
  check('a soft edge over nothing keeps its own alpha', px(lone, 1, 0, 0) === '0,0,255,128', px(lone, 1, 0, 0));
}

if (failureCount() > 0) {
  console.log(`shapes: ${failureCount()} check(s) FAILED`);
  process.exit(1);
}
console.log('shapes: all checks passed');
