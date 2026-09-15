import { input } from '../input.js';
import type { ActionDef, ActionHandler } from '../types.js';

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
    const gapMs = typeof params.gapMs === 'number' ? params.gapMs : 30;

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
    const delayMs = typeof params.delayMs === 'number' ? params.delayMs : 8;
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
