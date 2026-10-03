import { ActionNeeded } from '../action-error.js';
import * as vts from '../services/vts.js';
import { VtsError } from '../services/vts-client.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

/**
 * VTube Studio keys (scope §7, "Streaming integrations"), through
 * services/vts.ts. Faces read its cached state, kept current by VTS's own
 * events; a press asks VTS afresh.
 */

/** VTS is not set up: every VTS key draws dimmed, with the not-set-up badge. */
const UNSET: DisplayPatch = { unset: true };
const notSetUp = () => vts.cachedState().connection === 'not-set-up';

const named = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const CHOOSE_AGAIN = 'deleted in VTube Studio? Choose it again in the editor';

/**
 * vts.hotkey — trigger one of a model's hotkeys: an expression, an
 * animation, a background, a prop… whatever VTS's hotkey does.
 *
 *   { "type": "vts.hotkey", "model": "<model ID>", "hotkey": "<hotkey ID>",
 *     "modelName": "Akari", "hotkeyName": "Heart Eyes" }
 *
 * **By ID, never by name** (scope §7): VTS's hotkeys belong to a model, a
 * name can repeat or be empty, and a model's name is not even spelt the same
 * by every VTS request. The names are kept only to show, and to say what is
 * missing. While another model is loaded the key draws its unavailable face
 * (dashed, no badge), from VTS's ModelLoadedEvent; a press then is marked,
 * and never falls back to a hotkey of the same name in the model loaded.
 * VTS's answer means the hotkey ran (its event comes first, VTS session 1),
 * so a press needs nothing more to confirm it.
 */
export const hotkey: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const model = named(params.model);
    const hotkeyID = named(params.hotkey);
    if (!model || !hotkeyID) throw new Error('no hotkey chosen');
    const hotkeyName = named(params.hotkeyName) ?? 'This hotkey';
    const modelName = named(params.modelName) ?? 'its model';
    try {
      await vts.request('HotkeyTriggerRequest', { hotkeyID });
    } catch (err) {
      if (!(err instanceof VtsError)) throw err;
      // Read after the request, so the model is the one VTS had when it answered (connecting sets it before anything is sent).
      const loaded = vts.cachedState().modelId;
      const noModel = err.errorID === vts.VTS_ERRORS.HotkeyExecutionFailedBecauseNoModelLoaded;
      if (noModel || (err.errorID === vts.VTS_ERRORS.HotkeyIDNotFoundInModel && loaded === null)) {
        throw new Error(`No model is loaded in VTube Studio: "${hotkeyName}" belongs to ${modelName}`);
      }
      if (err.errorID === vts.VTS_ERRORS.HotkeyIDNotFoundInModel) {
        // Another model loaded: the face already shows it unavailable, so the badge only says why.
        if (loaded !== model) throw new Error(`"${hotkeyName}" belongs to ${modelName}, which is not the model loaded in VTube Studio`);
        // Its own model loaded, and the hotkey gone: something the person can fix, so it is notified.
        throw new ActionNeeded(`${modelName} has no hotkey "${hotkeyName}" any more: ${CHOOSE_AGAIN}`);
      }
      throw err;
    }
  },

  // Unavailable only when known: connected, and its model not the one loaded (none loaded counts — mid-switch, ~2 s).
  iconState: (params) => ({ unavailable: vts.cachedState().connection === 'connected' && vts.cachedState().modelId !== params.model }),

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * vts.model — load a model in VTube Studio.
 *
 *   { "type": "vts.model", "model": "<model ID>", "modelName": "Akari" }
 *
 * Lit only by VTS's ModelLoadedEvent, never by the press: VTS answers a load
 * at once and finishes it ~1–2 s later (VTS session 2), so a press waits for
 * the event naming its model, and is marked if none comes. A press while its
 * model is already loaded does nothing — VTS would reload it, and the avatar
 * would drop out on stream. VTS loads one model every 2 seconds; a press
 * inside that is marked, not notified.
 */
export const model: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const modelID = named(params.model);
    if (!modelID) throw new Error('no model chosen');
    const modelName = named(params.modelName) ?? 'This model';
    const gone = `${modelName} is not in VTube Studio any more: ${CHOOSE_AGAIN}`;
    let outcome: Awaited<ReturnType<typeof vts.loadModel>>;
    try {
      outcome = await vts.loadModel(modelID, Object.fromEntries([...vts.MODEL_NOT_FOUND].map((id) => [id, gone])));
    } catch (err) {
      if (err instanceof VtsError && err.errorID === vts.VTS_ERRORS.ModelLoadCooldownNotOver) throw new Error('VTube Studio loads one model every 2 seconds: press again in a moment');
      throw err;
    }
    if (outcome === 'unconfirmed') throw new Error(`VTube Studio did not say ${modelName} had loaded`);
  },

  iconState: (params) => ({ active: vts.cachedState().connection === 'connected' && vts.cachedState().modelId === params.model }),

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * vts.expression — turn one of a model's expressions on or off.
 *
 *   { "type": "vts.expression", "model": "<model ID>", "expression": "EyesLove.exp3.json",
 *     "modelName": "Akari", "expressionName": "EyesLove" }
 *
 * By model ID and expression file: VTS knows an expression by its file, and
 * only for the model loaded. Lit while VTS says it is on (services/vts.ts
 * keeps that, and on VTS's stable branch misses a change made in VTS's own
 * window until the next model load or expression hotkey — scope §7). Built
 * around the model in use (scope §7): **while another model is loaded the
 * key keeps its normal face**, and a press is marked, saying so.
 */
export const expression: ActionHandler = {
  async execute(_ctx, params: ActionDef) {
    const model = named(params.model);
    const file = named(params.expression);
    if (!model || !file) throw new Error('no expression chosen');
    const expressionName = named(params.expressionName) ?? file.replace(/\.exp3\.json$/, '');
    const modelName = named(params.modelName) ?? 'its model';
    const gone = `${modelName} has no expression "${expressionName}" any more: ${CHOOSE_AGAIN}`;
    const outcome = await vts.toggleExpression(model, file, Object.fromEntries([...vts.EXPRESSION_NOT_FOUND].map((id) => [id, gone])));
    if (outcome === 'not-loaded') {
      if (vts.cachedState().modelId === null) throw new Error(`No model is loaded in VTube Studio: "${expressionName}" belongs to ${modelName}`);
      throw new Error(`"${expressionName}" belongs to ${modelName}, which is not loaded in VTube Studio`);
    }
  },

  iconState: (params) => {
    const s = vts.cachedState();
    return { active: s.connection === 'connected' && s.expressionsModel === params.model && s.expressions[String(params.expression)] === true };
  },

  describe: async () => (notSetUp() ? UNSET : null),
};
