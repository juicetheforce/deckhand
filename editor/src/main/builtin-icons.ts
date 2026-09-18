import { existsSync } from 'node:fs';
import path from 'node:path';
import { expandPath } from '../../../src/config.js';
import { BUILTIN_PREFIX, builtinName } from '../shared/icons.js';

/**
 * Where the built-in icons are read from. The first of these that applies:
 *
 *   1. DECKHAND_BUILTIN_ICONS — the same override the daemon honours
 *      (src/builtin-icons.ts). The checks set it, so they never depend on
 *      what is installed.
 *   2. The installed daemon's `$XDG_DATA_HOME/deckhand/assets/icons`, if it
 *      exists. Decided by the maintainer for Ship (scope §7, §10): one set of files,
 *      shipped by one installer and already on disk, rather than asking the
 *      daemon over the socket.
 *   3. `assets/icons/` in the checkout, beside `editor/` — the editor's
 *      bundled `dist/main/` (and the tests' `dist/test/`) is three levels
 *      below it. Used when no daemon is installed.
 *
 * The installed editor lives at `$XDG_DATA_HOME/deckhand/editor/`, inside the
 * daemon's app directory (scripts/install.sh), so for it 2 and 3 are the same
 * directory: it always shows exactly the icons the installed daemon draws.
 *
 * **In a checkout on a machine with the daemon installed, 2 wins.** The
 * development editor then shows the *installed* daemon's icons, not the
 * repo's. That is deliberate — it matches what the deck draws — but it means
 * an icon redrawn in the repo's `assets/icons/` keeps its old look in the
 * development editor, and a newly added one shows as missing, until
 * `scripts/install.sh update` has run. Not a bug.
 * To preview repo icons before installing, start the editor with
 * DECKHAND_BUILTIN_ICONS pointing at the repo's `assets/icons`.
 *
 * Read on every call, as the daemon's is, so an install or update while the
 * editor is open is picked up and a test can change the environment.
 */
export function builtinIconDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DECKHAND_BUILTIN_ICONS) return env.DECKHAND_BUILTIN_ICONS;

  const dataHome = env.XDG_DATA_HOME || path.join(env.HOME ?? '', '.local', 'share');
  const installed = path.join(dataHome, 'deckhand', 'assets', 'icons');
  if (existsSync(installed)) return installed;

  return CHECKOUT_BUILTIN_ICON_DIR;
}

/** Step 3 above: `assets/icons/` three levels above the bundled file. */
export const CHECKOUT_BUILTIN_ICON_DIR = path.resolve(import.meta.dirname, '../../../assets/icons');

/**
 * The file an icon from the config means: a `builtin:<name>` in the built-in
 * directory, or a path with `~` expanded. Null for a built-in name this
 * editor's BUILTIN_ICONS does not list, which the editor shows as missing.
 */
export function iconFilePath(configPath: string, builtinDir: string = builtinIconDir()): string | null {
  if (!configPath.startsWith(BUILTIN_PREFIX)) return expandPath(configPath);
  const name = builtinName(configPath);
  return name === null ? null : path.join(builtinDir, `${name}.svg`);
}
