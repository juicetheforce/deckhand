import { ActionNeeded } from '../action-error.js';
import * as obs from '../services/obs.js';
import type { ActionContext, ActionDef, ActionHandler, DisplayPatch } from '../types.js';

/**
 * OBS Studio keys (scope §7, "Streaming integrations"), through
 * services/obs.ts. Faces read its cached state, kept current by OBS's own
 * events; a press asks OBS afresh, so it acts on what OBS is doing now, not
 * on what the face last showed.
 */

/** How long the Stream key must be held to stop a stream. */
export const HOLD_TO_STOP_MS = 1000;

/**
 * The icons carry state on their own (shape and colour), so keys keep their
 * own background — except a reconnecting stream, which has no icon yet: amber,
 * the set's caution colour, so a dropped stream never looks live. Goes when
 * Claude Design's reconnecting icon arrives.
 */
const RECONNECTING_BACKGROUND = '#5a4a1d';

/** OBS is not set up: every OBS key draws dimmed, with the not-set-up badge. */
const UNSET: DisplayPatch = { unset: true };
const notSetUp = () => obs.cachedState().connection === 'not-set-up';

/**
 * Stream keys whose press found the stream running, so their release may stop
 * it — by deck and key. A press that started the stream is not here, so
 * holding that press does not stop what it just started.
 */
const armed = new Set<string>();
const keyOf = (ctx: ActionContext) => `${ctx.deck.serial}:${ctx.buttonIndex}`;

/**
 * obs.stream — go live, and stop.
 *
 *   { "type": "obs.stream" }
 *
 * **Starts on a press; stops only on a hold** of HOLD_TO_STOP_MS (scope §7):
 * accidentally ending a stream is the worst thing this key can do. A hold, not
 * a second press to confirm — a confirm window would need a timer. A short
 * press while live fails, so the key's badge says to hold it. From the
 * control socket, which has no hold, it only starts.
 */
export const stream: ActionHandler = {
  async execute(ctx, _params: ActionDef) {
    armed.delete(keyOf(ctx));
    const status = await obs.request('GetStreamStatus');
    if (status.outputActive !== true) {
      await obs.request('StartStream');
      return;
    }
    if (ctx.source === 'socket') throw new Error('the stream is live; stopping it takes a hold on the deck key');
    armed.add(keyOf(ctx));
  },

  async release(ctx, _params: ActionDef, heldMs: number) {
    if (!armed.delete(keyOf(ctx))) return false;
    if (heldMs < HOLD_TO_STOP_MS) throw new ActionNeeded(`Hold for ${HOLD_TO_STOP_MS / 1000} second to stop the stream`);
    await obs.request('StopStream');
    return true;
  },

  iconState: () => ({ live: obs.cachedState().stream !== 'stopped' }),

  async describe(): Promise<DisplayPatch | null> {
    if (notSetUp()) return UNSET;
    return obs.cachedState().stream === 'reconnecting' ? { background: RECONNECTING_BACKGROUND } : null;
  },
};

/**
 * obs.record — start and stop recording, one press each.
 *
 *   { "type": "obs.record" }
 */
export const record: ActionHandler = {
  async execute(_ctx, _params: ActionDef) {
    await obs.request('ToggleRecord');
  },

  iconState: () => ({ live: obs.cachedState().record !== 'stopped', paused: obs.cachedState().recordPaused }),

  describe: async () => (notSetUp() ? UNSET : null),
};

/** How long a Pause press waits for OBS to say it paused or resumed. */
export const PAUSE_CONFIRM_MS = 1000;

/**
 * obs.recordPause — pause and resume a recording. Recordings only: OBS
 * cannot pause a stream.
 *
 *   { "type": "obs.recordPause" }
 *
 * obs-websocket answers ToggleRecordPause with success whatever OBS does, and
 * OBS silently ignores it when nothing is recording or the recording shares
 * the stream's encoder (Simple output, Recording Quality "Same as stream" —
 * OBS's own PauseRecording()). So the press checks there is a recording, and
 * then waits for OBS's own paused or resumed event; without one, the press
 * fails and the key says why. A press that did nothing never looks like one
 * that worked.
 */
export const recordPause: ActionHandler = {
  async execute(_ctx, _params: ActionDef) {
    const status = await obs.request('GetRecordStatus');
    if (status.outputActive !== true) throw new ActionNeeded('Nothing is recording: Pause recording pauses what Record records');
    const pausing = status.outputPaused !== true;
    const wanted = pausing ? 'OBS_WEBSOCKET_OUTPUT_PAUSED' : 'OBS_WEBSOCKET_OUTPUT_RESUMED';
    const done = await obs.requestAndConfirm(
      'ToggleRecordPause',
      undefined,
      (type, data) => type === 'RecordStateChanged' && data.outputState === wanted,
      PAUSE_CONFIRM_MS,
    );
    if (done) return;
    if (pausing) {
      throw new ActionNeeded('OBS did not pause: it cannot pause a recording that shares the stream\'s encoder (OBS: Settings › Output › Recording Quality, anything but "Same as stream")');
    }
    throw new Error('OBS did not resume the recording');
  },

  iconState: () => ({ paused: obs.cachedState().recordPaused }),

  describe: async () => (notSetUp() ? UNSET : null),
};
