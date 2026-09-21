import { BUILTIN_ICONS, type BuiltinIcon } from '../../../src/default-icons.js';

/** The scheme main serves icon files on (src/main/icon-protocol.ts). No Node imports: the renderer uses this module. */
export const ICON_SCHEME = 'deckhand-icon';

/**
 * How a key names a built-in icon: `builtin:<name>`.
 * The same string as BUILTIN_PREFIX in src/builtin-icons.ts, which the renderer
 * cannot import (it uses node:path); test/icon-picker.test.ts checks they agree.
 */
export const BUILTIN_PREFIX = 'builtin:';

/**
 * The icon picker's pinned "Built-in" section, as a folder: the
 * picker's place, history and listing carry this in place of a path. A label,
 * not a second browser — the same grid, filter and navigation as any folder.
 */
export const BUILTIN_FOLDER = BUILTIN_PREFIX;

/**
 * The icons of a state pair, kept on the action: `audio.micMute`
 * and `audio.mute` swap between muted and unmuted, a play/pause
 * `media.control` between playing and paused. The daemon draws whichever
 * matches the state, and falls back to the key's own icon, then the default.
 */
export const PAIR_ICON_FIELDS = ['iconMuted', 'iconUnmuted', 'iconPlaying', 'iconPaused', 'iconOn', 'iconOff'] as const;
export type PairIconField = (typeof PAIR_ICON_FIELDS)[number];

/**
 * Whether a value names a pair icon. The one test for it: main's icon
 * handler accepts exactly these, and export and import carry exactly these
 * (ICON_FIELDS in backup.ts is built from the same list), so a field added
 * above reaches all three.
 */
export function isPairIconField(value: unknown): value is PairIconField {
  return (PAIR_ICON_FIELDS as readonly unknown[]).includes(value);
}

/** Which pair icons an action has; none for every other action. */
export function pairIconFields(action: { type: string; method?: unknown } | undefined): readonly PairIconField[] {
  if (!action) return [];
  if (action.type === 'audio.micMute' || action.type === 'audio.mute') return ['iconMuted', 'iconUnmuted'];
  if (action.type === 'media.control' && String(action.method ?? 'playpause').toLowerCase() === 'playpause') return ['iconPlaying', 'iconPaused'];
  // The latching toggle: held down and released.
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
