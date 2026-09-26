import { promises as fs } from 'node:fs';
import { protocol } from 'electron';
import { iconFilePath } from './builtin-icons.js';
import { ICON_CONTENT_TYPES, ICON_SCHEME, iconExtension, isShownIcon, sniffIconType } from '../shared/icons.js';

/**
 * Serves icon files to the renderer as deckhand-icon://icon/?path=<path>.
 *
 * The renderer is sandboxed and cannot read files, and turning web security
 * off to allow file:// would open far more than images. This serves only
 * files with an image extension Chromium can draw (ICON_CONTENT_TYPES, shared
 * with the icon picker), and any other file whose first bytes are one of
 * those formats (sniffIconType: app icons such as Gear Lever's, which have no
 * extension, or a name like org.example.App that only looks like one);
 * anything else is 404. Paths are as the config stores
 * them: ~/... is allowed, and builtin:<name> is served from the built-in
 * icon directory (builtinIconDir in src/main/builtin-icons.ts).
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
    const filePath = iconFilePath(requested);
    if (filePath === null) return new Response('not a built-in icon', { status: 404 });
    const data = await fs.readFile(filePath).catch(() => null);
    if (data === null) return new Response('not found', { status: 404 });
    const type = isShownIcon(filePath) ? ICON_CONTENT_TYPES[iconExtension(filePath)] : sniffIconType(data);
    if (type === null) return new Response('not an image type the editor shows', { status: 404 });
    return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  });
}
