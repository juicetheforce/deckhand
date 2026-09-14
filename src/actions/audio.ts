import * as audio from '../services/audio.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

/**
 * audio.sink — switch the default output to the first sink matching a
 * substring, and drag playing streams along with it.
 *
 *   { "type": "audio.sink", "match": "headset" }
 *   { "type": "audio.sink", "match": "Speakers", "moveStreams": false }
 *
 * When this sink is the active one the button paints `activeBackground`,
 * so you can see at a glance where sound is going.
 */
export const sink: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const match = String(params.match ?? '');
    if (!match) throw new Error('audio.sink action needs a "match" value');

    const found = await audio.findSink(match);
    if (!found) throw new Error(`no audio output matching "${match}"`);

    await audio.setDefaultSink(found.name, params.moveStreams !== false);
    ctx.log(`audio output -> ${found.description}`);
    ctx.invalidateByType(['audio.sink', 'audio.cycle', 'audio.volume']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const match = String(params.match ?? '');
    const state = audio.cachedState();
    if (!match || !state) return null;
    const found = audio.findSinkIn(state.sinks, match);
    if (found && found.name === state.defaultSink) {
      return { background: String(params.activeBackground ?? '#1d4d2b') };
    }
    return { background: String(params.inactiveBackground ?? '#101014') };
  },
};

/**
 * audio.cycle — rotate through a list of outputs with one button.
 *
 *   { "type": "audio.cycle", "matches": ["headset", "speakers"] }
 */
export const cycle: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const matches = Array.isArray(params.matches) ? (params.matches as string[]) : [];
    if (matches.length < 2) throw new Error('audio.cycle needs at least two "matches"');

    const current = await audio.getDefaultSink();
    const resolved = await Promise.all(matches.map((m) => audio.findSink(m)));
    const available = resolved.filter((s): s is audio.Sink => s !== null);
    if (available.length === 0) throw new Error('none of the listed outputs exist');

    const idx = available.findIndex((s) => s.name === current);
    const next = available[(idx + 1) % available.length];

    await audio.setDefaultSink(next.name, params.moveStreams !== false);
    ctx.log(`audio output -> ${next.description}`);
    ctx.invalidateByType(['audio.sink', 'audio.cycle', 'audio.volume']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    if (params.showCurrent === false) return null;
    const state = audio.cachedState();
    if (!state) return null;
    const active = state.sinks.find((s) => s.name === state.defaultSink);
    if (!active) return null;
    // First word of the description is usually the recognisable part.
    return { label: String(params.label ?? active.description.split(' ')[0]) };
  },
};

/**
 * audio.micMute — toggle the default input, with the button reflecting state.
 *
 *   { "type": "audio.micMute", "iconMuted": "~/icons/mic-off.png",
 *     "iconUnmuted": "~/icons/mic-on.png" }
 */
export const micMute: ActionHandler = {
  async execute(ctx, _params: ActionDef) {
    await audio.toggleMicMute();
    ctx.invalidateByType(['audio.micMute']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const state = audio.cachedState();
    if (!state) return null;
    const patch: DisplayPatch = {};
    if (state.defaultSourceMuted) {
      if (params.iconMuted) patch.icon = String(params.iconMuted);
      if (params.labelMuted) patch.label = String(params.labelMuted);
      patch.background = String(params.mutedBackground ?? '#5a1d1d');
    } else {
      if (params.iconUnmuted) patch.icon = String(params.iconUnmuted);
      if (params.labelUnmuted) patch.label = String(params.labelUnmuted);
      patch.background = String(params.unmutedBackground ?? '#101014');
    }
    return patch;
  },
};

/**
 * audio.volume — nudge the default output volume.
 *
 *   { "type": "audio.volume", "delta": 5 }
 */
export const volume: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const delta = typeof params.delta === 'number' ? params.delta : 5;
    await audio.adjustVolume(delta);
    ctx.invalidateByType(['audio.volume']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    if (params.showLevel === false) return null;
    const level = audio.cachedState()?.defaultSinkVolume ?? null;
    return level === null ? null : { label: `${level}%` };
  },
};

/**
 * audio.mute — toggle output mute.
 */
export const mute: ActionHandler = {
  async execute(ctx, _params: ActionDef) {
    await audio.toggleSinkMute();
    ctx.invalidateByType(['audio.volume', 'audio.mute']);
  },
};
