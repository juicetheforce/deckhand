import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Icons that belong to the app, not to the user's icon tree
 * (docs/scope.md §3): shipped in the repo's assets/icons/, copied into the
 * app directory by scripts/install.sh, and referenced here by name.
 *
 * A built-in's path never goes in config.json. The app directory is replaced
 * on every update and deleted on uninstall, so a config pointing into it
 * would break. The daemon draws a built-in only as a fallback:
 *
 *   - 'missing' — a key whose icon is set but cannot be drawn (the file is
 *     gone, unreadable, or not an image sharp can read). Built in M4 phase A.
 *   - Phase C adds each action's default icon, drawn when no icon is set.
 *     Add its name to BuiltinIcon and its file to assets/icons/.
 */
export type BuiltinIcon = 'missing';

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
