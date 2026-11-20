/**
 * Overlapping controls on a virtual deck, drawn right (scope §7, round 2a —
 * Ryan's acceptance, 2026-11-18). The display helper puts the page's
 * background under every image it is sent (panel/panel.c), so an image must
 * carry everything that belongs in its rectangle: when a control is drawn and
 * others overlap its box, the image sent is every control touching that box,
 * in the panel's own order (the later on top), combined — and still
 * transparent wherever no control is, so the background shows there.
 * **Nothing here fills a gap**: alpha 0 stays alpha 0, which is what lets
 * round 3's see-through background show around a shape without the daemon
 * knowing what the background is.
 *
 * Pure, so the tests combine exactly what the driver does.
 */

/** A control's place on the canvas, whole pixels, and its last face (RGBA, straight alpha, w × h). */
export interface PlacedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Buffer;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The `target` box's image: each face in `layers`, bottom first, laid over
 * the ones before it with straight alpha ("over"); what no face covers stays
 * fully transparent. Each layer's pixels outside the target are left out.
 */
export function composeBox(target: Box, layers: ReadonlyArray<PlacedFace>): Buffer {
  const out = Buffer.alloc(target.w * target.h * 4);
  for (const layer of layers) {
    const left = Math.max(target.x, layer.x);
    const top = Math.max(target.y, layer.y);
    const right = Math.min(target.x + target.w, layer.x + layer.w);
    const bottom = Math.min(target.y + target.h, layer.y + layer.h);
    for (let y = top; y < bottom; y++) {
      let s = ((y - layer.y) * layer.w + (left - layer.x)) * 4;
      let d = ((y - target.y) * target.w + (left - target.x)) * 4;
      for (let x = left; x < right; x++, s += 4, d += 4) {
        const sa = layer.rgba[s + 3];
        if (sa === 0) continue;
        if (sa === 255) {
          out[d] = layer.rgba[s];
          out[d + 1] = layer.rgba[s + 1];
          out[d + 2] = layer.rgba[s + 2];
          out[d + 3] = 255;
          continue;
        }
        const da = out[d + 3];
        // What shows of the layer below, out of 255.
        const below = (da * (255 - sa)) / 255;
        const a = sa + below;
        for (let c = 0; c < 3; c++) out[d + c] = Math.round((layer.rgba[s + c] * sa + out[d + c] * below) / a);
        out[d + 3] = Math.round(a);
      }
    }
  }
  return out;
}
