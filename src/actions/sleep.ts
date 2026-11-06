import { activeIcon } from '../state-icons.js';
import { sleep, type SleepAll } from '../sleep.js';
import type { ActionDef, ActionHandler } from '../types.js';

/**
 * sleep.all — dim every deck, or turn them off, until the next press.
 *
 *   { "type": "sleep.all", "mode": "dim", "level": 20 }
 *   { "type": "sleep.all", "mode": "off" }
 *
 * `level` is a percent of full brightness, 1–100, 20 unless set; a deck set
 * lower than that stays where it is. Waking is src/sleep.ts's: a press on any
 * deck, which runs its key if the decks were dimmed and only wakes them if they
 * were off. Not kept across a restart.
 */

export const DEFAULT_DIM_LEVEL = 20;

function chosen(params: ActionDef): SleepAll {
  if (params.mode === 'off') return { mode: 'off' };
  const level = typeof params.level === 'number' && params.level >= 1 && params.level <= 100 ? params.level : DEFAULT_DIM_LEVEL;
  return { mode: 'dim', level };
}

export const sleepAllAction: ActionHandler = {
  async execute(ctx, params) {
    sleep.toggleAll(chosen(params));
    ctx.log(sleep.allActive() ? 'every deck asleep' : 'every deck awake');
  },

  iconState: () => ({ active: sleep.allActive() }),
  active: () => sleep.allActive(),

  // Drawn again when it changes (sleep.ts), never on the clock.
  redraw: 'events',
  describe: async (_ctx, params) => {
    const icon = activeIcon(params, sleep.allActive());
    return icon === undefined ? null : { icon };
  },
};
