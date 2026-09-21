/**
 * How long input actions take, estimated from the helper's measured timings
 * (docs/code-state.md, "Cost of the combo timing on `text`", 2026-09-13,
 * `[confirmed]` on the laptop). Estimates: the helper's timing is fixed, but
 * the system around it is not. No Node imports: the renderer uses this.
 *
 *   - a single key tap: 14.8 ms; with `text`'s 8 ms pause after each, ~22.5 ms
 *     per plain character (11 characters of "hello world" measured 247 ms);
 *   - a combo (anything with a modifier, including a capital letter): 141.5 ms,
 *     held for games (scope §10 — not lowered without a game re-test); with the
 *     8 ms pause, ~150 ms per shifted character ("Hello World" 506 ms measured,
 *     501 ms by this estimate).
 */
import { HOTKEY_GAP_MS, TEXT_DELAY_MS } from '../../../src/input-timing.js';
import { parseCombo, textToTaps } from '../../../src/keymap.js';

export const SINGLE_TAP_MS = 14.8;
export const COMBO_TAP_MS = 141.5;
/** A string's typing time, or null if the US-layout map cannot type it. */
export function textDurationMs(text: string, delayMs = TEXT_DELAY_MS): number | null {
  let taps: number[][];
  try {
    taps = textToTaps(text);
  } catch {
    return null;
  }
  return taps.reduce((ms, codes) => ms + (codes.length > 1 ? COMBO_TAP_MS : SINGLE_TAP_MS) + delayMs, 0);
}

/** One press of a combo, as `hotkey` sends it without holdMs; null if it does not parse. */
export function comboTapMs(combo: string): number | null {
  try {
    return parseCombo(combo).length > 1 ? COMBO_TAP_MS : SINGLE_TAP_MS;
  } catch {
    return null;
  }
}

/**
 * About how long one action takes to run, not counting a Multi step's delay.
 * Only input actions are estimated, from the measurements above. Every other
 * action — switching an output, a page, a media key — counts as 0:
 * `[inference]` short beside a combo's 141 ms, and not measured.
 */
export function actionDurationMs(action: { type: string; [k: string]: unknown }): number {
  if (action.type === 'text') return typeof action.text === 'string' ? (textDurationMs(action.text) ?? 0) : 0;
  if (action.type !== 'hotkey') return 0;
  const combos = Array.isArray(action.keys) ? action.keys.map(String) : typeof action.keys === 'string' ? [action.keys] : [];
  if (combos.length === 0) return 0;
  const holdMs = typeof action.holdMs === 'number' ? action.holdMs : 0;
  const repeat = typeof action.repeat === 'number' ? Math.max(1, action.repeat) : 1;
  const once = combos.reduce((ms, combo) => ms + (holdMs > 0 ? holdMs : (comboTapMs(combo) ?? 0)), 0) + (combos.length > 1 ? combos.length * HOTKEY_GAP_MS : 0);
  return once * repeat + (repeat - 1) * HOTKEY_GAP_MS;
}

/** "0.5 s", "1.2 s", "85 ms" — rounded so it does not look more precise than it is. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms / 5) * 5} ms` : `${(ms / 1000).toFixed(1)} s`;
}
