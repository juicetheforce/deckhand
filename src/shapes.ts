/**
 * The shapes a virtual deck's control can have, and the three questions each
 * one answers: is a point inside it, what is its outline, and what is the
 * largest rectangle that fits inside it. Nothing else asks which shape a
 * control is: the hit test asks the first, the drawing (the daemon's and the
 * editor's) the second, and the label and the failed badge the third (Ryan,
 * 2026-11-18: one label rule for every shape, so a future shape only has to
 * answer the same questions).
 *
 * Import-free, so the editor imports it, as hit-test.ts.
 *
 * - **rectangle**: its box, with a corner radius from 0 (square corners) to
 *   half the shorter side (a full pill). A stored `"square"` — every control
 *   written before custom layouts — is a rectangle with square corners.
 * - **round**: the ellipse its box holds; a circle in a square box.
 * - **hexagon**: drawn point-up, its six corners at the middle of the top and
 *   bottom edges and a quarter of the way down and up each side; regular in a
 *   box √3 : 2 (wide : high), stretched with any other box.
 */

export type ShapeName = 'rectangle' | 'round' | 'hexagon';

export const SHAPE_NAMES: ReadonlyArray<ShapeName> = ['rectangle', 'round', 'hexagon'];

/** A control's box and shape, in any units: what every question here takes. */
export interface ShapeBox {
  w: number;
  h: number;
  /** Absent, "square" or "rectangle": a rectangle. */
  shape?: string;
  /** A rectangle's corner radius; ignored by the other shapes. */
  radius?: number;
}

export interface InnerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function shapeName(shape: string | undefined): ShapeName {
  return shape === 'round' || shape === 'hexagon' ? shape : 'rectangle';
}

/** A rectangle's corner radius, kept between square corners and a full pill; 0 for the other shapes. */
export function cornerRadius(box: ShapeBox): number {
  if (shapeName(box.shape) !== 'rectangle') return 0;
  const r = Number.isFinite(box.radius) ? (box.radius as number) : 0;
  return Math.max(0, Math.min(r, Math.min(box.w, box.h) / 2));
}

/** Whether the shape covers its whole box: a rectangle with square corners. Such a control draws and hit-tests as before shapes existed. */
export function fillsBox(box: ShapeBox): boolean {
  return shapeName(box.shape) === 'rectangle' && cornerRadius(box) === 0;
}

/**
 * Whether a point, relative to the box's top-left, is on the shape. The box's
 * right and bottom edges are not included, as a rectangle's never were.
 */
export function insideShape(box: ShapeBox, px: number, py: number): boolean {
  const { w, h } = box;
  if (!(px >= 0 && px < w && py >= 0 && py < h)) return false;
  switch (shapeName(box.shape)) {
    case 'round': {
      const dx = (px - w / 2) / (w / 2);
      const dy = (py - h / 2) / (h / 2);
      return dx * dx + dy * dy <= 1;
    }
    case 'hexagon': {
      // How far from the centre line, 0 to 1, sets how far the slanted edges reach in.
      const across = Math.abs(px - w / 2) / (w / 2);
      const slant = (h / 4) * across;
      return py >= slant && py <= h - slant;
    }
    default: {
      const r = cornerRadius(box);
      if (r === 0) return true;
      // Only the four corner squares can be outside: there, the point must be within r of the corner's centre.
      const cx = px < r ? r : px > w - r ? w - r : px;
      const cy = py < r ? r : py > h - r ? h - r : py;
      const dx = px - cx;
      const dy = py - cy;
      return dx * dx + dy * dy <= r * r;
    }
  }
}

/** A hexagon's six corners, clockwise from the top, in its box. */
export function hexagonPoints(w: number, h: number): Array<[number, number]> {
  return [
    [w / 2, 0],
    [w, h / 4],
    [w, (3 * h) / 4],
    [w / 2, h],
    [0, (3 * h) / 4],
    [0, h / 4],
  ];
}

const n = (v: number) => Number(v.toFixed(3));

/** The shape's outline as an SVG path, in the box's own units with its top-left at 0, 0. */
export function shapePath(box: ShapeBox): string {
  const { w, h } = box;
  switch (shapeName(box.shape)) {
    case 'round': {
      const rx = w / 2;
      const ry = h / 2;
      return `M0 ${n(ry)}A${n(rx)} ${n(ry)} 0 1 0 ${n(w)} ${n(ry)}A${n(rx)} ${n(ry)} 0 1 0 0 ${n(ry)}Z`;
    }
    case 'hexagon':
      return `M${hexagonPoints(w, h).map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;
    default: {
      const r = cornerRadius(box);
      if (r === 0) return `M0 0H${n(w)}V${n(h)}H0Z`;
      return (
        `M${n(r)} 0H${n(w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w)} ${n(r)}` +
        `V${n(h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w - r)} ${n(h)}` +
        `H${n(r)}A${n(r)} ${n(r)} 0 0 1 0 ${n(h - r)}` +
        `V${n(r)}A${n(r)} ${n(r)} 0 0 1 ${n(r)} 0Z`
      );
    }
  }
}

/**
 * The largest rectangle, by area, that fits inside the shape, centred in its
 * box: where the label is laid out and the failed badge sits (Ryan,
 * 2026-11-18). A rectangle with square corners gives its whole box, so a
 * square key's label is exactly as it was.
 *
 * - round: w/√2 × h/√2, the largest rectangle in any ellipse;
 * - hexagon: the full width, from a quarter of the way down to a quarter of
 *   the way up — the rectangle between its side corners;
 * - rectangle with rounded corners: a corner of the inner rectangle on each
 *   arc, at the angle that gives it the most area, found by trying every
 *   half degree (cheap, and exact enough for whole pixels).
 */
export function innerRect(box: ShapeBox): InnerRect {
  const { w, h } = box;
  let iw = w;
  let ih = h;
  switch (shapeName(box.shape)) {
    case 'round':
      iw = w / Math.SQRT2;
      ih = h / Math.SQRT2;
      break;
    case 'hexagon':
      ih = h / 2;
      break;
    default: {
      const r = cornerRadius(box);
      if (r === 0) break;
      let best = -1;
      for (let step = 0; step <= 180; step++) {
        const angle = (step / 180) * (Math.PI / 2);
        const insetX = r * (1 - Math.cos(angle));
        const insetY = r * (1 - Math.sin(angle));
        const area = (w - 2 * insetX) * (h - 2 * insetY);
        if (area > best) {
          best = area;
          iw = w - 2 * insetX;
          ih = h - 2 * insetY;
        }
      }
    }
  }
  return { x: (w - iw) / 2, y: (h - ih) / 2, w: iw, h: ih };
}

/** innerRect() in whole pixels, kept inside: what the daemon draws a label into. */
export function innerPixels(box: ShapeBox): InnerRect {
  const r = innerRect(box);
  const x = Math.ceil(r.x - 1e-9);
  const y = Math.ceil(r.y - 1e-9);
  return { x, y, w: Math.max(1, Math.floor(r.x + r.w + 1e-9) - x), h: Math.max(1, Math.floor(r.y + r.h + 1e-9) - y) };
}
