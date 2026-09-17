import type { ActionContext, ActionDef, ActionHandler, DisplayPatch } from '../types.js';
import * as keyboard from './keyboard.js';
import * as audio from './audio.js';
import * as media from './media.js';
import * as system from './system.js';

/**
 * Adding a feature later means writing one object with execute() and/or
 * describe() and adding a line here. Nothing else in the daemon needs to
 * know it exists.
 */
export const registry: Record<string, ActionHandler> = {
  hotkey: keyboard.hotkey,
  text: keyboard.text,
  keyHold: keyboard.keyHold,

  command: system.command,
  page: system.page,
  profile: system.profile,
  brightness: system.brightness,
  clock: system.clock,
  noop: system.noop,

  'audio.sink': audio.sink,
  'audio.cycle': audio.cycle,
  'audio.source': audio.source,
  'audio.micMute': audio.micMute,
  'audio.volume': audio.volume,
  'audio.mute': audio.mute,

  'media.control': media.control,
  'media.info': media.info,
};

/**
 * multi — run several actions in order, with optional pauses.
 *
 *   { "type": "multi", "steps": [
 *       { "type": "audio.sink", "match": "headset" },
 *       { "type": "hotkey", "keys": "ctrl+alt+m", "delayMs": 150 }
 *   ]}
 *
 * Defined here rather than in its own file so it can reach the registry
 * without a circular import.
 */
registry.multi = {
  async execute(ctx: ActionContext, params: ActionDef) {
    const steps = Array.isArray(params.steps) ? (params.steps as ActionDef[]) : [];
    if (steps.length === 0) throw new Error('multi action needs a "steps" array');
    for (const step of steps) {
      const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await runAction(ctx, step);
    }
  },
};

export function isKnownAction(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, type);
}

/** Whether a button using this action should refresh on a timer. */
export function isDynamic(action: ActionDef | undefined): boolean {
  if (!action) return false;
  return typeof registry[action.type]?.describe === 'function';
}

/**
 * Execute an action. Failures are logged and swallowed — one bad binding
 * must never take the daemon down or wedge the deck.
 */
export async function runAction(ctx: ActionContext, action: ActionDef): Promise<void> {
  const handler = registry[action.type];
  if (!handler) {
    ctx.log(`unknown action type "${action.type}"`);
    return;
  }
  if (!handler.execute) return;
  try {
    await handler.execute(ctx, action);
  } catch (err) {
    ctx.log(`action "${action.type}" failed: ${(err as Error).message}`);
  }
}

/**
 * Execute an action and let its failure propagate. For the control socket,
 * which reports failures to the client; deck presses use runAction(), which
 * logs and swallows them.
 */
export async function runActionOrThrow(ctx: ActionContext, action: ActionDef): Promise<void> {
  const handler = registry[action.type];
  if (!handler) throw new Error(`unknown action type "${action.type}"`);
  if (handler.execute) await handler.execute(ctx, action);
}

/** Ask an action what the button should currently look like. */
export async function describeAction(
  ctx: ActionContext,
  action: ActionDef | undefined,
): Promise<DisplayPatch | null> {
  if (!action) return null;
  const handler = registry[action.type];
  if (!handler?.describe) return null;
  try {
    return await handler.describe(ctx, action);
  } catch (err) {
    ctx.log(`describe for "${action.type}" failed: ${(err as Error).message}`);
    return null;
  }
}
