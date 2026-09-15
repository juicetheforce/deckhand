/** The scheme main serves icon files on (src/main/icon-protocol.ts). Import-free: the renderer uses it. */
export const ICON_SCHEME = 'deckhand-icon';

/**
  * The URL the renderer uses to show an icon path from the config.
  *
  * `stamp` (src/main/icon-files.ts: modification time and size, or "missing")
  * makes a changed file a different URL. Without it Chromium keeps showing
  * the image it loaded first, however the file changes on disk.
  */
export function iconUrl(configPath: string, stamp?: string): string {
  const version = stamp === undefined ? '' : `&v=${encodeURIComponent(stamp)}`;
  return `${ICON_SCHEME}://icon/?path=${encodeURIComponent(configPath)}${version}`;
}

/**
 * Image files the editor shows, by extension, with the content type the icon
 * protocol serves them as. Only formats both sides can draw: Chromium (the
 * thumbnail) and the daemon's sharp (the deck). sharp also reads TIFF and
 * HEIF, which Chromium cannot show, so those are left out.
 *
 * The icon picker lists only these and silently leaves everything else out
 * (scope §10: greyed only if cheap, otherwise filtered — filtered, recorded
 * in docs/code-state.md).
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
