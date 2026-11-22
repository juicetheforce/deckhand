import { promises as fs } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { builtinRefPath } from './builtin-icons.js';
import { expandPath } from './config.js';
import { connectingBadgeSvg, failedBadgePlacement, failedBadgeSvg, unsetBadgeSvg } from './failed-badge.js';
import { readIconFile } from './icon-file.js';
import { IMAGE_FORMATS, refusalText, sideRefusal } from './image-limits.js';
import { escapeXml, fitLine, labelStyle } from './label-fit.js';
import { fillsBox, innerPixels, shapePath } from './shapes.js';
import type { ValueLayersDef } from './types.js';
import { boxTravel, builtinLayerSvg, clamp01, knobAngle, LAYERS, levelAt, thumbOffset, type LayerName, type Travel } from './value-controls.js';

/**
 * A slider's or dial's face on a virtual deck (src/value-controls.ts): its
 * layers drawn once for its box — the built-in art or the images chosen, each
 * drawn to the box — and then put together for each value in plain
 * JavaScript, so a finger's drag costs one composition and one image to the
 * helper per step, never a rasterisation.
 *
 * - **The art** is everything that does not move: the background colour, if
 *   the control has one (none unless set: the page shows around the art); the
 *   track or base; the label, in a band at the foot of the box (26b, 26c); the
 *   failed, not-set-up or connecting badge. Drawn by sharp, once per change.
 * - **The fill** (a slider's) is shown from the lowest end up to the level;
 *   **the level ring** (a dial's) from the start angle round to the level.
 * - **The thumb** moves along the axis, the whole layer shifted; **the knob**
 *   rotates about the centre of the art's area.
 * - **Held** (Touch feedback): the thumb or knob lightened, and the built-in
 *   one with a soft halo in its colour.
 *
 * Everything outside the control's shape is alpha 0, as every face's is.
 */

export interface ValueFaceSpec {
  kind: 'slider' | 'dial';
  width: number;
  height: number;
  shape?: string;
  radius?: number;
  direction?: 'vertical' | 'horizontal';
  angles: { start: number; end: number };
  layers?: ValueLayersDef;
  /** The action's type, for the built-in art's colour. */
  type?: string;
  label?: string;
  labelColor: string;
  labelSize: number;
  labelFont?: string;
  /** A fill behind the art, or none (the page shows through). */
  background?: string | null;
  failed?: boolean;
  unset?: boolean;
  connecting?: boolean;
}

/** One layer's pixels, RGBA at the art area's size, with the box of what it draws. */
interface Layer {
  rgba: Buffer;
  /** The smallest rectangle holding every pixel not fully transparent; null if it draws nothing. */
  extent: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * The fill's or ring's pixels that draw something, each with where it is
 * revealed — a slider's distance from its lowest end, a dial's angle from the
 * start — worked out once per art, so a step only compares numbers.
 */
interface Reveal {
  /** Byte offsets into the layer and the face. */
  at: Int32Array;
  /** Revealed while this is at or under the level (a distance, or an angle). */
  from: Float32Array;
}

export interface ValueArt {
  spec: ValueFaceSpec;
  width: number;
  height: number;
  /** The art's area: the box less the label's band. */
  artH: number;
  /** Everything still, RGBA the box's size. */
  under: Buffer;
  fill: Layer | null;
  reveal: Reveal | null;
  moving: Layer;
  held: Layer;
  /** Over everything: the badge, RGBA the box's size, or null. */
  over: Buffer | null;
  /** The shape's alpha, the box's size, or null when the shape fills the box. */
  mask: Uint8Array | null;
  /** A slider's travel in the art's area. */
  travel: Travel;
  /**
   * The last few faces put together, by value and held, so drawing the same
   * value again is the same Buffer (the session skips the write) — a few, as
   * two controls drawn alike share one art.
   */
  faces: Map<string, Buffer>;
}

const arts = new Map<string, ValueArt>();
const MAX_ARTS = 64;
const warned = new Set<string>();

async function stampOf(file: string): Promise<string> {
  try {
    const st = await fs.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/** The file a layer names, or null for the built-in; a `builtin:` name is a shipped icon's file. */
function layerFile(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string' || ref === '') return null;
  return builtinRefPath(ref) ?? expandPath(ref);
}

/** The art for a spec: drawn once, kept while the spec and its files are unchanged. */
export async function valueArt(spec: ValueFaceSpec): Promise<ValueArt> {
  const files = LAYERS[spec.kind].map((name) => layerFile(spec.layers?.[name]));
  const stamps = await Promise.all(files.map((f) => (f ? stampOf(f) : Promise.resolve(''))));
  const key = `${JSON.stringify(spec)}|${stamps.join('|')}`;
  const hit = arts.get(key);
  if (hit) return hit;
  const art = await drawArt(spec);
  if (arts.size >= MAX_ARTS) {
    const oldest = arts.keys().next().value;
    if (oldest !== undefined) arts.delete(oldest);
  }
  arts.set(key, art);
  return art;
}

export function clearValueArt(): void {
  arts.clear();
  warned.clear();
}

/** Pixels of an SVG, RGBA at its own size. */
async function svgPixels(svg: string, width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.from(svg)).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
}

/**
 * One layer, drawn to the art's area: the image chosen, stretched to it, or
 * the built-in. An image the limits refuse, or that cannot be read, is drawn
 * as the built-in layer, said once in the log — a control stays usable.
 */
async function layerPixels(spec: ValueFaceSpec, name: LayerName, w: number, h: number, held = false): Promise<Buffer | null> {
  const ref = spec.layers?.[name];
  if (ref === null) return null;
  const file = layerFile(ref);
  if (file) {
    try {
      const { data } = await readIconFile(file, { image: false });
      const meta = await sharp(data, { animated: false }).metadata();
      if (!builtinRefPath(ref as string)) {
        if (!meta.format || !IMAGE_FORMATS.includes(meta.format)) throw new Error(refusalText(file, { kind: 'not-an-image' }));
        const side = sideRefusal(meta.width ?? 0, meta.height ?? 0);
        if (side) throw new Error(refusalText(file, side));
      }
      return await sharp(data, { animated: false }).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    } catch (err) {
      if (!warned.has(file)) {
        warned.add(file);
        console.error(`[render] cannot draw the ${name} layer from ${file}: ${(err as Error).message} — drawing the built-in ${name} instead`);
      }
    }
  }
  return svgPixels(builtinLayerSvg(name, { w, h }, { direction: spec.direction, angles: spec.angles, type: spec.type, held }), w, h);
}

function extentOf(rgba: Buffer, w: number, h: number): Layer['extent'] {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Lightened 22% towards white, as the pressed look (render.ts pressedLook). */
function lightened(rgba: Buffer): Buffer {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c] + (255 - out[i + c]) * 0.22);
  return out;
}

/** The label's band at the foot of the box: its lines at the key's label size, plus a little room. */
function bandHeight(spec: ValueFaceSpec): number {
  const lines = (spec.label ?? '').split('\n').filter((l) => l.length > 0).length;
  return lines === 0 ? 0 : Math.min(Math.floor(spec.height / 2), lines * Math.round(spec.labelSize * 1.15) + 4);
}

async function drawArt(spec: ValueFaceSpec): Promise<ValueArt> {
  const { width: w, height: h } = spec;
  const band = bandHeight(spec);
  const artH = Math.max(1, h - band);
  const [stillName, fillName, movingName] = LAYERS[spec.kind];
  const [still, fill, moving] = await Promise.all([
    layerPixels(spec, stillName, w, artH),
    layerPixels(spec, fillName, w, artH),
    layerPixels(spec, movingName, w, artH),
  ]);
  const movingPx = moving ?? Buffer.alloc(w * artH * 4);
  // Held: the built-in drawn with its halo, then lightened; a chosen image lightened.
  const builtinMoving = !layerFile(spec.layers?.[movingName]);
  const heldPx = lightened(builtinMoving ? ((await layerPixels(spec, movingName, w, artH, true)) ?? movingPx) : movingPx);

  // The still part: background, track or base, label.
  const parts: OverlayOptions[] = [];
  if (still) parts.push({ input: still, raw: { width: w, height: artH, channels: 4 }, top: 0, left: 0 });
  if (band > 0) {
    const lines = await Promise.all((spec.label ?? '').split('\n').filter((l) => l.length > 0).map((l) => fitLine(l, spec.labelSize, w, spec.labelFont)));
    const lh = Math.round(spec.labelSize * 1.15);
    const text = lines.map((l, i) => `<text x="${w / 2}" y="${2 + spec.labelSize + i * lh}" text-anchor="middle" class="lbl">${escapeXml(l)}</text>`).join('');
    parts.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${band}"><style>${labelStyle(spec.labelSize, spec.labelColor, spec.labelFont)}</style>${text}</svg>`), top: artH, left: 0 });
  }
  const bg = spec.background ?? null;
  let under = sharp({ create: { width: w, height: h, channels: 4, background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (parts.length > 0) under = under.composite(parts);
  const underPx = await under.raw().toBuffer();

  // The badge, over everything, at the top-right of the shape's inner rectangle, as on a button.
  const shapeBox = { w, h, shape: spec.shape, radius: spec.radius };
  const badge = spec.unset ? unsetBadgeSvg : spec.connecting ? connectingBadgeSvg : spec.failed ? failedBadgeSvg : null;
  let over: Buffer | null = null;
  if (badge) {
    const inner = innerPixels(shapeBox);
    const { diameter, inset } = failedBadgePlacement(Math.min(inner.w, inner.h));
    over = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from(badge(diameter)), top: inner.y + inset, left: inner.x + inner.w - diameter - inset }])
      .raw()
      .toBuffer();
  }
  let mask: Uint8Array | null = null;
  if (!fillsBox(shapeBox)) {
    const m = await svgPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${shapePath(shapeBox)}" fill="#fff"/></svg>`, w, h);
    mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = m[i * 4 + 3];
  }

  const movingLayer: Layer = { rgba: movingPx, extent: extentOf(movingPx, w, artH) };
  const art: ValueArt = {
    spec,
    width: w,
    height: h,
    artH,
    under: underPx,
    fill: fill ? { rgba: fill, extent: extentOf(fill, w, artH) } : null,
    reveal: fill ? revealOf(spec, fill, w, artH) : null,
    moving: movingLayer,
    held: { rgba: heldPx, extent: extentOf(heldPx, w, artH) },
    over,
    mask,
    travel: boxTravel({ w, h: artH }, spec.direction),
    faces: new Map(),
  };
  if (spec.kind === 'slider') art.travel = measuredTravel(still, movingLayer, w, artH, spec.direction);
  return art;
}

function revealOf(spec: ValueFaceSpec, fill: Buffer, w: number, h: number): Reveal {
  const at: number[] = [];
  const from: number[] = [];
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (fill[i + 3] === 0) continue;
      at.push(i);
      if (spec.kind === 'slider') from.push(spec.direction === 'horizontal' ? x + 0.5 : h - (y + 0.5));
      else {
        // Degrees from straight up, clockwise, counted on from the start angle.
        let a = (Math.atan2(x + 0.5 - cx, cy - (y + 0.5)) * 180) / Math.PI;
        while (a < spec.angles.start) a += 360;
        from.push(a);
      }
    }
  }
  return { at: Int32Array.from(at), from: Float32Array.from(from) };
}

/** Where the track lies along the axis and how long the thumb is, from what each draws. */
function measuredTravel(track: Buffer | null, thumb: Layer, w: number, h: number, direction: string | undefined): Travel {
  const horizontal = direction === 'horizontal';
  const length = horizontal ? w : h;
  const t = track ? extentOf(track, w, h) : null;
  const start = t ? (horizontal ? t.x0 : h - t.y1) : 0;
  const end = t ? (horizontal ? t.x1 : h - t.y0) : length;
  const e = thumb.extent;
  const thumbLen = e ? (horizontal ? e.x1 - e.x0 : e.y1 - e.y0) : 0;
  return { start, end, thumb: Math.min(thumbLen, Math.max(0, end - start)) };
}

/** Straight-alpha `src` over `dst` at one pixel (byte offsets), scaled by `k` (0–1). */
function blendAt(dst: Buffer, d: number, src: Buffer, s: number, k = 1): void {
  const sa = (src[s + 3] / 255) * k;
  if (sa <= 0) return;
  const da = dst[d + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let c = 0; c < 3; c++) dst[d + c] = Math.round((src[s + c] * sa + dst[d + c] * da * (1 - sa)) / oa);
  dst[d + 3] = Math.round(oa * 255);
}

/**
 * The face at a value (0–1), held or not: the art, the fill or ring up to the
 * level, the thumb or knob in place, the badge, the shape. RGBA, the box's
 * size. The same value again returns the same Buffer.
 */
export function composeValue(art: ValueArt, value: number, held: boolean): Buffer {
  const v = clamp01(value);
  const key = `${Math.round(v * 10000)}|${held ? 1 : 0}`;
  const known = art.faces.get(key);
  if (known) return known;
  const { width: w, artH, spec } = art;
  const out = Buffer.from(art.under);
  const moving = held ? art.held : art.moving;
  if (spec.kind === 'slider') {
    const horizontal = spec.direction === 'horizontal';
    const length = horizontal ? w : artH;
    const level = levelAt(v, art.travel);
    // Shown from the lowest end up to the level line.
    if (art.fill && art.reveal) revealUpTo(out, art.fill.rgba, art.reveal, level);
    const shift = Math.round(thumbOffset(v, art.travel, length));
    const dx = horizontal ? shift : 0;
    const dy = horizontal ? 0 : -shift;
    const e = moving.extent;
    if (e) {
      for (let y = e.y0; y < e.y1; y++) {
        const ty = y + dy;
        if (ty < 0 || ty >= artH) continue;
        for (let x = e.x0; x < e.x1; x++) {
          const tx = x + dx;
          if (tx < 0 || tx >= w) continue;
          blendAt(out, (ty * w + tx) * 4, moving.rgba, (y * w + x) * 4);
        }
      }
    }
  } else {
    const angle = knobAngle(v, spec.angles);
    // The ring from the start angle round to the knob's.
    if (art.fill && art.reveal) revealUpTo(out, art.fill.rgba, art.reveal, angle);
    rotateOver(out, moving, w, artH, angle);
  }
  if (art.over) for (let i = 0; i < out.length; i += 4) blendAt(out, i, art.over, i);
  if (art.mask) for (let p = 0, i = 3; p < art.mask.length; p++, i += 4) out[i] = Math.round((out[i] * art.mask[p]) / 255);
  if (art.faces.size >= 8) art.faces.delete(art.faces.keys().next().value!);
  art.faces.set(key, out);
  return out;
}

function revealUpTo(out: Buffer, rgba: Buffer, reveal: Reveal, level: number): void {
  for (let k = 0; k < reveal.at.length; k++) if (reveal.from[k] <= level) blendAt(out, reveal.at[k], rgba, reveal.at[k]);
}

/** The knob turned `deg` clockwise about the art's centre, sampled bilinearly, over `out`. */
function rotateOver(out: Buffer, layer: Layer, w: number, h: number, deg: number): void {
  const e = layer.extent;
  if (!e) return;
  const cx = w / 2;
  const cy = h / 2;
  // What it can cover turned any way: the circle through its extent's farthest corner.
  const r = Math.max(...[[e.x0, e.y0], [e.x1, e.y0], [e.x0, e.y1], [e.x1, e.y1]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const src = layer.rgba;
  const ys = Math.max(0, Math.floor(cy - r));
  const ye = Math.min(h, Math.ceil(cy + r));
  const xs = Math.max(0, Math.floor(cx - r));
  const xe = Math.min(w, Math.ceil(cx + r));
  const r2 = (r + 1) * (r + 1);
  for (let y = ys; y < ye; y++) {
    const uy = y + 0.5 - cy;
    for (let x = xs; x < xe; x++) {
      const ux = x + 0.5 - cx;
      if (ux * ux + uy * uy > r2) continue;
      // Where this pixel came from before the turn.
      const sx = cos * ux + sin * uy + cx - 0.5;
      const sy = -sin * ux + cos * uy + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < e.x0 - 1 || y0 < e.y0 - 1 || x0 >= e.x1 || y0 >= e.y1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      let a = 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let j = 0; j < 4; j++) {
        const qx = x0 + (j & 1);
        const qy = y0 + (j >> 1);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const i = (qy * w + qx) * 4;
        const qa = src[i + 3];
        if (qa === 0) continue;
        const wt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy) * qa;
        a += wt;
        cr += src[i] * wt;
        cg += src[i + 1] * wt;
        cb += src[i + 2] * wt;
      }
      if (a < 0.5) continue;
      // Over what is there, straight alpha.
      const d = (y * w + x) * 4;
      const sa = a / 255;
      const da = out[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      const k = da * (1 - sa);
      out[d] = (cr / a) * (sa / oa) + out[d] * (k / oa) + 0.5;
      out[d + 1] = (cg / a) * (sa / oa) + out[d + 1] * (k / oa) + 0.5;
      out[d + 2] = (cb / a) * (sa / oa) + out[d + 2] * (k / oa) + 0.5;
      out[d + 3] = oa * 255 + 0.5;
    }
  }
}
