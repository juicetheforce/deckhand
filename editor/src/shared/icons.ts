import { BUILTIN_ICONS, type BuiltinIcon } from '../../../src/default-icons.js';

/** The scheme main serves icon files on (src/main/icon-protocol.ts). No Node imports: the renderer uses this module. */
export const ICON_SCHEME = 'deckhand-icon';

/**
 * How a key names a built-in icon: `builtin:<name>` (scope §7 C1 call 5).
 * The same string as BUILTIN_PREFIX in src/builtin-icons.ts, which the renderer
 * cannot import (it uses node:path); test/icon-picker.test.ts checks they agree.
 */
export const BUILTIN_PREFIX = 'builtin:';

/**
 * The icon picker's pinned "Built-in" section (scope §10), as a folder: the
 * picker's place, history and listing carry this in place of a path. A label,
 * not a second browser — the same grid, filter and navigation as any folder.
 */
export const BUILTIN_FOLDER = BUILTIN_PREFIX;

/**
 * The icons of a state pair, kept on the action (C2 call 4): `audio.micMute`
 * and `audio.mute` swap between muted and unmuted, a play/pause
 * `media.control` between playing and paused. The daemon draws whichever
 * matches the state, and falls back to the key's own icon, then the default.
 */
export type PairIconField = 'iconMuted' | 'iconUnmuted' | 'iconPlaying' | 'iconPaused' | 'iconOn' | 'iconOff';

/** Which pair icons an action has; none for every other action. */
export function pairIconFields(action: { type: string; method?: unknown } | undefined): readonly PairIconField[] {
  if (!action) return [];
  if (action.type === 'audio.micMute' || action.type === 'audio.mute') return ['iconMuted', 'iconUnmuted'];
  if (action.type === 'media.control' && String(action.method ?? 'playpause').toLowerCase() === 'playpause') return ['iconPlaying', 'iconPaused'];
  // M7's latching toggle: down and up (docs/scope.md §6).
  if (action.type === 'toggle') return ['iconOn', 'iconOff'];
  return [];
}

export function builtinRef(name: BuiltinIcon): string {
  return `${BUILTIN_PREFIX}${name}`;
}

/**
 * The built-in an icon names, or null when it is not a `builtin:` reference or
 * names an icon this checkout does not ship. The editor lists built-ins from
 * the checkout it runs from (scope §10), so an unknown name is a broken icon
 * here, as on the deck — which also draws `missing` for it.
 */
export function builtinName(icon: string): BuiltinIcon | null {
  if (!icon.startsWith(BUILTIN_PREFIX)) return null;
  const name = icon.slice(BUILTIN_PREFIX.length);
  return (BUILTIN_ICONS as readonly string[]).includes(name) ? (name as BuiltinIcon) : null;
}

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
