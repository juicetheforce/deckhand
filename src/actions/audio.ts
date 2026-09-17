import * as audio from '../services/audio.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

/**
 * Check that a switch actually took. The audio server can refuse to make a
 * sink the default without reporting an error — observed with a headphone
 * jack whose port was "not available" because nothing was plugged in. Without
 * this check the action logged "audio output -> Headphones" while the speaker
 * stayed default: a button that appears to work while doing nothing.
 *
 * setDefaultSink() re-reads the cache before returning, so the cache holds the
 * default as the server has it now. On a mismatch this throws, and runAction
 * logs it as a failure. The key face needs nothing extra: it reads the same
 * cache, so it already shows the real default.
 */
function confirmDefaultIs(requested: audio.Sink): void {
  const state = audio.cachedState();
  if (state && state.defaultSink === requested.name) return;
  const actual = state?.sinks.find((s) => s.name === state.defaultSink);
  const actualName = actual?.description ?? state?.defaultSink ?? 'unknown';
  throw new Error(
    `switch to "${requested.description}" did not take effect; default output is still "${actualName}"`,
  );
}

/**
 * A device as the editor stores it (docs/scope.md §3): the exact node the user
 * picked from the daemon's list, and its description at the time, for showing.
 */
interface DeviceRef {
  node: string;
  label: string;
}

/** The node an action names, or null if it names none. */
function nodeOf(params: ActionDef): string | null {
  return typeof params.node === 'string' && params.node !== '' ? params.node : null;
}

/** How to name a device in a message: its stored label, else the node. */
function nameOf(ref: DeviceRef): string {
  return ref.label !== '' ? `"${ref.label}" (${ref.node})` : ref.node;
}

/**
 * audio.cycle's `devices`, or null if the action does not use them. An entry
 * without a node throws: a list the editor wrote is never like that, and
 * skipping it silently would make a key that steps through fewer outputs than
 * it shows.
 */
function devicesOf(params: ActionDef): DeviceRef[] | null {
  if (!Array.isArray(params.devices)) return null;
  return params.devices.map((entry, i) => {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.node !== 'string' || e.node === '') {
      throw new Error(`audio.cycle "devices" entry ${i} has no "node"`);
    }
    return { node: e.node, label: typeof e.label === 'string' ? e.label : '' };
  });
}

/**
 * audio.sink — switch the default output, and drag playing streams along.
 *
 *   { "type": "audio.sink", "node": "alsa_output.usb-…analog-stereo", "label": "USB Headset" }
 *   { "type": "audio.sink", "match": "headset" }            hand-edited config only
 *   { "type": "audio.sink", "node": "…", "moveStreams": false }
 *
 * `node` is what the editor writes: the exact device picked from the daemon's
 * list (`deckhand sinks`). If that device is not present the press logs and
 * does nothing — no fallback (docs/scope.md §3). `label` is for showing only.
 * `match`, a substring of the description or node name, is kept for
 * hand-edited config and is ignored when `node` is set.
 *
 * When this sink is the active one the button paints `activeBackground`,
 * so you can see at a glance where sound is going.
 */
export const sink: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const node = nodeOf(params);
    let found: audio.Sink | null;
    if (node) {
      found = await audio.findSinkByNode(node);
      if (!found) {
        const label = typeof params.label === 'string' ? params.label : '';
        throw new Error(`output ${nameOf({ node, label })} is not present`);
      }
    } else {
      const match = String(params.match ?? '');
      if (!match) throw new Error('audio.sink action needs a "node" (or a "match" in hand-edited config)');
      found = await audio.findSink(match);
      if (!found) throw new Error(`no audio output matching "${match}"`);
    }

    await audio.setDefaultSink(found.name, params.moveStreams !== false);
    confirmDefaultIs(found);
    ctx.log(`audio output -> ${found.description}`);
    ctx.invalidateByType(['audio.sink', 'audio.cycle', 'audio.volume', 'audio.mute']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const state = audio.cachedState();
    if (!state) return null;
    const node = nodeOf(params);
    let active: boolean;
    if (node) {
      active = node === state.defaultSink;
    } else {
      const match = String(params.match ?? '');
      if (!match) return null;
      active = audio.findSinkIn(state.sinks, match)?.name === state.defaultSink;
    }
    return active
      ? { background: String(params.activeBackground ?? '#1d4d2b') }
      : { background: String(params.inactiveBackground ?? '#101014') };
  },
};

/**
 * audio.cycle — rotate through a list of outputs with one button.
 *
 *   { "type": "audio.cycle", "devices": [
 *       { "node": "alsa_output.usb-…analog-stereo", "label": "USB Headset" },
 *       { "node": "alsa_output.pci-…HiFi__Speaker__sink", "label": "Speakers" } ] }
 *   { "type": "audio.cycle", "matches": ["headset", "speakers"] }   hand-edited config only
 *
 * Each press moves to the entry after the current default, wrapping round, so
 * two entries make a toggle; if the default is not in the list it goes to the
 * first. Entries whose device is not present are skipped, and said so.
 * `devices` is what the editor writes; `matches` is ignored when it is set.
 *
 * The key shows the active entry's stored label — which tells a headset's
 * stereo and mono sinks apart, where the description's first word could not —
 * and nothing when the default is not in the list. `label` fixes the text;
 * `showCurrent: false` turns it off. With `matches` the key shows the first
 * word of the default's description, as it always has.
 */
export const cycle: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const devices = devicesOf(params);
    let available: audio.Sink[];
    if (devices) {
      if (devices.length < 2) throw new Error('audio.cycle needs at least two "devices"');
      const sinks = await audio.listSinks();
      available = [];
      for (const ref of devices) {
        const found = sinks.find((s) => s.name === ref.node);
        if (found) available.push(found);
        else ctx.log(`audio.cycle: skipping output ${nameOf(ref)}, not present`);
      }
    } else {
      const matches = Array.isArray(params.matches) ? (params.matches as string[]) : [];
      if (matches.length < 2) throw new Error('audio.cycle needs at least two "devices" (or "matches" in hand-edited config)');
      const resolved = await Promise.all(matches.map((m) => audio.findSink(m)));
      available = resolved.filter((s): s is audio.Sink => s !== null);
    }
    if (available.length === 0) throw new Error('none of the listed outputs exist');

    const current = await audio.getDefaultSink();
    const idx = available.findIndex((s) => s.name === current);
    const next = available[(idx + 1) % available.length];

    await audio.setDefaultSink(next.name, params.moveStreams !== false);
    confirmDefaultIs(next);
    ctx.log(`audio output -> ${next.description}`);
    ctx.invalidateByType(['audio.sink', 'audio.cycle', 'audio.volume', 'audio.mute']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    if (params.showCurrent === false) return null;
    const state = audio.cachedState();
    if (!state) return null;
    // A malformed list is reported by the press; the face, refreshed every
    // second, shows nothing rather than logging the same error each time.
    let devices: DeviceRef[] | null;
    try {
      devices = devicesOf(params);
    } catch {
      return null;
    }
    if (devices) {
      const active = devices.find((ref) => ref.node === state.defaultSink);
      if (!active) return null;
      return { label: String(params.label ?? (active.label !== '' ? active.label : active.node)) };
    }
    const active = state.sinks.find((s) => s.name === state.defaultSink);
    if (!active) return null;
    // First word of the description is usually the recognisable part.
    return { label: String(params.label ?? active.description.split(' ')[0]) };
  },
};

/**
 * audio.source — switch the default input (docs/scope.md §6).
 *
 *   { "type": "audio.source", "node": "alsa_input.usb-…mono-fallback", "label": "USB Headset Mic" }
 *
 * A mirror of audio.sink, by `node` only: it is new, so there is no
 * hand-edited `match` to keep. A device that is not present logs and does
 * nothing. The key paints `activeBackground` while this input is the default,
 * so "why can nobody hear me" is a glance (§6). Streams already recording are
 * not moved.
 */
export const source: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const node = nodeOf(params);
    if (!node) throw new Error('audio.source action needs a "node"');
    const label = typeof params.label === 'string' ? params.label : '';
    const found = await audio.findSourceByNode(node);
    if (!found) throw new Error(`input ${nameOf({ node, label })} is not present`);

    await audio.setDefaultSource(found.name);
    // As confirmDefaultIs() for outputs: the server can decline without an error.
    const state = audio.cachedState();
    if (state?.defaultSource !== found.name) {
      throw new Error(`switch to ${nameOf({ node, label })} did not take effect; default input is still "${state?.defaultSource ?? 'unknown'}"`);
    }
    ctx.log(`audio input -> ${found.description}`);
    // micMute shows the default input's mute, which just became another device's.
    ctx.invalidateByType(['audio.source', 'audio.micMute']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const state = audio.cachedState();
    const node = nodeOf(params);
    if (!state || !node) return null;
    return node === state.defaultSource
      ? { background: String(params.activeBackground ?? '#1d4d2b') }
      : { background: String(params.inactiveBackground ?? '#101014') };
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

  iconState: () => ({ muted: audio.cachedState()?.defaultSourceMuted === true }),

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
 *   { "type": "audio.volume", "delta": -5, "showLevel": true }
 *
 * The key draws its default icon (`speaker`, or `volume-down` for a negative
 * delta). The level is shown only with `showLevel: true` — off by default since
 * C1, so a default key is not a label drawn over an icon (docs/scope.md §7 C1
 * call 4).
 */
export const volume: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const delta = typeof params.delta === 'number' ? params.delta : 5;
    await audio.adjustVolume(delta);
    ctx.invalidateByType(['audio.volume']);
  },

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    if (params.showLevel !== true) return null;
    const level = audio.cachedState()?.defaultSinkVolume ?? null;
    return level === null ? null : { label: `${level}%` };
  },
};

/**
 * audio.mute — toggle output mute, with the button reflecting state.
 *
 *   { "type": "audio.mute", "iconMuted": "~/icons/speaker-off.png",
 *     "iconUnmuted": "~/icons/speaker.png" }
 *
 * The same icon and label parameters as audio.micMute, but **no background
 * change**: output mute shows its state by the icon pair alone (the maintainer,
 * docs/scope.md §7 C1 call 6). The face follows the *default* output, so
 * switching outputs can change it.
 */
export const mute: ActionHandler = {
  async execute(ctx, _params: ActionDef) {
    await audio.toggleSinkMute();
    ctx.invalidateByType(['audio.volume', 'audio.mute']);
  },

  iconState: () => ({ muted: audio.cachedState()?.defaultSinkMuted === true }),

  // Reads cached state only — never spawns pactl (see services/audio.ts).
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const state = audio.cachedState();
    if (!state) return null;
    const patch: DisplayPatch = {};
    if (state.defaultSinkMuted) {
      if (params.iconMuted) patch.icon = String(params.iconMuted);
      if (params.labelMuted) patch.label = String(params.labelMuted);
    } else {
      if (params.iconUnmuted) patch.icon = String(params.iconUnmuted);
      if (params.labelUnmuted) patch.label = String(params.labelUnmuted);
    }
    return patch;
  },
};
