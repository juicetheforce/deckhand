import * as mpris from '../services/mpris.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * media.control — transport controls over MPRIS.
 *
 *   { "type": "media.control", "method": "playpause" }
 *   { "type": "media.control", "method": "next" }
 *   { "type": "media.control", "method": "playpause", "player": "tidal" }
 *
 * Omit "player" and it targets whatever is actually playing, so the same
 * button works for Tidal today and a browser tab tomorrow. A playpause
 * button can swap its icon with iconPlaying / iconPaused.
 */
const METHODS: Record<string, mpris.MediaMethod> = {
  playpause: 'PlayPause',
  play: 'Play',
  pause: 'Pause',
  next: 'Next',
  previous: 'Previous',
  prev: 'Previous',
  stop: 'Stop',
};

export const control: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const key = String(params.method ?? 'playpause').toLowerCase();
    const method = METHODS[key];
    if (!method) throw new Error(`unknown media method "${key}"`);

    const hint = params.player ? String(params.player) : undefined;
    await mpris.call(method, hint);
    ctx.invalidateByType(['media.control', 'media.info']);
  },

  // Cached, like describe(): no D-Bus call on a render.
  iconState: (params) => ({
    playing: mpris.cachedTrackInfo(params.player ? String(params.player) : undefined)?.status === 'Playing',
  }),

  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    const key = String(params.method ?? 'playpause').toLowerCase();
    if (key !== 'playpause') return null;
    if (!params.iconPlaying && !params.iconPaused) return null;

    // From the player state cache: no D-Bus call on a refresh (services/mpris.ts).
    const info = mpris.cachedTrackInfo(params.player ? String(params.player) : undefined);
    const playing = info?.status === 'Playing';
    const icon = playing ? params.iconPlaying : params.iconPaused;
    return icon ? { icon: String(icon) } : null;
  },
};

/** No player, or one with neither title nor artist: what media.info calls idle. */
function isIdle(track: mpris.TrackInfo | null): boolean {
  return !track || (!track.title && !track.artist);
}

/**
 * media.info — a live now-playing button. Pressing it toggles playback.
 *
 *   { "type": "media.info", "showArt": true, "show": "title+artist" }
 *   { "type": "media.info", "idleLabel": "No music" }
 *
 * showArt uses the album art from MPRIS metadata as the button image,
 * downloading remote art to a temp cache once per URL. Idle, the key draws the
 * `now-playing` icon and no label (the maintainer, 2026-09-16); `idleLabel` puts a label
 * back.
 */
export const info: ActionHandler = {
  // Cached: no D-Bus call on a render.
  iconState: (params) => ({ idle: isIdle(mpris.cachedTrackInfo(params.player ? String(params.player) : undefined)) }),

  async execute(ctx, params: ActionDef) {
    if (params.pressAction === 'none') return;
    await mpris.call('PlayPause', params.player ? String(params.player) : undefined);
    ctx.invalidateByType(['media.control', 'media.info']);
  },

  async describe(_ctx, params: ActionDef): Promise<DisplayPatch | null> {
    // From the player state cache: no D-Bus call and no art download on a refresh.
    const track = mpris.cachedTrackInfo(params.player ? String(params.player) : undefined);

    if (!track || isIdle(track)) {
      // No `icon` here: `icon: undefined` used to wipe the key's own icon while
      // idle. With no icon of its own the key gets `now-playing` (iconState).
      return params.idleLabel !== undefined ? { label: String(params.idleLabel) } : null;
    }

    const mode = String(params.show ?? 'title+artist');
    const max = typeof params.maxChars === 'number' ? params.maxChars : 12;

    const lines: string[] = [];
    if (mode !== 'artist' && track.title) lines.push(truncate(track.title, max));
    if (mode !== 'title' && track.artist) lines.push(truncate(track.artist, max));

    const patch: DisplayPatch = { label: lines.join('\n') };
    if (params.showArt !== false && track.artPath) {
      patch.icon = track.artPath;
      patch.iconFit = 'cover';
    }
    return patch;
  },
};
