/**
 * Which files are images, for every place that reads an icon: the daemon's
 * renderer, the editor's icon protocol, its picker and its export. Import-free,
 * so the editor's sandboxed renderer can import it too (like default-icons.ts).
 * Reading a file, and what may be read at all, is src/icon-file.ts.
 */

/**
 * Image files Deckhand shows, by extension, with the content type the
 * editor's icon protocol serves them as. Only formats both sides can draw: Chromium (the
 * thumbnail) and the daemon's sharp (the deck). sharp also reads TIFF and
 * HEIF, which Chromium cannot show, so those are left out.
 *
 * The icon picker lists only these and silently leaves everything else out.
 */
export const ICON_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** The file's extension, lower-cased, including the dot ("" if none). No Node path module: the renderer uses it. */
export function iconExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return dot > slash + 1 ? fileName.slice(dot).toLowerCase() : '';
}

export function isShownIcon(fileName: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_CONTENT_TYPES, iconExtension(fileName));
}

/**
 * The content type of an icon file without one of the shown extensions, from
 * its first bytes: one of ICON_CONTENT_TYPES' formats, or null. For app icons
 * in practice — a desktop entry's `Icon=` can be any path, and Gear Lever, for
 * one, keeps AppImage icons as `~/AppImages/.icons/<name>` with no extension.
 * The deck draws those anyway (sharp reads the content); this lets the editor
 * show them too. A file with a shown extension is judged by it alone, and
 * the icon picker still lists only those.
 */
export function sniffIconType(head: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const ascii = (from: number, text: string) => [...text].every((c, i) => head[from + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  // SVG is text: an <svg element near the start, after any XML declaration,
  // comments or doctype. Read as Latin-1, which is enough to find it.
  const text = String.fromCharCode(...head.subarray(0, 1024));
  if (/^(\uFEFF|\xEF\xBB\xBF)?\s*</.test(text) && /<svg[\s>]/.test(text)) return 'image/svg+xml';
  return null;
}
