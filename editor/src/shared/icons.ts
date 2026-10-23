import { BUILTIN_ICONS, type BuiltinIcon, type IconState } from '../../../src/default-icons.js';
import { hasStates } from '../../../src/state-icons.js';

export { LEGACY_STATE_ICON_FIELDS } from '../../../src/state-icons.js';

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
 * Keys with states (src/state-icons.ts; scope §10, the pattern for every
 * multi-state key): two icons — **"Default icon"**, the key's own `icon`, its
 * normal look; and one for its **active state**, the action's `iconActive`.
 * The daemon draws the active icon in the active state; otherwise the key's
 * own icon, else the built-in for the state it is in. Each key below, with
 * the name of its active state and which state is its default.
 */
export const PAIR_ICON_FIELDS = ['iconActive'] as const;
export type PairIconField = (typeof PAIR_ICON_FIELDS)[number];

export interface KeyStates {
  /** The active state's slot, named as the inspector shows it. */
  active: string;
  /** The state the active icon is drawn in, for its built-in. */
  activeState: IconState;
  /** The key's default state: what the grid draws, having no live state. */
  defaultState: IconState;
}

const MUTE: KeyStates = { active: 'While muted', activeState: { muted: true }, defaultState: { muted: false } };

export const KEY_STATES: Record<string, KeyStates> = {
  'audio.micMute': MUTE,
  'audio.mute': MUTE,
  'obs.mute': MUTE,
  'discord.mute': MUTE,
  // play/pause only (hasStates).
  'media.control': { active: 'While playing', activeState: { playing: true }, defaultState: { playing: false } },
  toggle: { active: 'While held down', activeState: { latched: true }, defaultState: { latched: false } },
  'obs.stream': { active: 'While live', activeState: { live: true }, defaultState: { live: false } },
  'obs.record': { active: 'While recording', activeState: { live: true }, defaultState: { live: false } },
  'obs.recordPause': { active: 'While paused', activeState: { paused: true }, defaultState: { paused: false } },
  'obs.scene': { active: 'While on air', activeState: { active: true }, defaultState: { active: false } },
  'obs.source': { active: 'While hidden', activeState: { hidden: true }, defaultState: { hidden: false } },
  'discord.deafen': { active: 'While deafened', activeState: { muted: true }, defaultState: { muted: false } },
  // Voice activity is its default; push-to-talk the active state.
  'discord.inputMode': { active: 'On push-to-talk', activeState: { active: false }, defaultState: { active: true } },
  'vts.model': { active: 'While loaded', activeState: { active: true }, defaultState: { active: false } },
  'vts.expression': { active: 'While on', activeState: { active: true }, defaultState: { active: false } },
  'sound.play': { active: 'While playing', activeState: { playing: true }, defaultState: { playing: false } },
  // On is its default; off the active state.
  'virtual.power': { active: 'While off', activeState: { active: false }, defaultState: { active: true } },
};

/**
 * Whether a value names a state icon field. The one test for it: main's icon
 * handler accepts exactly these, and export and import carry these and the
 * fields of the old shape (ICON_FIELDS in backup.ts).
 */
export function isPairIconField(value: unknown): value is PairIconField {
  return (PAIR_ICON_FIELDS as readonly unknown[]).includes(value);
}

/** The key's states, or null for a key with one face. */
export function keyStates(action: { type: string; method?: unknown } | undefined): KeyStates | null {
  return action && hasStates(action) ? (KEY_STATES[action.type] ?? null) : null;
}

/** Which state icons an action has: its active state's, or none. */
export function pairIconFields(action: { type: string; method?: unknown } | undefined): readonly PairIconField[] {
  return keyStates(action) ? ['iconActive'] : [];
}

export function builtinRef(name: BuiltinIcon): string {
  return `${BUILTIN_PREFIX}${name}`;
}

/**
 * The built-in an icon names, or null when it is not a `builtin:` reference or
 * names an icon this version does not ship, which is a broken icon here, as
 * on the deck — which also draws `missing` for it.
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

// What counts as an image, by extension or by first bytes: one copy, shared
// with the daemon (src/icon-types.ts), which applies the same rule.
export { ICON_CONTENT_TYPES, iconExtension, isShownIcon, sniffIconType } from '../../../src/icon-types.js';
