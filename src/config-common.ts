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
 * Icon size (Settings › General). `defaults.builtinIconSize` is stored as a
 * percent of the key, 28–70; **the slider shows it relative to its largest
 * size** — 70% of the key shown as 100% — from 40 to 100% in steps of 5,
 * 65% (45.5% of the key) by default (Ryan, 2026-10-23, revising Claude
 * Design's 16c). Converted for display only.
 */
export const BUILTIN_ICON_SIZE = {
  /** The largest, as a percent of the key: shown as 100%. */
  largest: 70,
  /** What the slider shows. */
  shown: { min: 40, max: 100, step: 5 },
  /** What `defaults.builtinIconSize` may be: the shown range in percent of the key. */
  min: 28,
  max: 70,
} as const;

/** A stored size (percent of the key) as the slider shows it. */
export function shownIconSize(stored: number): number {
  return Math.round((stored / BUILTIN_ICON_SIZE.largest) * 100);
}

/** A size the slider shows, stored as a percent of the key (to a tenth: 65 → 45.5). */
export function storedIconSize(shown: number): number {
  return Math.round(shown * BUILTIN_ICON_SIZE.largest) / 100;
}

export const DEFAULTS: Required<Defaults> = {
  background: '#101014',
  labelColor: '#ffffff',
  labelSize: 14,
  labelPosition: 'bottom',
  iconFit: 'cover',
  // A built-in's drawing, as a percent of the key: Settings › General › Icon
  // size, which shows it as 65% (BUILTIN_ICON_SIZE). The editor's grid
  // follows it too.
  builtinIconSize: 45.5,
  brightness: 70,
  refreshMs: 1000,
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
