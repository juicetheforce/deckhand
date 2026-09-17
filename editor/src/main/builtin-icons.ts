import path from 'node:path';
import { expandPath } from '../../../src/config.js';
import { BUILTIN_PREFIX, builtinName } from '../shared/icons.js';

/**
 * The built-in icons, read from the checkout the editor runs from:
 * `assets/icons/` beside `editor/`. Scope §10 left open whether the editor
 * lists them from here or asks the daemon; C2 reads the checkout (Claude's
 * recommendation, docs/code-state.md "M4 phase C2") — no new socket command and
 * no daemon change. If the checkout ships an icon the installed daemon does
 * not, the picker's preview is refused (render_failed) and it cannot be chosen.
 *
 * Bundled into dist/main/ (and the tests into dist/test/), both three levels
 * below the repository.
 */
export const BUILTIN_ICON_DIR = path.resolve(import.meta.dirname, '../../../assets/icons');

/**
 * The file an icon from the config means: a `builtin:<name>` in the built-in
 * directory, or a path with `~` expanded. Null for a built-in name this
 * checkout does not ship, which the editor shows as missing.
 */
export function iconFilePath(configPath: string, builtinDir: string = BUILTIN_ICON_DIR): string | null {
  if (!configPath.startsWith(BUILTIN_PREFIX)) return expandPath(configPath);
  const name = builtinName(configPath);
  return name === null ? null : path.join(builtinDir, `${name}.svg`);
}
