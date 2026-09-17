import type { ActionDef } from './types.js';

/**
 * Built-in default icons: which one an action draws when its key has no icon
 * set (docs/scope.md §3, §7 "Phase C icon record", C1 calls).
 *
 * Pure on purpose — no file system, no sharp, no D-Bus — so the editor can
 * import the same mapping for its library and grid (phase C2) instead of
 * keeping a copy that drifts. The daemon turns a name into a file in
 * src/builtin-icons.ts.
 */

/**
 * Every icon in assets/icons/, by file name without `.svg`. A check in
 * scripts/smoke-defaults.mjs fails if this list and the directory disagree,
 * so a newly drawn icon has to be added here to be used as a default.
 */
export const BUILTIN_ICONS = [
  'back',
  'brightness-down',
  'brightness-up',
  'clock',
  'forward',
  'headset',
  'headset-muted',
  'input-select',
  'io-select',
  'key-combo',
  'mic',
  'mic-muted',
  'missing',
  'multi-action',
  'next',
  'now-playing',
  'pause',
  'play',
  'previous',
  'speaker',
  'speaker-muted',
  'speaker-out',
  'speaker-out-muted',
  'stop',
  'text-macro',
  'volume-down',
] as const;

export type BuiltinIcon = (typeof BUILTIN_ICONS)[number];

/** What a state-pair default needs to know: read from the daemon's caches, never from a subprocess or D-Bus call. */
export interface IconState {
  /** audio.micMute: the default input is muted. audio.mute: the default output is muted. */
  muted?: boolean;
  /** media.control playpause: the chosen player is playing. */
  playing?: boolean;
}

const MEDIA_METHODS: Record<string, BuiltinIcon> = {
  play: 'play',
  pause: 'pause',
  next: 'next',
  previous: 'previous',
  prev: 'previous',
  stop: 'stop',
};

/**
 * The built-in a key with this action draws on the deck when it has no icon of
 * its own, or null for none. A default depends on parameters and state, not
 * only the action type (§7): `page`'s `back`, the sign of a `delta`,
 * `media.control`'s `method`, and the mute or play state of the three pairs.
 *
 * Null for three different reasons, kept apart in the comments below:
 *   - the icon has not been drawn yet — never `missing`, which would put a
 *     broken-looking icon on keys that look fine today (§7 C1);
 *   - the face is its own content: `clock`'s time, `media.info`'s track (call 4);
 *   - `noop`, a deliberate spacer (call 6).
 */
export function defaultIconFor(action: ActionDef | undefined, state: IconState = {}): BuiltinIcon | null {
  if (!action) return null;
  switch (action.type) {
    case 'hotkey':
      return 'key-combo';
    case 'text':
      return 'text-macro';
    case 'multi':
      return 'multi-action';
    case 'keyHold': // Press/Release: to be drawn (the maintainer)
    case 'command': // to be drawn (the maintainer)
    case 'profile': // to be drawn (the maintainer)
      return null;
    case 'page':
      return action.back === true ? 'back' : 'forward';
    case 'brightness':
      if (typeof action.delta === 'number') return action.delta < 0 ? 'brightness-down' : 'brightness-up';
      return null; // set brightness (`value`): to be drawn (the maintainer)
    case 'clock': // the time is the face (call 4)
    case 'media.info': // the track and its art are the face (call 4)
    case 'noop': // a spacer (call 6)
      return null;
    case 'audio.sink':
      return 'speaker';
    case 'audio.cycle':
      return 'io-select';
    case 'audio.source':
      return 'input-select';
    case 'audio.micMute':
      return state.muted ? 'mic-muted' : 'mic';
    case 'audio.volume':
      // Volume up is `speaker` (the maintainer): the default delta is +5.
      return typeof action.delta === 'number' && action.delta < 0 ? 'volume-down' : 'speaker';
    case 'audio.mute':
      return state.muted ? 'speaker-muted' : 'speaker';
    case 'media.control': {
      const method = String(action.method ?? 'playpause').toLowerCase();
      // Shows what a press will do: pause while playing (call 2).
      if (method === 'playpause') return state.playing ? 'pause' : 'play';
      return MEDIA_METHODS[method] ?? null;
    }
    default:
      return null;
  }
}
