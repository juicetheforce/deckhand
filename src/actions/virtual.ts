import * as power from '../services/virtual-power.js';
import type { ActionDef, ActionHandler } from '../types.js';
import { activeIcon } from '../state-icons.js';

/**
 * virtual.power — turn a virtual deck's panel off and on, for a screen that
 * also runs widgets (services/virtual-power.ts).
 *
 *   { "type": "virtual.power", "deck": "GRA-6e4e" }
 *
 * `deck`: the virtual deck's key under "decks" (its screen, src/screens.ts).
 * Each press turns it the other way. Off, the panel is gone and its
 * touchscreen is the desktop's again; on, it comes back where it was. On any
 * deck, a Stream Deck included — on the virtual deck it controls it can turn
 * it off but not back on, which the editor warns about.
 *
 * The face shows whether that deck is on, redrawn when it changes (index.ts),
 * never on the clock.
 */

function deckOf(params: ActionDef): string | null {
  return typeof params.deck === 'string' && params.deck !== '' ? params.deck : null;
}

export const powerAction: ActionHandler = {
  async execute(ctx, params) {
    const deck = deckOf(params);
    if (deck === null) throw new Error('no virtual deck chosen');
    const on = power.setPower(deck);
    ctx.log(`virtual deck ${deck} turned ${on ? 'on' : 'off'}`);
  },

  iconState: (params) => {
    const deck = deckOf(params);
    return { active: deck === null || !power.isOff(deck) };
  },

  // Active: the deck off; on is its default (src/state-icons.ts). Drawn
  // again when it is turned on or off (index.ts).
  redraw: 'events',
  describe: async (_ctx, params) => {
    const deck = deckOf(params);
    const icon = activeIcon(params, deck !== null && power.isOff(deck));
    return icon === undefined ? null : { icon };
  },
};
