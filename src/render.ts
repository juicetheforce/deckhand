import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { builtinIconPath, builtinRefPath, type BuiltinIcon } from './builtin-icons.js';
import { expandPath } from './config.js';
import { failedBadgePlacement, failedBadgeSvg } from './failed-badge.js';
import type { Display } from './types.js';

/**
 * Feed it any image file — png, jpg, webp, whatever Midjourney or a Google
 * image search hands you — and it comes back as a raw RGBA buffer at the
 * key size for whichever deck asked. No import step, no icon library: the
 * config just holds a path, and editing the file on disk updates the button.
 */

const cache = new Map<string, Buffer>();
const MAX_CACHE = 512;
const warnedMissing = new Set<string>();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function labelSvg(display: Display, size: number): Buffer {
  const lines = (display.label ?? '').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return Buffer.alloc(0);

  const fontSize = display.labelSize;
  const lineHeight = Math.round(fontSize * 1.15);
  const block = lineHeight * lines.length;

  let firstBaseline: number;
  if (display.labelPosition === 'top') {
    firstBaseline = fontSize + 2;
  } else if (display.labelPosition === 'center') {
    firstBaseline = Math.round((size - block) / 2) + fontSize;
  } else {
    firstBaseline = size - block + fontSize - 2;
  }

  const tspans = lines
    .map((line, i) => {
      const y = firstBaseline + i * lineHeight;
      return `<text x="${size / 2}" y="${y}" text-anchor="middle" class="lbl">${escapeXml(line)}</text>`;
    })
    .join('');

  // paint-order:stroke draws a dark outline behind the glyphs so light text
  // stays readable over a bright icon.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <style>
    .lbl {
      font-family: sans-serif;
      font-size: ${fontSize}px;
      font-weight: 600;
      fill: ${display.labelColor};
      stroke: rgba(0,0,0,0.75);
      stroke-width: ${Math.max(2, Math.round(fontSize / 6))}px;
      paint-order: stroke;
      stroke-linejoin: round;
    }
  </style>
  ${tspans}
</svg>`;

  return Buffer.from(svg);
}

/** The failed-key badge (Ship piece 6, src/failed-badge.ts), placed over a finished key. */
function failedBadge(size: number): OverlayOptions {
  const { diameter, inset } = failedBadgePlacement(size);
  return { input: Buffer.from(failedBadgeSvg(diameter)), top: inset, left: size - diameter - inset };
}

async function iconStamp(iconPath: string): Promise<string> {
  try {
    const st = await fs.stat(iconPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/** An icon resized to the key. Throws if the file cannot be read or is not an image sharp can decode. */
async function iconLayer(filePath: string, size: number, fit: 'cover' | 'contain'): Promise<Buffer> {
  return sharp(await fs.readFile(filePath))
    .resize(size, size, {
      fit,
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/** Built-in icons resized per key size, kept for the life of the process: they change only when the app is updated, which restarts it. */
const builtinLayers = new Map<string, Buffer>();
const warnedBuiltin = new Set<string>();

/** A built-in icon resized to the key, or null (logged once) if the file cannot be drawn — an incomplete install. */
async function builtinLayer(name: BuiltinIcon, size: number): Promise<Buffer | null> {
  const filePath = builtinIconPath(name);
  const key = `${filePath}|${size}`;
  const hit = builtinLayers.get(key);
  if (hit) return hit;
  try {
    const layer = await iconLayer(filePath, size, 'contain');
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

/**
 * Render a button to a raw RGBA buffer of `size` x `size`.
 *
 * An icon that is set but cannot be drawn — the file is gone, unreadable, or
 * not an image — is normally drawn as the built-in 'missing' icon, with one
 * log line (docs/scope.md §3). With `strictIcon` it throws instead, and skips
 * the cache (which may hold an earlier placeholder render): the control
 * socket's preview uses this to tell the editor the file is bad.
 */
export async function renderButton(display: Display, size: number, strictIcon = false): Promise<Buffer> {
  // `builtin:<name>` names a shipped icon; anything else is a path, `~/` allowed.
  const iconPath = display.icon ? (builtinRefPath(display.icon) ?? expandPath(display.icon)) : undefined;
  const stamp = iconPath ? await iconStamp(iconPath) : 'none';
  const cacheKey = `${size}|${stamp}|${JSON.stringify(display)}`;

  if (strictIcon && stamp === 'missing') throw new Error(`cannot read icon ${iconPath}: file not found`);
  const hit = strictIcon ? undefined : cache.get(cacheKey);
  if (hit) return hit;

  let base = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: display.background,
    },
  });

  const layers: OverlayOptions[] = [];

  if (iconPath) {
    try {
      const icon = await iconLayer(iconPath, size, display.iconFit === 'contain' ? 'contain' : 'cover');
      layers.push({ input: icon, top: 0, left: 0 });
    } catch (err) {
      if (strictIcon) throw new Error(`cannot read icon ${iconPath}: ${(err as Error).message}`);
      if (!warnedMissing.has(iconPath)) {
        warnedMissing.add(iconPath);
        console.error(`[render] cannot read icon ${iconPath}: ${(err as Error).message} — showing the missing-icon placeholder`);
      }
      const missing = await builtinLayer('missing', size);
      if (missing) layers.push({ input: missing, top: 0, left: 0 });
    }
  }

  const svg = labelSvg(display, size);
  if (svg.length > 0) layers.push({ input: svg, top: 0, left: 0 });

  // Last, so it is over the label as well as the icon. `failed` is part of the
  // cache key (JSON.stringify(display), above), so a marked face and a clean
  // one are two entries and never stand in for each other.
  if (display.failed) layers.push(failedBadge(size));

  if (layers.length > 0) base = base.composite(layers);

  const buffer = await base.raw().toBuffer();

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, buffer);
  return buffer;
}

export function clearRenderCache(): void {
  cache.clear();
  warnedMissing.clear();
  builtinLayers.clear();
  warnedBuiltin.clear();
}
