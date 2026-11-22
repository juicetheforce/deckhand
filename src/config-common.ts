import type { Config, Defaults, LayoutDef } from './types.js';

/**
 * The parts of the config rules that need no file system: display defaults
 * and how page and profile references resolve. Imports nothing but types, so
 * the editor's renderer can use the daemon's own rules rather than a copy
 * config.ts re-exports everything here.
 */

/**
 * What a `buttons` key may be: a control id (src/devices.ts). A Stream
 * Deck's key 7 is "7", as every config has always said; a virtual deck's
 * controls have ids of their own. No ":" — the socket's preview slots and the
 * failure marks join ids with one.
 */
export const CONTROL_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Icon size (Settings › General): `defaults.builtinIconSize`, a percent of the
 * control on the one rule of a key's icon scale (src/icon-scale.ts), **shown as
 * that same figure** (Ryan, 2026-11-22; until then the slider showed 70 as
 * 100%). 25–100 in steps of 5 — 100 is a built-in filling the key, settable
 * for every key at once, not only per key (Ryan, 2026-11-22); 45.5 by default,
 * shown rounded as 46%, as is any in-between value the old slider stored,
 * until the slider is moved.
 */
export const BUILTIN_ICON_SIZE = { min: 25, max: 100, step: 5 } as const;

/**
 * A label font's name: what goes into the key's SVG style as a quoted CSS
 * string, so nothing that could end the string, the style or the element.
 * Family names do not use them.
 */
export function validFontName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && name.length <= 100 && !/[\x00-\x1f\x7f"'\\<>&;{}]/.test(name);
}

/**
 * The CSS font-family for a label: the chosen family first, then Deckhand's
 * default, so a font that is not installed falls back to it (fontconfig
 * skips a family it does not have). The name is validated (config-common.ts
 * validFontName): nothing in it can end the quoted string.
 */
export function fontFamily(font: string | undefined): string {
  return font ? `'${font}', sans-serif` : 'sans-serif';
}

/** Label size (Settings › General): the slider over `defaults.labelSize`. A key's own size is not limited to it. */
export const LABEL_SIZE = { min: 8, max: 28, step: 1 } as const;

/** Dim to (Settings › General): the slider over `defaults.sleep.dimTo`. */
export const DIM_TO = { min: 5, max: 50, step: 5, default: 20 } as const;

/** Every default resolved; the label font alone may stay unset, meaning Deckhand's own (LABEL_FONT_DEFAULT). `iconFit` is retired (src/icon-fit.ts). */
export type ResolvedDefaults = Required<Omit<Defaults, 'iconFit' | 'labelFont'>> & Pick<Defaults, 'labelFont'>;

/** Deckhand's own label font, used when none is chosen and when the chosen one is not installed. */
export const LABEL_FONT_DEFAULT = 'sans-serif';

export const DEFAULTS: ResolvedDefaults = {
  background: '#101014',
  labelColor: '#ffffff',
  labelSize: 14,
  labelPosition: 'bottom',
  // A built-in's drawing, as a percent of the control: Settings › General ›
  // Icon size (BUILTIN_ICON_SIZE). The editor's grid follows it too.
  builtinIconSize: 45.5,
  touchFeedback: true,
  brightness: 70,
  refreshMs: 1000,
  sleep: { onLock: true },
};

/**
 * Find an entry by ID first, then by its "name". Returns the ID, or null.
 * Validation rejects duplicate names, so a name matches at most one entry.
 */
function resolveRef(entries: Record<string, { name?: string }>, ref: string): string | null {
  if (Object.prototype.hasOwnProperty.call(entries, ref)) return ref;
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.name === ref) return id;
  }
  return null;
}

/** A page's ID from a page ID or name within one layout, or null if there is none. */
export function resolvePage(layout: LayoutDef, ref: string): string | null {
  return resolveRef(layout.pages, ref);
}

/** A profile's ID from a profile ID or name, or null if there is none. */
export function resolveProfile(config: Config, ref: string): string | null {
  return resolveRef(config.profiles, ref);
}

/**
 * The ID of the page a layout starts on. Validation guarantees startPage
 * resolves and pages is not empty. "First" is JavaScript key order, which puts
 * integer-like IDs ("1", "2") ahead of all others.
 */
export function startPageOf(layout: LayoutDef): string {
  if (layout.startPage !== undefined) {
    const id = resolvePage(layout, layout.startPage);
    if (id !== null) return id;
  }
  return Object.keys(layout.pages)[0];
}

/** The ID of the profile the daemon starts on. Same guarantees as startPageOf. */
export function startProfileOf(config: Config): string {
  if (config.startProfile !== undefined) {
    const id = resolveProfile(config, config.startProfile);
    if (id !== null) return id;
  }
  return Object.keys(config.profiles)[0];
}
