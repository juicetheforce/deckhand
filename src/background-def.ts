import type { PageBackgroundDef } from './types.js';

/**
 * A page's background as it is drawn (types.ts PageBackgroundDef), every
 * field filled in. Import-free: the daemon's renderer (page-background.ts)
 * and the editor's both read a background through this.
 */
export interface ShownBackground {
  color: string;
  image: string | null;
  fit: 'fill' | 'fit';
  opacity: number;
}

export function backgroundOf(bg: PageBackgroundDef | undefined): ShownBackground {
  return {
    color: bg?.color ?? '#000000',
    image: bg?.image ?? null,
    fit: bg?.fit ?? 'fill',
    opacity: bg?.opacity ?? 100,
  };
}

/**
 * Black, opaque, no image: what every page had before backgrounds, and a new
 * page has. The daemon sends nothing for it beyond the canvas frame, so the
 * display helper keeps today's opaque buffer.
 */
export function isPlainBlack(bg: PageBackgroundDef | undefined): boolean {
  const b = backgroundOf(bg);
  return b.image === null && b.opacity === 100 && b.color.toLowerCase() === '#000000';
}
