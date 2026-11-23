import { protocol } from 'electron';
import { iconFilePath } from './builtin-icons.js';
import { ICON_SCHEME, stretchedSvg } from '../shared/icons.js';
import { IconFileError, readIconFile } from '../../../src/icon-file.js';

/**
 * Serves icon files to the renderer as deckhand-icon://icon/?path=<path>.
 *
 * The renderer is sandboxed and cannot read files, and turning web security
 * off to allow file:// would open far more than images. This serves only
 * files with an image extension Chromium can draw (ICON_CONTENT_TYPES, shared
 * with the icon picker), and any other file whose first bytes are one of
 * those formats (sniffIconType: app icons such as Gear Lever's, which have no
 * extension, or a name like org.example.App that only looks like one);
 * anything else is 404. What may be read at all is the daemon's rule
 * (src/icon-file.ts), checked before reading: a regular file, not too large,
 * never in Deckhand's state directory. Paths are as the config stores
 * them: ~/... is allowed, and builtin:<name> is served from the built-in
 * icon directory (builtinIconDir in src/main/builtin-icons.ts). With
 * `stretch=1`, an SVG is served made to stretch to its box (stretchedSvg), as
 * the deck draws a slider's or dial's stretched layers.
 */

/** Must run before the app is ready. */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ICON_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Must run after the app is ready. */
export function handleIconScheme(): void {
  protocol.handle(ICON_SCHEME, async (request) => {
    const url = new URL(request.url);
    const requested = url.searchParams.get('path');
    if (!requested) return new Response('no path', { status: 400 });
    const filePath = iconFilePath(requested);
    if (filePath === null) return new Response('not a built-in icon', { status: 404 });
    try {
      const { data, type } = await readIconFile(filePath, { image: true });
      // A layer the deck stretches: an SVG told to stretch too (stretchedSvg), or it keeps its proportions.
      if (url.searchParams.get('stretch') === '1' && type === 'image/svg+xml')
        return new Response(stretchedSvg(data.toString('utf8')), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
      return new Response(new Uint8Array(data), { headers: { 'content-type': type as string, 'cache-control': 'no-store' } });
    } catch (err) {
      return new Response(err instanceof IconFileError ? err.reason : 'not found', { status: 404 });
    }
  });
}
