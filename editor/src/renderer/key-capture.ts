/**
 * Whether the hotkey inspector is recording a combo right now.
 *
 * Recording reads every key in the capture phase and swallows it, so in the
 * running editor no key reaches the grid's bulk shortcuts (App.tsx) while it
 * is on. That rests on listener order, though, and a key dispatched at
 * `window` itself reaches the shortcuts first — Escape would be recorded as
 * the hotkey *and* clear the selection. So the shortcuts ask this instead of
 * trusting the order.
 *
 * Set by the recording listener as it is added, cleared as it is removed.
 */
export const keyCapture = { active: false };
