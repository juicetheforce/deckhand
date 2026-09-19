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
  'brightness-set',
  'brightness-up',
  'clock',
  'command',
  'forward',
  'headset',
  'headset-muted',
  'input-cycle',
  'input-select',
  'key-combo',
  'mic',
  'mic-muted',
  'missing',
  'multi-action',
  'next',
  'now-playing',
  'output-cycle',
  'output-select',
  'pause',
  'play',
  'press-release',
  'previous',
  'profile',
  'speaker',
  'speaker-muted',
  'speaker-out',
  'speaker-out-muted',
  'stop',
  'text-macro',
  // No action draws these two by default: the latching toggle is M7
  // (docs/scope.md §6, §7). They can still be chosen for a key as
  // builtin:toggle and builtin:toggle-off.
  'toggle',
  'toggle-off',
  'volume-down',
] as const;

export type BuiltinIcon = (typeof BUILTIN_ICONS)[number];

/** What a state-pair default needs to know: read from the daemon's caches, never from a subprocess or D-Bus call. */
export interface IconState {
  /** audio.micMute: the default input is muted. audio.mute: the default output is muted. */
  muted?: boolean;
  /** media.control playpause: the chosen player is playing. */
  playing?: boolean;
  /** media.info: no player, or nothing with a title or artist. */
  idle?: boolean;
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
 * Null for two reasons, kept apart in the comments below:
 *   - the face is its own content: `clock`'s time, `media.info`'s track while
 *     one plays (call 4);
 *   - `noop`, a deliberate spacer (call 6).
 *
 * Every other action has a drawn icon since 2026-09-17. **A future action
 * whose icon is not drawn yet maps to null too — never to `missing`**, which
 * would put a broken-looking icon on keys that look fine (§7 C1).
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
    case 'keyHold': // Press/Release
      return 'press-release';
    case 'command':
      return 'command';
    case 'profile':
      return 'profile';
    case 'page':
      return action.back === true ? 'back' : 'forward';
    case 'brightness':
      if (typeof action.delta === 'number') return action.delta < 0 ? 'brightness-down' : 'brightness-up';
      return 'brightness-set'; // set brightness (`value`)
    case 'media.info':
      // The track and its art are the face while something plays (call 4);
      // idle, the icon alone, with no "No music" label (the maintainer, 2026-09-16).
      return state.idle ? 'now-playing' : null;
    case 'clock': // the time is the face (call 4)
    case 'noop': // a spacer (call 6)
      return null;
    case 'audio.sink':
      // the maintainer drew this for it, 2026-09-17, replacing `speaker` (§7): a speaker
      // and a headset, one of which the key picks.
      return 'output-select';
    case 'audio.cycle':
      return 'output-cycle';
    case 'audio.cycleSource':
      return 'input-cycle';
    case 'audio.source':
      // the maintainer drew this for it, 2026-09-17 (§10): a desk mic and a headset mic,
      // one of which the key picks. The old `input-select` — the same two with
      // swap arrows — was a cycle icon on a select action and is now
      // `input-cycle`.
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
