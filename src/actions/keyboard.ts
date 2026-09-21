import { input } from '../input.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';
import { HOTKEY_GAP_MS, TEXT_DELAY_MS } from '../input-timing.js';

/**
 * hotkey — send a key combo to whatever currently has focus.
 *
 *   { "type": "hotkey", "keys": "ctrl+alt+3" }
 *   { "type": "hotkey", "keys": ["ctrl+c", "ctrl+v"] }   sequence
 *   { "type": "hotkey", "keys": "v", "holdMs": 400 }     press and hold
 *   { "type": "hotkey", "keys": "f13", "repeat": 3 }
 */
export const hotkey: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const raw = params.keys;
    const combos = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? '')];
    if (combos.length === 0 || combos[0] === '') {
      throw new Error('hotkey action needs a "keys" value');
    }

    const holdMs = typeof params.holdMs === 'number' ? params.holdMs : 0;
    const repeat = typeof params.repeat === 'number' ? Math.max(1, params.repeat) : 1;
    const gapMs = typeof params.gapMs === 'number' ? params.gapMs : HOTKEY_GAP_MS;

    for (let i = 0; i < repeat; i++) {
      for (const combo of combos) {
        if (holdMs > 0) await input.hold(combo, holdMs);
        else await input.tap(combo);
        if (combos.length > 1) await new Promise((r) => setTimeout(r, gapMs));
      }
      if (repeat > 1 && i < repeat - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  },
};

/**
 * text — type a literal string (US layout).
 *
 *   { "type": "text", "text": "gg wp\n" }
 */
export const text: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const value = params.text;
    if (typeof value !== 'string') throw new Error('text action needs a "text" string');
    const delayMs = typeof params.delayMs === 'number' ? params.delayMs : TEXT_DELAY_MS;
    await input.type(value, delayMs);
  },
};

/**
 * keyHold — hold a combo down until the button is released. Pair it with
 * onRelease for push-to-talk style bindings.
 *
 *   { "type": "keyHold", "keys": "f14", "state": "down" }
 */
export const keyHold: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const combo = String(params.keys ?? '');
    if (!combo) throw new Error('keyHold action needs a "keys" value');
    if (params.state === 'up') await input.up(combo, ctx.source);
    else await input.down(combo, ctx.source);
  },
};

/**
 * toggle — a latching key (M7, docs/scope.md §6). Press once and the combo
 * goes down and stays down; press again and it releases. Unlike `keyHold`,
 * which is momentary and follows the finger, the daemon holds the state and
 * ignores the physical release.
 *
 *   { "type": "toggle", "keys": "shift",
 *     "iconOn": "~/icons/on.png", "iconOff": "~/icons/off.png" }
 *
 * The state belongs to the deck session, not here: it owns the lifecycle, and
 * every way off a page — a page or profile change, the deck going, the helper
 * restarting — has to release the key. Nothing may leave a combo held with no
 * key able to release it.
 */
export const toggle: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const combo = String(params.keys ?? '');
    if (!combo) throw new Error('toggle action needs a "keys" value');
    // A latch is a deck key's state: it is released by pressing that key
    // again. Over the socket there is no key to press, and the socket's own
    // rule is that an action it runs never leaves a key held (§7, M3).
    if (ctx.source !== 'deck' || ctx.buttonIndex < 0) {
      throw new Error('a toggle latches a deck key, so it cannot be run from the control socket');
    }
    await ctx.deck.toggleLatch(ctx.buttonIndex, combo);
  },

  // Reads the session's own state; no I/O, so it costs nothing per render.
  iconState: (_params: ActionDef, ctx) => ({ latched: ctx ? ctx.deck.isLatched(ctx.buttonIndex) : false }),

  async describe(ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const latched = ctx.deck.isLatched(ctx.buttonIndex);
    const patch: DisplayPatch = {};
    // The same shape as audio.micMute: an icon or label for each state is used
    // when it is set, and the background says which state it is in either way.
    if (latched) {
      if (params.iconOn) patch.icon = String(params.iconOn);
      if (params.labelOn) patch.label = String(params.labelOn);
      patch.background = String(params.onBackground ?? '#1d3a5a');
    } else {
      if (params.iconOff) patch.icon = String(params.iconOff);
      if (params.labelOff) patch.label = String(params.labelOff);
      patch.background = String(params.offBackground ?? '#101014');
    }
    return patch;
  },
};
