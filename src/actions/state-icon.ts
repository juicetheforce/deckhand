import type { ActionDef, DisplayPatch } from '../types.js';

/**
 * Two-state keys' own icons, as Elgato's two-state keys have: an icon of the
 * person's own for each state — `iconOn` and `iconOff`, or a mute key's
 * `iconMuted` and `iconUnmuted` — drawn in that state. A state without one
 * falls back to the key's own icon, then the action's built-in for that state
 * (src/deck.ts), so setting an icon for one state never loses the other.
 * The editor lists which keys have them (editor/src/shared/icons.ts
 * pairIconFields).
 */

/** The fields of an on/off key, and of a mute key. */
export const ON_OFF = ['iconOn', 'iconOff'] as const;
export const MUTED_UNMUTED = ['iconMuted', 'iconUnmuted'] as const;

/**
 * The key's own icon for the state it is in, or undefined. `on` null: a third
 * face only the built-ins draw — a stream reconnecting, a recording paused —
 * which no icon of the person's hides.
 */
export function stateIcon(params: ActionDef, on: boolean | null, fields: readonly [string, string] = ON_OFF): string | undefined {
  if (on === null) return undefined;
  const icon = params[on ? fields[0] : fields[1]];
  return typeof icon === 'string' && icon !== '' ? icon : undefined;
}

/** A face's patch (not set up, connecting, or none) with the state's own icon added. */
export function withStateIcon(patch: DisplayPatch | null, icon: string | undefined): DisplayPatch | null {
  if (icon === undefined) return patch;
  return { ...(patch ?? {}), icon };
}
