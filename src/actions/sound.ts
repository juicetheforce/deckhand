import { expandPath } from '../config.js';
import * as audio from '../services/audio.js';
import * as sounds from '../services/sounds.js';
import type { ActionDef, ActionHandler } from '../types.js';
import { stateIcon } from './state-icon.js';

/**
 * The soundboard: two actions in the Audio section, after Elgato's Soundboard
 * plugin.
 *
 *   { "type": "sound.play", "file": "~/Sounds/airhorn.mp3" }
 *   { "type": "sound.play", "file": "~/Sounds/rain.ogg", "mode": "loopStop",
 *     "node": "alsa_output.usb-…analog-stereo", "label": "USB Headset", "volume": 60 }
 *   { "type": "sound.stopAll" }
 *
 * `file`: WAV, MP3, Ogg or FLAC, `~/` allowed. `node`: an output from the
 * daemon's list (`deckhand sinks`), with `label` for showing — absent plays on
 * the system's default output. An output that is not present fails the press
 * rather than play somewhere else: a sound meant for a virtual sink must not
 * come out of the speakers. `volume`: 0–100, default 100. `mode`:
 *
 *   - `playStop` (the default): a press plays it; a press while it plays stops it.
 *   - `playRestart`: a press while it plays starts it again from the beginning.
 *   - `playOverlap`: every press plays it once more, over any still playing.
 *   - `loopStop`: a press plays it over and over; the next press stops it.
 *   - `hold`: plays while the key is held, and stops when it is let go.
 *
 * The key shows whether its sound is playing or looping (services/sounds.ts):
 * redrawn when a player starts or ends, never on the clock.
 */

/** A key's sound as the service plays it; throws for a key with no file. */
function specOf(params: ActionDef): sounds.SoundSpec {
  const file = typeof params.file === 'string' ? params.file.trim() : '';
  if (file === '') throw new Error('sound.play needs a "file"');
  const node = typeof params.node === 'string' && params.node !== '' ? params.node : null;
  const volume = typeof params.volume === 'number' && Number.isFinite(params.volume) ? Math.max(0, Math.min(100, params.volume)) : 100;
  return { file: expandPath(file), node, volume };
}

function modeOf(params: ActionDef): sounds.PlayMode {
  return (sounds.PLAY_MODES as readonly unknown[]).includes(params.mode) ? (params.mode as sounds.PlayMode) : 'playStop';
}

/** The key's sound id, or null for a key with no file: for its face, which must never throw. */
function idOf(params: ActionDef): string | null {
  try {
    return sounds.soundId(specOf(params), modeOf(params));
  } catch {
    return null;
  }
}

/** The chosen output must be there, read from the audio cache (no pactl spawned); with no cache, the player decides. */
function checkOutput(params: ActionDef, node: string | null): void {
  if (node === null) return;
  const state = audio.cachedState();
  if (!state || state.sinkDevices.some((d) => d.name === node)) return;
  const label = typeof params.label === 'string' && params.label !== '' ? `"${params.label}" (${node})` : node;
  throw new Error(`output ${label} is not present`);
}

export const play: ActionHandler = {
  async execute(ctx, params) {
    const spec = specOf(params);
    const mode = modeOf(params);
    const id = sounds.soundId(spec, mode);
    const name = spec.file.split('/').pop();

    // A press that stops a sound needs neither the file nor the output.
    if ((mode === 'playStop' || mode === 'loopStop') && sounds.stop(id)) {
      ctx.log(`sound: stopped ${name}`);
      return;
    }
    await sounds.checkFile(spec.file);
    checkOutput(params, spec.node);
    // Restart, and a hold pressed again before the last one's release: from the beginning.
    if (mode === 'playRestart' || mode === 'hold') sounds.stop(id);
    if (mode === 'loopStop') await sounds.loop(id, spec);
    else await sounds.play(id, spec);
  },

  /**
   * Hold to play: let go, it stops. Every other mode has nothing to do on a
   * release — and nor does a hold whose sound has ended or never started, so
   * a press that failed keeps its mark (ActionHandler.release).
   */
  async release(ctx, params) {
    if (modeOf(params) !== 'hold') return false;
    const id = idOf(params);
    if (id === null || !sounds.stop(id)) return false;
    ctx.log(`sound: let go, stopped ${String(params.file).split('/').pop()}`);
    return true;
  },

  iconState: (params) => {
    const id = idOf(params);
    if (id === null) return { playing: false };
    return { playing: sounds.isPlaying(id), looping: sounds.isLooping(id) };
  },
  // Its own icon for each state (state-icon.ts): iconOn while it plays, a
  // loop included; iconOff while it does not. Drawn again only when a player
  // starts or ends — index.ts marks the keys stale then — never on the clock.
  redraw: 'events',
  describe: async (_ctx, params) => {
    const id = idOf(params);
    const icon = stateIcon(params, id !== null && sounds.isPlaying(id));
    return icon === undefined ? null : { icon };
  },
};

/**
 * The editor's preview of a clip before it is chosen (the socket's
 * `sound.preview`): the file, on the output and at the volume the key has,
 * once, whatever its press behaviour. Checked as a press is.
 */
export async function preview(params: ActionDef): Promise<void> {
  const spec = specOf(params);
  await sounds.checkFile(spec.file);
  checkOutput(params, spec.node);
  await sounds.preview(spec);
}

export const stopAll: ActionHandler = {
  async execute(ctx) {
    const count = sounds.stopAll();
    ctx.log(count === 0 ? 'sound: stop all — nothing was playing' : `sound: stopped ${count} sound(s)`);
  },
};
