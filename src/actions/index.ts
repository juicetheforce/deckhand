import { ActionNeeded, NotSetUp } from '../action-error.js';
import type { IconState } from '../default-icons.js';
import type { ActionContext, ActionDef, ActionHandler, DisplayPatch } from '../types.js';
import * as keyboard from './keyboard.js';
import * as audio from './audio.js';
import * as media from './media.js';
import * as obs from './obs.js';
import * as system from './system.js';
import * as vts from './vts.js';

/**
 * Adding a feature later means writing one object with execute() and/or
 * describe() and adding a line here. Nothing else in the daemon needs to
 * know it exists.
 */
export const registry: Record<string, ActionHandler> = {
  hotkey: keyboard.hotkey,
  toggle: keyboard.toggle,
  text: keyboard.text,
  keyHold: keyboard.keyHold,

  command: system.command,
  app: system.app,
  editor: system.editor,
  page: system.page,
  profile: system.profile,
  brightness: system.brightness,
  clock: system.clock,
  noop: system.noop,

  'audio.sink': audio.sink,
  'audio.cycle': audio.cycle,
  'audio.source': audio.source,
  'audio.cycleSource': audio.cycleSource,
  'audio.micMute': audio.micMute,
  'audio.volume': audio.volume,
  'audio.mute': audio.mute,

  'media.control': media.control,
  'media.info': media.info,

  'obs.stream': obs.stream,
  'obs.record': obs.record,
  'obs.recordPause': obs.recordPause,
  'obs.scene': obs.scene,
  'obs.mute': obs.mute,
  'obs.source': obs.source,
  'vts.hotkey': vts.hotkey,
  'vts.model': vts.model,
  'vts.expression': vts.expression,
};

/**
 * multi — run several actions in order, with optional pauses.
 *
 *   { "type": "multi", "steps": [
 *       { "type": "audio.sink", "match": "headset", "delayMs": 150 },
 *       { "type": "hotkey", "keys": "ctrl+alt+m" }
 *   ]}
 *
 * A step's `delayMs` is a pause **after** that step runs — how a sequence
 * reads top to bottom, and how the editor's step list shows it. Above, the
 * output switches, 150 ms pass, then the hotkey is sent.
 *
 * A step that fails is logged and the rest still run;
 * then the multi action fails, naming the first failed step, so
 * the key shows it failed rather than looking like it worked.
 *
 * Defined here rather than in its own file so it can reach the registry
 * without a circular import.
 */
registry.multi = {
  async execute(ctx: ActionContext, params: ActionDef) {
    const steps = Array.isArray(params.steps) ? (params.steps as ActionDef[]) : [];
    if (steps.length === 0) throw new Error('multi action needs a "steps" array');
    let firstFailure: string | null = null;
    for (const [i, step] of steps.entries()) {
      const failure = await runAction(ctx, step);
      if (failure !== null && firstFailure === null) firstFailure = `step ${i + 1} failed: ${failure}`;
      const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    if (firstFailure !== null) throw new Error(firstFailure);
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
 * Run an action for a deck key. A failure is logged, not thrown — one bad
 * binding must never take the daemon down or wedge the deck — and returned:
 * its message, or null if the action succeeded, so the deck can mark a key
 * whose press failed. An unknown action type is a failure: the
 * key does nothing.
 */
export async function runAction(ctx: ActionContext, action: ActionDef): Promise<string | null> {
  return (await attempt(ctx, action))?.message ?? null;
}

/** A failed press: its message, and whether that message tells the person what to do (src/action-error.ts). */
export interface ActionFailure {
  message: string;
  actionNeeded: boolean;
  /** An integration the key needs is not set up (NotSetUp): not marked on the key, whose face already says so. */
  notSetUp?: boolean;
}

const failureOf = (err: unknown): ActionFailure => ({
  message: (err as Error).message,
  actionNeeded: err instanceof ActionNeeded,
  notSetUp: err instanceof NotSetUp,
});

/**
 * runAction, keeping whether the failure tells the person what to do: what a
 * deck key press uses. `onArmed` is called when the press only armed its
 * release (ActionHandler.execute resolved 'armed').
 */
export async function attempt(ctx: ActionContext, action: ActionDef, onArmed?: () => void): Promise<ActionFailure | null> {
  const handler = registry[action.type];
  if (!handler) {
    const message = `unknown action type "${action.type}"`;
    ctx.log(message);
    return { message, actionNeeded: false };
  }
  if (!handler.execute) return null;
  try {
    if ((await handler.execute(ctx, action)) === 'armed') onArmed?.();
    return null;
  } catch (err) {
    const failure = failureOf(err);
    ctx.log(`action "${action.type}" failed: ${failure.message}`);
    return failure;
  }
}

/** Whether the action does something when its key is let go (ActionHandler.release). */
export function hasRelease(action: ActionDef): boolean {
  return typeof registry[action.type]?.release === 'function';
}

/**
 * Run an action's release, held this long. Failures are returned, as
 * attempt()'s are; undefined when the release had nothing to do, so the
 * key's mark stays as its press left it.
 */
export async function runRelease(ctx: ActionContext, action: ActionDef, heldMs: number): Promise<ActionFailure | null | undefined> {
  const handler = registry[action.type];
  if (!handler?.release) return undefined;
  try {
    return (await handler.release(ctx, action, heldMs)) ? null : undefined;
  } catch (err) {
    const failure = failureOf(err);
    ctx.log(`action "${action.type}" failed on release: ${failure.message}`);
    return failure;
  }
}

/**
 * Execute an action and let its failure propagate. For the control socket,
 * which reports failures to the client; deck presses use runAction(), which
 * logs them and returns the message.
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

/** A file the action draws when its key has no icon (the app action's app icon), or null. */
export async function defaultIconFileOf(action: ActionDef, size: number): Promise<string | null> {
  const handler = registry[action.type];
  if (!handler?.defaultIcon) return null;
  try {
    return await handler.defaultIcon(action, size);
  } catch {
    return null;
  }
}

/** The state an action's default icon pair shows, from cached state only; {} for actions with no pair. */
export function iconStateOf(action: ActionDef, ctx?: ActionContext): IconState {
  return registry[action.type]?.iconState?.(action, ctx) ?? {};
}
