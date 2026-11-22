import { insideShape, type ShapeBox } from './shapes.js';

/**
 * A key's icon scale (Ryan, 2026-11-22): **one rule for every image and every
 * shape, built-ins included — at 100% the whole image fits inside the
 * control's box, centred.** Above 100% it zooms in and is cut to the shape;
 * below, it shrinks. The scale is relative to the button, never to the
 * image: a square image on a wide button is sized by its shorter side, with
 * space either side, and a built-in is never cropped at the default size.
 *
 * A key's `iconScale` is its own; without one, a built-in follows Settings ›
 * General › Icon size (`defaults.builtinIconSize`, the same percent) and a
 * file is drawn at 100%. Import-free but for shapes.ts, so the editor's
 * renderer uses the same arithmetic as the deck.
 */

export const ICON_SCALE = { min: 20, max: 200, step: 5 } as const;

/** What the key's `iconScale` may be. */
export function validIconScale(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= ICON_SCALE.min && v <= ICON_SCALE.max;
}

export interface Size {
  width: number;
  height: number;
}

/** The image's size drawn at `percent` in a box: at 100% the whole image fits the box, centred. Never below 1 px. */
export function drawnSize(image: Size, box: Size, percent: number): Size {
  const fit = Math.min(box.width / image.width, box.height / image.height);
  const f = (fit * percent) / 100;
  return { width: Math.max(1, Math.round(image.width * f)), height: Math.max(1, Math.round(image.height * f)) };
}

/**
 * The scale that draws what the retired `iconFit: cover` drew (Ryan,
 * 2026-11-22): the image covering the square at the box's shorter side,
 * centred — kept to ICON_SCALE.max. A square image's is 100 on any box; a
 * 2:1 image's on a square key is 200. Rounded to a tenth.
 */
export function coverScale(image: Size, box: Size): number {
  const side = Math.min(box.width, box.height);
  const cover = side / Math.min(image.width, image.height);
  const fit = Math.min(box.width / image.width, box.height / image.height);
  const percent = Math.round(((cover / fit) * 100) * 10) / 10;
  return Math.min(ICON_SCALE.max, Math.max(ICON_SCALE.min, percent));
}

/**
 * The per-key slider's mark: the largest scale at which the whole image is
 * still inside the control's shape (board 25b) — 100 on a rectangle with
 * square corners, about 71 for a square image in a circle. Every shape is
 * convex, so a centred rectangle is inside it when its four corners are.
 * Rounded down to a whole percent, so at the mark nothing is cut.
 */
export function wholeImageMark(image: Size, box: ShapeBox): number {
  const inside = (percent: number) => {
    const fit = Math.min(box.w / image.width, box.h / image.height);
    const w = (image.width * fit * percent) / 100;
    const h = (image.height * fit * percent) / 100;
    const x0 = (box.w - w) / 2;
    const y0 = (box.h - h) / 2;
    // Just inside each corner: an edge exactly on the shape's edge counts as inside.
    const e = 1e-6;
    return [
      [x0 + e, y0 + e],
      [x0 + w - e, y0 + e],
      [x0 + e, y0 + h - e],
      [x0 + w - e, y0 + h - e],
    ].every(([x, y]) => insideShape(box, x, y));
  };
  if (inside(100)) return 100;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}
