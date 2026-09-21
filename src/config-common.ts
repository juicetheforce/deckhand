import type { Config, Defaults, LayoutDef } from './types.js';

/**
 * The parts of the config rules that need no file system: display defaults
 * and how page and profile references resolve. Imports nothing but types, so
 * the editor's renderer can use the daemon's own rules rather than a copy
 * config.ts re-exports everything here.
 */

export const DEFAULTS: Required<Defaults> = {
  background: '#101014',
  labelColor: '#ffffff',
  labelSize: 14,
  labelPosition: 'bottom',
  iconFit: 'cover',
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
