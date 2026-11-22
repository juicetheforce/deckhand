/**
 * The limits on an image Deckhand draws over a whole area — a page's
 * background now; icons and slider or dial art as round 4 and 5 bring them
 * in (scope §7, "Icons and appearance": the same for all): PNG, JPEG, WebP,
 * GIF or SVG, at most 10 MB, at most 4096 px on its longer side. A refused
 * image says why, with the file's own numbers, in the same words everywhere —
 * the daemon's log and the editor. Import-free, so the editor's renderer can
 * use it too.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;

/** The formats, by what sharp's metadata calls them (svg as "svg"). */
export const IMAGE_FORMATS: readonly string[] = ['png', 'jpeg', 'webp', 'gif', 'svg'];

export type ImageRefusal =
  | { kind: 'too-big'; bytes: number }
  | { kind: 'too-large'; width: number; height: number }
  | { kind: 'not-an-image' }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

/** The file's name, the last part of its path. */
function nameOf(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

/** One line saying why an image was refused (the boards' 25c). */
export function refusalText(filePath: string, refusal: ImageRefusal): string {
  const name = nameOf(filePath);
  switch (refusal.kind) {
    case 'too-big':
      return `${name} is too big: ${(refusal.bytes / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`;
    case 'too-large':
      return `${name} is too large: ${refusal.width} × ${refusal.height} px. The limit is ${MAX_IMAGE_SIDE} px on the longer side.`;
    case 'not-an-image':
      return `${name} isn't a PNG, JPEG, WebP, GIF or SVG.`;
    case 'missing':
      return `${name} isn't there any more.`;
    case 'unreadable':
      return `${name} can't be read.`;
  }
}

/** Whether an image of this size is within the limit, and the refusal if not. */
export function sideRefusal(width: number, height: number): ImageRefusal | null {
  return Math.max(width, height) > MAX_IMAGE_SIDE ? { kind: 'too-large', width, height } : null;
}
