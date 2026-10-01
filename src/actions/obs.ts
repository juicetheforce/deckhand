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

const CHOOSE_AGAIN = 'renamed or deleted in OBS? Choose it again in the editor';
const named = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * obs.scene — switch OBS's program scene.
 *
 *   { "type": "obs.scene", "scene": "Gameplay" }
 *
 * Lit while it is the program scene, from OBS's CurrentProgramSceneChanged.
 * **Known gap (Ryan, 2026-10-01)**: in studio mode it switches program
 * directly, skipping the preview that studio mode exists for; revisit if a
 * studio-mode user asks.
 */
export const scene: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const sceneName = named(params.scene);
    if (!sceneName) throw new Error('no scene chosen');
    await obs.request('SetCurrentProgramScene', { sceneName }, `OBS has no scene named "${sceneName}": ${CHOOSE_AGAIN}`);
  },

  iconState: (params) => ({ active: named(params.scene) !== null && obs.cachedState().programScene === params.scene }),

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * obs.mute — mute and unmute one of OBS's audio inputs (a mic, desktop audio).
 *
 *   { "type": "obs.mute", "input": "Mic/Aux" }
 *
 * Its own state, not the default device's: that is audio.micMute. Shows
 * muted from OBS's InputMuteStateChanged.
 */
export const mute: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const inputName = named(params.input);
    if (!inputName) throw new Error('no input chosen');
    await obs.request('ToggleInputMute', { inputName }, `OBS has no input named "${inputName}": ${CHOOSE_AGAIN}`);
  },

  iconState: (params) => ({ muted: obs.cachedState().inputMuted[String(params.input)] === true }),

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * obs.source — show and hide a source in a scene (a scene item).
 *
 *   { "type": "obs.source", "scene": "Gameplay", "source": "Webcam" }
 *
 * Named by scene and source, never by OBS's item id, so the config reads as
 * what it is; the id is looked up on the press. A source in the scene twice:
 * the first. Shows hidden from OBS's SceneItemEnableStateChanged.
 */
export const source: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const sceneName = named(params.scene);
    const sourceName = named(params.source);
    if (!sceneName || !sourceName) throw new Error('no scene and source chosen');
    const missing = `OBS has no source "${sourceName}" in the scene "${sceneName}": ${CHOOSE_AGAIN}`;
    const { sceneItemId } = await obs.request('GetSceneItemId', { sceneName, sourceName }, missing);
    const { sceneItemEnabled } = await obs.request('GetSceneItemEnabled', { sceneName, sceneItemId }, missing);
    await obs.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: sceneItemEnabled !== true }, missing);
  },

  iconState: (params) => ({ hidden: obs.cachedState().itemEnabled[obs.itemKey(String(params.scene), String(params.source))] === false }),

  describe: async () => (notSetUp() ? UNSET : null),
};
