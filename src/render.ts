import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { builtinIconPath, builtinRefPath, type BuiltinIcon } from './builtin-icons.js';
import { DEFAULTS, expandPath } from './config.js';
import { connectingBadgeSvg, failedBadgePlacement, failedBadgeSvg, unsetBadgeSvg } from './failed-badge.js';
import { clearLabelWidths, escapeXml, fitLine, labelStyle } from './label-fit.js';
import { coverScale, drawnSize, type Size } from './icon-scale.js';
import { IMAGE_FORMATS, refusalText, sideRefusal } from './image-limits.js';
import { cornerRadius, fillsBox, innerPixels, shapeName, shapePath } from './shapes.js';
import { readIconFile } from './icon-file.js';
import type { Display } from './types.js';

/**
 * Any image file sharp can read (png, jpg, webp…) comes back as a raw RGBA
 * buffer at the key size for whichever deck asked. No import step: the config
 * holds a path, so editing the file on disk updates the button. Built-in
 * icons (builtin-icons.ts) are files too, named rather than given by path.
 */

const cache = new Map<string, Buffer>();
const MAX_CACHE = 512;
const warnedMissing = new Set<string>();

/**
 * The label, each line fitted to the key on its own (label-fit.ts), so a short
 * line keeps its full text beside a long one. Laid out in a box `width` wide
 * and `height` high: a key's whole face, or a shaped control's largest inner
 * rectangle (shapes.ts innerRect) — the same rule either way.
 */
async function labelSvg(display: Display, width: number, height: number = width): Promise<Buffer> {
  const fontSize = display.labelSize;
  const given = (display.label ?? '').split('\n').filter((l) => l.length > 0);
  if (given.length === 0) return Buffer.alloc(0);
  const lines = await Promise.all(given.map((line) => fitLine(line, fontSize, width, display.labelFont)));

  const lineHeight = Math.round(fontSize * 1.15);
  const block = lineHeight * lines.length;

  let firstBaseline: number;
  if (display.labelPosition === 'top') {
    firstBaseline = fontSize + 2;
  } else if (display.labelPosition === 'center') {
    firstBaseline = Math.round((height - block) / 2) + fontSize;
  } else {
    firstBaseline = height - block + fontSize - 2;
  }

  const tspans = lines
    .map((line, i) => {
      const y = firstBaseline + i * lineHeight;
      return `<text x="${width / 2}" y="${y}" text-anchor="middle" class="lbl">${escapeXml(line)}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>
    ${labelStyle(fontSize, display.labelColor, display.labelFont)}
  </style>
  ${tspans}
</svg>`;

  return Buffer.from(svg);
}

/**
 * A live level (Display.level): one line at the top of the key — the
 * bottom when the label is at the top — in the label's style and size,
 * fitted as a label line is. Never moves the label.
 */
async function levelSvg(display: Display, width: number, height: number = width): Promise<Buffer> {
  if (!display.level) return Buffer.alloc(0);
  const fontSize = display.labelSize;
  const line = await fitLine(display.level, fontSize, width, display.labelFont);
  const baseline = display.labelPosition === 'top' ? height - 2 - Math.round(fontSize * 0.15) : fontSize + 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>
    ${labelStyle(fontSize, display.labelColor, display.labelFont)}
  </style>
  <text x="${width / 2}" y="${baseline}" text-anchor="middle" class="lbl">${escapeXml(line)}</text>
</svg>`);
}

/** An icon layer at 40% opacity: a key whose integration is not set up, as app-launch-unset is drawn. */
function dimmed(layer: Buffer): Promise<Buffer> {
  return sharp(layer).ensureAlpha().linear([1, 1, 1, 0.4], [0, 0, 0, 0]).png().toBuffer();
}

async function iconStamp(iconPath: string): Promise<string> {
  try {
    const st = await fs.stat(iconPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * An icon drawn for a box (src/icon-scale.ts): at `scale` percent — 100, the
 * whole image fitting the box, centred — on a clear layer the box's size,
 * anything beyond the box cut away (the shape's mask cuts the rest).
 * `'cover'` is the retired crop, kept as coverScale() of this image.
 *
 * Throws, with the reason, if the file may not be read (icon-file.ts: not a
 * regular file, too large, in the state directory), cannot be read, or — for
 * an icon the person set, `limits` — is outside the image limits
 * (image-limits.ts: PNG, JPEG, WebP, GIF or SVG, 4096 px on the longer side),
 * or is not an image sharp can decode.
 */
async function iconLayer(filePath: string, box: Size, scale: number | 'cover', limits: boolean): Promise<Buffer> {
  const { data } = await readIconFile(filePath, { image: false });
  // Only the first frame of an animated image, as a background's.
  let meta;
  try {
    meta = await sharp(data, { animated: false }).metadata();
  } catch {
    throw new Error(refusalText(filePath, { kind: 'not-an-image' }));
  }
  if (limits) {
    if (!meta.format || !IMAGE_FORMATS.includes(meta.format)) throw new Error(refusalText(filePath, { kind: 'not-an-image' }));
    const side = sideRefusal(meta.width ?? 0, meta.height ?? 0);
    if (side) throw new Error(refusalText(filePath, side));
  }
  const image = { width: meta.width ?? 1, height: meta.height ?? 1 };
  const percent = scale === 'cover' ? coverScale(image, box) : scale;
  const drawn = drawnSize(image, box, percent);
  let layer = sharp(await sharp(data, { animated: false }).resize(drawn.width, drawn.height, { fit: 'fill' }).png().toBuffer());
  // Larger than the box: only the box's middle is ever seen.
  if (drawn.width > box.width || drawn.height > box.height) {
    const width = Math.min(drawn.width, box.width);
    const height = Math.min(drawn.height, box.height);
    layer = sharp(await layer.extract({ left: Math.floor((drawn.width - width) / 2), top: Math.floor((drawn.height - height) / 2), width, height }).png().toBuffer());
  }
  const w = Math.min(drawn.width, box.width);
  const h = Math.min(drawn.height, box.height);
  if (w === box.width && h === box.height) return layer.png().toBuffer();
  const left = Math.floor((box.width - w) / 2);
  const top = Math.floor((box.height - h) / 2);
  return layer
    .extend({ top, bottom: box.height - h - top, left, right: box.width - w - left, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** Built-in icons resized per key size, kept for the life of the process: they change only when the app is updated, which restarts it. */
const builtinLayers = new Map<string, Buffer>();
const warnedBuiltin = new Set<string>();

/** A built-in icon drawn for a box (iconLayer), or null (logged once) if the file cannot be drawn — an incomplete install. */
async function builtinLayer(name: BuiltinIcon, box: Size, percent: number): Promise<Buffer | null> {
  const filePath = builtinIconPath(name);
  const key = `${filePath}|${box.width}x${box.height}|${percent}`;
  const hit = builtinLayers.get(key);
  if (hit) return hit;
  try {
    const layer = await iconLayer(filePath, box, percent, false);
    builtinLayers.set(key, layer);
    return layer;
  } catch (err) {
    if (!warnedBuiltin.has(filePath)) {
      warnedBuiltin.add(filePath);
      console.error(`[render] cannot read built-in icon ${filePath}: ${(err as Error).message} — is the install complete?`);
    }
    return null;
  }
}

/** A square face filled out to a screen that is not square, by the face itself: the same face gives the same Buffer. */
const filled = new WeakMap<Buffer, Map<string, Buffer>>();

/**
 * A face rendered `side` × `side`, filled out to a key's screen of `width` ×
 * `height` in the key's background, centred — for screens that are not
 * square (a Stream Deck Studio's are 144×112). A square screen gets the face
 * back unchanged. Cached by the face's own Buffer, so an unchanged face is
 * the same Buffer and the deck skips the write, as renderButton's cache does.
 */
export async function fillScreen(face: Buffer, side: number, width: number, height: number, background: string): Promise<Buffer> {
  if (width === side && height === side) return face;
  const key = `${width}x${height}|${background}`;
  const known = filled.get(face)?.get(key);
  if (known) return known;
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const out = await sharp(face, { raw: { width: side, height: side, channels: 4 } })
    .extend({ left, right: width - side - left, top, bottom: height - side - top, background })
    .raw()
    .toBuffer();
  let sizes = filled.get(face);
  if (!sizes) {
    sizes = new Map();
    filled.set(face, sizes);
  }
  sizes.set(key, out);
  return out;
}

/**
 * Render a button to a raw RGBA buffer of `size` x `size`.
 *
 * An icon that is set but cannot be drawn — the file is gone, unreadable, or
 * not an image — is normally drawn as the built-in 'missing' icon, with one
 * log line. With `strictIcon` it throws instead, and skips
 * the cache (which may hold an earlier placeholder render): the control
 * socket's preview uses this to tell the editor the file is bad.
 */
export function renderButton(display: Display, size: number, strictIcon = false): Promise<Buffer> {
  return renderFace(display, { width: size, height: size }, strictIcon);
}

/** A face's box: its size in pixels, and on a virtual deck its shape (shapes.ts). */
export interface FaceBox {
  width: number;
  height: number;
  shape?: string;
  radius?: number;
  /** A virtual deck's control: drawn with its outline (OUTLINE_PX), never a Stream Deck's key. */
  outline?: boolean;
}

/**
 * A virtual deck's button outline (Ryan, 2026-11-20): a thin, light line on
 * the shape's edge, **inside the shape**, so the touch area and what overlaps
 * it are unchanged. One rule for every shape and every page, custom or a
 * preset grid; a Stream Deck's key has none. Always on for now. White at the
 * editor's own outline opacity (styles.css, .key-outline), 2 canvas pixels.
 */
export const OUTLINE_PX = 2;
const OUTLINE_OPACITY = 0.22;

/**
 * Render a control's face to raw RGBA, `width` × `height` — renderButton()
 * for a box of any size and shape. One rule for every shape (Ryan,
 * 2026-11-18):
 *
 * - **the key's fill covers the whole shape**, solid: no transparency inside
 *   a button, ever;
 * - **the icon is drawn by its scale on the one rule** (icon-scale.ts): at
 *   100% the whole image fits the box, centred, and the shape cuts it;
 * - **the label, a live level and the failed badge are laid out in the
 *   shape's largest inner rectangle** (shapes.ts innerPixels), exactly as on a
 *   key whose face is that rectangle — no branch here knows which shape it is;
 * - **everything outside the shape is fully transparent** (alpha 0), edges
 *   anti-aliased, so the display helper shows the page's background there
 *   (panel/panel.c puts it under every image).
 *
 * A square box with square corners is exactly renderButton()'s key, pixel for
 * pixel: the inner rectangle is the whole face and nothing is cut away.
 */
export async function renderFace(display: Display, box: FaceBox, strictIcon = false): Promise<Buffer> {
  const { width, height } = box;
  const shapeBox = { w: width, h: height, shape: box.shape, radius: box.radius };
  const cut = !fillsBox(shapeBox);
  const inner = innerPixels(shapeBox);
  // `builtin:<name>` names a shipped icon; anything else is a path, `~/` allowed.
  const builtinPath = display.icon ? builtinRefPath(display.icon) : null;
  const builtinSize = display.builtinIconSize ?? DEFAULTS.builtinIconSize;
  const iconPath = display.icon ? (builtinPath ?? expandPath(display.icon)) : undefined;
  const stamp = iconPath ? await iconStamp(iconPath) : 'none';
  const shapeKey = cut ? `|${shapeName(box.shape)}:${cornerRadius(shapeBox)}` : '';
  const cacheKey = `${width}x${height}${shapeKey}${box.outline ? '|outline' : ''}|${stamp}|${JSON.stringify(display)}`;

  if (strictIcon && stamp === 'missing') throw new Error(`cannot read icon ${iconPath}: file not found`);
  const hit = strictIcon ? undefined : cache.get(cacheKey);
  if (hit) return hit;

  let base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: display.background,
    },
  });

  const layers: OverlayOptions[] = [];

  if (iconPath) {
    try {
      // A built-in, by default or chosen by name, at its own size; a file as the person set it.
      // A built-in follows the global size unless the key has its own scale; a file is 100% unless it has one.
      const icon = builtinPath !== null
        ? await iconLayer(builtinPath, box, typeof display.iconScale === 'number' ? display.iconScale : builtinSize, false)
        : await iconLayer(iconPath, box, display.iconScale ?? 100, true);
      layers.push({ input: display.unset ? await dimmed(icon) : icon, top: 0, left: 0 });
    } catch (err) {
      if (strictIcon) throw new Error(`cannot read icon ${iconPath}: ${(err as Error).message}`);
      if (!warnedMissing.has(iconPath)) {
        warnedMissing.add(iconPath);
        console.error(`[render] cannot read icon ${iconPath}: ${(err as Error).message} — showing the missing-icon placeholder`);
      }
      const missing = await builtinLayer('missing', box, builtinSize);
      if (missing) layers.push({ input: missing, top: 0, left: 0 });
    }
  }

  const svg = await labelSvg(display, inner.w, inner.h);
  if (svg.length > 0) layers.push({ input: svg, top: inner.y, left: inner.x });
  const level = await levelSvg(display, inner.w, inner.h);
  if (level.length > 0) layers.push({ input: level, top: inner.y, left: inner.x });

  // The outline: a stroke twice as wide as wanted, centred on the edge, of
  // which only the inner half survives — the outer half is cut by the shape's
  // mask below, or falls outside the image for a box with square corners. So
  // it is inside every shape by one rule. Under the badge, which is inside it.
  if (box.outline) {
    const outline = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${shapePath(shapeBox)}" fill="none" stroke="#fff" stroke-opacity="${OUTLINE_OPACITY}" stroke-width="${OUTLINE_PX * 2}"/></svg>`;
    layers.push({ input: Buffer.from(outline), top: 0, left: 0 });
  }

  // Last, so it is over the label as well as the icon. `failed` is part of the
  // cache key (JSON.stringify(display), above), so a marked face and a clean
  // one are two entries and never stand in for each other.
  // Not set up says why the key cannot work, so it stands in for a failure mark;
  // connecting says it will work in a moment, so it does too, until connected.
  // At the top-right of the inner rectangle, so it is inside every shape.
  const badge = display.unset ? unsetBadgeSvg : display.connecting ? connectingBadgeSvg : display.failed ? failedBadgeSvg : null;
  if (badge) {
    const { diameter, inset } = failedBadgePlacement(Math.min(inner.w, inner.h));
    layers.push({ input: Buffer.from(badge(diameter)), top: inner.y + inset, left: inner.x + inner.w - diameter - inset });
  }

  // The shape cuts everything else away: alpha 0 outside it, anti-aliased at its edge.
  if (cut) {
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${shapePath(shapeBox)}" fill="#fff"/></svg>`;
    layers.push({ input: Buffer.from(mask), top: 0, left: 0, blend: 'dest-in' });
  }

  if (layers.length > 0) base = base.composite(layers);

  let buffer: Buffer = await base.raw().toBuffer();
  if (display.pressed) buffer = await pressedLook(buffer, width, height);

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, buffer);
  return buffer;
}

/**
 * Touch feedback's pressed look (Ryan, 2026-11-17; board 25a): the face
 * lightened and drawn at 95%, centred, clear around it, so it stays inside its
 * own shape with its outline, and the page's background shows in the gap.
 */
export const PRESSED_SCALE = 0.95;
const PRESSED_LIGHTEN = 0.22;

async function pressedLook(face: Buffer, width: number, height: number): Promise<Buffer> {
  const light = Buffer.from(face);
  for (let i = 0; i < light.length; i += 4) {
    for (let c = 0; c < 3; c++) light[i + c] = Math.round(light[i + c] + (255 - light[i + c]) * PRESSED_LIGHTEN);
  }
  const w = Math.max(1, Math.round(width * PRESSED_SCALE));
  const h = Math.max(1, Math.round(height * PRESSED_SCALE));
  const left = Math.floor((width - w) / 2);
  const top = Math.floor((height - h) / 2);
  return sharp(light, { raw: { width, height, channels: 4 } })
    .resize(w, h, { fit: 'fill' })
    .extend({ top, bottom: height - h - top, left, right: width - w - left, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer();
}

export function clearRenderCache(): void {
  cache.clear();
  warnedMissing.clear();
  builtinLayers.clear();
  warnedBuiltin.clear();
  clearLabelWidths();
}

/**
 * A whole screen of text, white on black, centred: what a virtual deck's
 * screen shows while it is being paired ("Tap this screen"). Raw RGBA,
 * `width` × `height`. Not cached: it is drawn once per pairing.
 */
export async function renderMessage(lines: string[], width: number, height: number): Promise<Buffer> {
  const size = Math.max(12, Math.round(Math.min(height / 6, width / 16)));
  const lineHeight = Math.round(size * 1.3);
  const top = Math.round(height / 2 - (lineHeight * (lines.length - 1)) / 2);
  const text = lines
    .map((line, i) => `<text x="50%" y="${top + i * lineHeight}" font-size="${i === 0 ? size : Math.round(size * 0.6)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><g fill="#fff" font-family="sans-serif">${text}</g></svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}
