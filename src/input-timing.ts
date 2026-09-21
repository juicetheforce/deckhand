/**
 * The input actions' default pauses. The editor imports this file to estimate
 * how long an action takes (editor/src/shared/durations.ts), so the daemon and
 * the estimate cannot drift apart. No imports: the editor's renderer loads it.
 */

/** `text`: the pause after each character. */
export const TEXT_DELAY_MS = 8;

/** `hotkey`: the pause between a sequence's combos, and between repeats. */
export const HOTKEY_GAP_MS = 30;
