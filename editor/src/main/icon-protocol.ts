import { promises as fs } from 'node:fs';
import { protocol } from 'electron';
import { expandPath } from '../../../src/config.js';
import { ICON_CONTENT_TYPES, ICON_SCHEME, iconExtension, isShownIcon } from '../shared/icons.js';

/**
 * Serves icon files to the renderer as deckhand-icon://icon/?path=<path>.
 *
 * The renderer is sandboxed and cannot read files, and turning web security
 * off to allow file:// would open far more than images. This serves only
 * files with an image extension Chromium can draw (ICON_CONTENT_TYPES, shared
 * with the icon picker); anything else is 404. Paths are as the config stores
 * them (~/... allowed).
 */

/** Must run before the app is ready. */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ICON_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Must run after the app is ready. */
export function handleIconScheme(): void {
  protocol.handle(ICON_SCHEME, async (request) => {
    const requested = new URL(request.url).searchParams.get('path');
    if (!requested) return new Response('no path', { status: 400 });
    const filePath = expandPath(requested);
    if (!isShownIcon(filePath)) return new Response('not an image type the editor shows', { status: 404 });
    const type = ICON_CONTENT_TYPES[iconExtension(filePath)];
    try {
      const data = await fs.readFile(filePath);
      return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
