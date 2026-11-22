import { coverScale, type Size } from './icon-scale.js';
import type { ButtonDef, Config, PanelDef } from './types.js';

/**
 * `iconFit` retired (Ryan, 2026-11-22): a key's `iconScale` replaces it, on
 * one rule (src/icon-scale.ts). Configs from before carry `"version"` absent;
 * the editor writes `2` when it converts one, so a file icon with no
 * `iconScale` means 100% only in a config that says so — in an older one it
 * means today's crop, `cover`, the old default.
 *
 * The conversion, as Ryan set it: where `cover` applied to an image, the
 * number that keeps its look (coverScale: a square image's is 100, written as
 * nothing), kept to 200%; `contain` becomes 100%, written as nothing.
 *
 * - **The daemon** reads an older config through legacyIconFit(), in memory
 *   only (it never writes config.json): each key's fit made explicit, so the
 *   renderer draws `cover` as coverScale of the image it has — the old look —
 *   until the editor converts the file.
 * - **The editor** converts it with migrateIconFit() when it opens the file,
 *   with each icon's size read from the file, and saves it.
 */

export const CONFIG_VERSION = 2;

function* buttonsOf(config: Config): Generator<{ button: ButtonDef; id: string; panel: PanelDef | undefined }> {
  for (const profile of Object.values(config.profiles ?? {})) {
    for (const layout of Object.values(profile.layouts ?? {})) {
      for (const page of Object.values(layout.pages ?? {})) {
        for (const [id, button] of Object.entries(page.buttons ?? {})) yield { button, id, panel: page.panel };
      }
    }
  }
}

/** An icon that is an image file the person chose: not a built-in, not none. */
export function isIconFile(icon: unknown): icon is string {
  return typeof icon === 'string' && icon !== '' && !icon.startsWith('builtin:');
}

/**
 * The daemon's reading of an older config, in place: every key's fit made
 * explicit (its own, else `defaults.iconFit`, else `cover`) unless it has an
 * `iconScale`; a converted config's leftover `iconFit` dropped. Returns
 * whether anything changed.
 */
export function legacyIconFit(config: Config): boolean {
  let changed = false;
  const fallback = config.defaults?.iconFit ?? 'cover';
  for (const { button } of buttonsOf(config)) {
    if (config.version === CONFIG_VERSION || button.iconScale !== undefined) {
      if (button.iconFit !== undefined) {
        delete button.iconFit;
        changed = true;
      }
    } else if (button.iconFit === undefined) {
      button.iconFit = fallback;
      changed = true;
    }
  }
  if (config.defaults?.iconFit !== undefined) {
    delete config.defaults.iconFit;
    changed = true;
  }
  return changed;
}

/** The icon files an older config needs the size of to be converted: none for a converted one. */
export function iconFilesToSize(config: Config): string[] {
  if (config.version === CONFIG_VERSION) return [];
  const paths = new Set<string>();
  for (const { button } of buttonsOf(config)) if (isIconFile(button.icon)) paths.add(button.icon);
  return [...paths];
}

/**
 * Convert an older config, in place (the editor's, when it opens the file):
 * `sizeOf` gives an icon file's pixel size, or null for one that cannot be
 * read — drawn at 100% from then, as it would be once it can. Returns whether
 * anything changed; a converted config is left alone.
 */
export function migrateIconFit(config: Config, sizeOf: (icon: string) => Size | null): boolean {
  if (config.version === CONFIG_VERSION) return false;
  const fallback = config.defaults?.iconFit ?? 'cover';
  for (const { button, id, panel } of buttonsOf(config)) {
    const fit = button.iconFit ?? fallback;
    delete button.iconFit;
    if (button.iconScale !== undefined || fit !== 'cover' || !isIconFile(button.icon)) continue;
    const size = sizeOf(button.icon);
    if (!size) continue;
    // A virtual deck's control has its own box; a Stream Deck's key is square.
    const control = panel?.controls.find((c) => c.id === id);
    const box = control ? { width: control.w, height: control.h } : { width: 1, height: 1 };
    const scale = coverScale(size, box);
    if (scale !== 100) button.iconScale = scale;
  }
  if (config.defaults) delete config.defaults.iconFit;
  config.version = CONFIG_VERSION;
  return true;
}
