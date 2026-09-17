import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuiltinIcon } from './default-icons.js';

export type { BuiltinIcon } from './default-icons.js';

/**
 * Icons that belong to the app, not to the user's icon tree
 * (docs/scope.md §3): shipped in the repo's assets/icons/, copied into the
 * app directory by scripts/install.sh, and referenced here by name.
 *
 * A built-in's path never goes in config.json. The app directory is replaced
 * on every update and deleted on uninstall, so a config pointing into it
 * would break. The daemon draws a built-in in three cases:
 *
 *   - 'missing' — a key whose icon is set but cannot be drawn (the file is
 *     gone, unreadable, or not an image sharp can read). M4 phase A.
 *   - an action's default, when the key has no icon set
 *     (src/default-icons.ts). M4 phase C1.
 *   - a key whose icon is `builtin:<name>` — a name, not a path, so it
 *     survives updates (§7 C1 call 5). What the icon picker writes for a
 *     built-in from phase C2.
 */

/** The prefix of an icon that names a built-in rather than a file. */
export const BUILTIN_PREFIX = 'builtin:';

/** How a built-in is written as an icon: `builtin:<name>`. */
export function builtinIconRef(name: BuiltinIcon): string {
  return `${BUILTIN_PREFIX}${name}`;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * assets/icons/ beside dist/ — the same layout in the checkout and in the
 * installed app directory (as helper/ is found in src/input.ts).
 * DECKHAND_BUILTIN_ICONS overrides it, for tests. Read on every call so a
 * test can change it after this module is loaded.
 */
export function builtinIconDir(): string {
  return process.env.DECKHAND_BUILTIN_ICONS ?? path.resolve(HERE, '..', 'assets', 'icons');
}

export function builtinIconPath(name: BuiltinIcon): string {
  return path.join(builtinIconDir(), `${name}.svg`);
}

/** A built-in's name: lowercase letters, digits and hyphens, so a reference can never climb out of the directory. */
const BUILTIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The file a `builtin:<name>` icon means, or null if `icon` is not one.
 *
 * Any well-formed name is looked up as a file, not only the names in
 * BUILTIN_ICONS: an icon drawn later needs its file, not a code change, to be
 * chosen for a key. A name with no file — or a malformed one, which is given a
 * path that cannot exist — is a broken icon like any other, and draws
 * `missing` (§3).
 */
export function builtinRefPath(icon: string): string | null {
  if (!icon.startsWith(BUILTIN_PREFIX)) return null;
  const name = icon.slice(BUILTIN_PREFIX.length);
  if (!BUILTIN_NAME.test(name)) return path.join(builtinIconDir(), 'not a built-in name', encodeURIComponent(name));
  return path.join(builtinIconDir(), `${name}.svg`);
}
