import type { ActionDef, ButtonDef, Config } from './types.js';

/**
 * Keys with states — the pattern for every multi-state key (Ryan, 2026-10-23;
 * scope §10): **two icons, the key's "Default icon" (its normal look, the
 * button's own `icon`) and one for its active state (the action's
 * `iconActive`)**. How they combine, in src/deck.ts and each action's
 * describe():
 *
 *   - neither set: the built-in pair switches, as it always has;
 *   - a default and no active icon: that icon in both states — choosing a
 *     custom icon is deliberate, and choosing no second state is the person's
 *     call;
 *   - an active icon and no default: the built-in default, then the active icon;
 *   - both: switching between them.
 *
 * OBS's warning states (a stream reconnecting, a recording paused) draw their
 * built-in over any custom icon.
 *
 * Pure — no file system — so the editor uses the same migration: the daemon
 * applies it in memory on every load, and the editor writes it when it opens
 * config.json, so nobody loses an icon set in the old shape.
 */

/** Where every key keeps its active state's icon. */
export const ACTIVE_ICON = 'iconActive';

/**
 * Each key with states, and the fields its two icons were kept in before:
 * one per state, `active` being the field that held the active state's.
 * Released before `v0.10.0`: the mute keys', play/pause's and the toggle's;
 * the rest only in `v0.10.0`'s builds, where on/off meant on/off — so Input
 * mode's, Show/hide source's and Virtual deck on/off's active state (push-to-
 * talk, hidden, off) was `iconOff`.
 */
const LEGACY: Record<string, { active: string; resting: string }> = {
  'audio.micMute': { active: 'iconMuted', resting: 'iconUnmuted' },
  'audio.mute': { active: 'iconMuted', resting: 'iconUnmuted' },
  'obs.mute': { active: 'iconMuted', resting: 'iconUnmuted' },
  'discord.mute': { active: 'iconMuted', resting: 'iconUnmuted' },
  'media.control': { active: 'iconPlaying', resting: 'iconPaused' },
  toggle: { active: 'iconOn', resting: 'iconOff' },
  'obs.stream': { active: 'iconOn', resting: 'iconOff' },
  'obs.record': { active: 'iconOn', resting: 'iconOff' },
  'obs.recordPause': { active: 'iconOn', resting: 'iconOff' },
  'obs.scene': { active: 'iconOn', resting: 'iconOff' },
  'obs.source': { active: 'iconOff', resting: 'iconOn' },
  'discord.deafen': { active: 'iconOn', resting: 'iconOff' },
  'discord.inputMode': { active: 'iconOff', resting: 'iconOn' },
  'vts.model': { active: 'iconOn', resting: 'iconOff' },
  'vts.expression': { active: 'iconOn', resting: 'iconOff' },
  'sound.play': { active: 'iconOn', resting: 'iconOff' },
  'virtual.power': { active: 'iconOff', resting: 'iconOn' },
};

/** Every field a state's icon was ever kept in, before `iconActive`: an export still carries their files. */
export const LEGACY_STATE_ICON_FIELDS = ['iconMuted', 'iconUnmuted', 'iconPlaying', 'iconPaused', 'iconOn', 'iconOff'] as const;

/** Whether a key with this action has states: an active icon as well as its default. */
export function hasStates(action: { type: string; method?: unknown } | undefined): boolean {
  if (!action || !Object.prototype.hasOwnProperty.call(LEGACY, action.type)) return false;
  // Play/pause only: next, previous and stop have one face.
  return action.type !== 'media.control' || String(action.method ?? 'playpause').toLowerCase() === 'playpause';
}

/** The key's own icon for its active state, while it is in it; undefined otherwise, which falls back as above. */
export function activeIcon(params: ActionDef, active: boolean): string | undefined {
  const icon = params[ACTIVE_ICON];
  return active && typeof icon === 'string' && icon !== '' ? icon : undefined;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * A key's icons moved from the old shape — one field per state — to the
 * default and the active icon, drawing what it drew before. The old resting
 * state's icon becomes the default; the active state's, the active icon; a
 * key's own icon, which showed in a state with no icon of its own, becomes
 * the active icon when only the resting state had one. One drawn in neither
 * state (both had icons of their own) is dropped: it never showed.
 * Returns whether anything changed.
 */
export function migrateButton(button: ButtonDef): boolean {
  const action = button.action;
  if (!action || !hasStates(action)) return false;
  const legacy = LEGACY[action.type];
  if (!(legacy.active in action) && !(legacy.resting in action)) return false;
  const wasActive = text(action[legacy.active]);
  const wasResting = text(action[legacy.resting]);
  const own = button.icon;
  const active = text(action[ACTIVE_ICON]) ?? wasActive ?? (wasResting !== undefined && typeof own === 'string' ? own : undefined);
  delete action[legacy.active];
  delete action[legacy.resting];
  if (active !== undefined) action[ACTIVE_ICON] = active;
  if (wasResting !== undefined) button.icon = wasResting;
  return true;
}

/** Every key of the config, in place; returns whether anything changed. Multi steps and releases have no face, and are left. */
export function migrateStateIcons(config: Config): boolean {
  let changed = false;
  for (const profile of Object.values(config.profiles ?? {})) {
    for (const layout of Object.values(profile.layouts ?? {})) {
      for (const page of Object.values(layout.pages ?? {})) {
        for (const button of Object.values(page.buttons ?? {})) if (migrateButton(button)) changed = true;
      }
    }
  }
  return changed;
}
