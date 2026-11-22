import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { expandPath } from './config.js';
import { isInStateDir } from './icon-file.js';
import { IMAGE_FORMATS, MAX_IMAGE_BYTES, refusalText, sideRefusal, type ImageRefusal } from './image-limits.js';
import type { PageBackgroundDef } from './types.js';
import { backgroundOf } from './background-def.js';

export { backgroundOf, isPlainBlack } from './background-def.js';

/**
 * A virtual deck page's background (types.ts PageBackgroundDef), made into
 * what the display helper takes (panel/panel.c's 'G'): a colour with the
 * layer's opacity, and — with an image — a picture of the whole layer at the
 * screen's size, the image fitted over the colour and the opacity applied.
 *
 * Drawn once per page change, a background edit, a brightness change or the
 * screen coming back — never on a clock — and kept by the driver until one of
 * those.
 */

export interface Ground {
  color: [number, number, number];
  /** The layer's opacity, 0–255. */
  alpha: number;
  picture?: { width: number; height: number; rgba: Buffer };
  /** The image was refused: why, said once in the log. The colour is still drawn. */
  refused?: string;
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const alphaOf = (opacity: number) => Math.round((Math.max(0, Math.min(100, opacity)) * 255) / 100);

/** The image's file checked against the limits, before sharp reads it: the refusal, or its bytes. */
async function readImage(filePath: string): Promise<{ data: Buffer } | { refusal: ImageRefusal }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { refusal: { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' } };
  }
  // Not a regular file (a device or FIFO never finishes reading), or in the
  // state directory (credentials.json): the same rule as every icon (icon-file.ts).
  if (!stat.isFile() || (await isInStateDir(filePath))) return { refusal: { kind: 'unreadable' } };
  if (stat.size > MAX_IMAGE_BYTES) return { refusal: { kind: 'too-big', bytes: stat.size } };
  try {
    const data = await fs.readFile(filePath);
    if (data.length > MAX_IMAGE_BYTES) return { refusal: { kind: 'too-big', bytes: data.length } };
    return { data };
  } catch {
    return { refusal: { kind: 'unreadable' } };
  }
}

/** A background's colour and opacity alone, at once: all there is to one with no image. */
export function colorGround(bg: PageBackgroundDef | undefined): Ground {
  const b = backgroundOf(bg);
  return { color: rgbOf(b.color), alpha: alphaOf(b.opacity) };
}

/** Draw a page's background for a screen of width × height pixels. */
export async function renderGround(bg: PageBackgroundDef | undefined, width: number, height: number): Promise<Ground> {
  const b = backgroundOf(bg);
  const { color, alpha } = colorGround(bg);
  if (b.image === null || width <= 0 || height <= 0) return { color, alpha };
  const filePath = expandPath(b.image);
  const read = await readImage(filePath);
  if ('refusal' in read) return { color, alpha, refused: refusalText(filePath, read.refusal) };
  try {
    // Only the first frame of an animated image; sharp's own pixel limit stands as well.
    const image = sharp(read.data, { animated: false });
    const meta = await image.metadata();
    if (!meta.format || !IMAGE_FORMATS.includes(meta.format)) return { color, alpha, refused: refusalText(filePath, { kind: 'not-an-image' }) };
    const side = sideRefusal(meta.width ?? 0, meta.height ?? 0);
    if (side) return { color, alpha, refused: refusalText(filePath, side) };
    const background = { r: color[0], g: color[1], b: color[2], alpha: 1 };
    const { data } = await image
      .resize(width, height, { fit: b.fit === 'fit' ? 'contain' : 'cover', position: 'centre', background })
      // Where the image itself is transparent, the colour shows.
      .flatten({ background })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // One opacity over the whole layer, colour and image alike.
    for (let i = 3; i < data.length; i += 4) data[i] = alpha;
    return { color, alpha, picture: { width, height, rgba: data } };
  } catch {
    return { color, alpha, refused: refusalText(filePath, { kind: 'not-an-image' }) };
  }
}
