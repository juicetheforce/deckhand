import type { ActionDef } from './types.js';

/**
 * Built-in default icons: which one an action draws when its key has no icon
 * set.
 *
 * Pure on purpose — no file system, no sharp, no D-Bus — so the editor can
 * import the same mapping for its library and grid instead of
 * keeping a copy that drifts. The daemon turns a name into a file in
 * src/builtin-icons.ts.
 */

/**
 * Every icon in assets/icons/, by file name without `.svg`. A check in
 * scripts/smoke-defaults.mjs fails if this list and the directory disagree,
 * so a newly drawn icon has to be added here to be used as a default.
 */
export const BUILTIN_ICONS = [
  // Open app: the key with an app but no artwork found, and the dimmed key with no app yet.
  'app-launch',
  'app-launch-unset',
  'back',
  'brightness-down',
  'brightness-set',
  'brightness-up',
  'clock',
  'command',
  'deckhand',
  // Discord, in its section colour, sky #5ab8f5: every key inside a round
  // voice ring, which alone says "Discord" beside the bare audio glyphs; an
  // active face is a solid disc with the glyph cut out — red for muted and
  // deafened, sky for voice activity. Join and leave are one-shots.
  'discord-deafen',
  'discord-deafened',
  'discord-join',
  'discord-leave',
  'discord-mute',
  'discord-muted',
  'discord-push-to-talk',
  'discord-user-volume',
  'discord-voice-activity',
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
  // OBS: state pairs, the active face changing
  // shape and colour both — teal a running mode, red broadcasting or muted,
  // amber paused — and one-shot actions. The keys not built yet (replay,
  // virtual camera, studio mode, screenshot, transition, marker) are ready.
  'obs-audio',
  'obs-audio-muted',
  'obs-marker',
  'obs-pause',
  'obs-paused',
  'obs-record',
  'obs-record-on',
  'obs-replay',
  'obs-replay-on',
  'obs-save-replay',
  'obs-scene',
  'obs-scene-active',
  'obs-screenshot',
  'obs-source',
  'obs-source-hidden',
  'obs-stream',
  'obs-stream-on',
  'obs-stream-reconnecting',
  'obs-studio',
  'obs-studio-on',
  'obs-transition',
  'obs-vcam',
  'obs-vcam-on',
  'output-cycle',
  'output-select',
  'pause',
  'play',
  'press-release',
  'previous',
  'profile',
  // The soundboard (sound.play, sound.stopAll): idle an empty pad, playing
  // and looping a solid block.
  'sound-looping',
  'sound-play',
  'sound-playing',
  'sound-stop-all',
  'speaker',
  'speaker-muted',
  'speaker-out',
  'speaker-out-muted',
  'stop',
  'text-macro',
  // The latching toggle's two faces: down and up.
  'toggle',
  'toggle-off',
  // Twitch, in its section colour, apricot #f59a66: one-shot actions, so one
  // face each and no active state. Only the first wave's; the second wave's
  // (ad, raid, chat mode) are added when those actions exist.
  'twitch-chat',
  'twitch-clip',
  'twitch-marker',
  'twitch-stream-info',
  // Virtual deck on/off: the panel's keys lit, and faded.
  'virtual-deck-off',
  'virtual-deck-on',
  'volume-down',
  // VTube Studio, in its section colour, lime: an active face is the glyph
  // filled lime, never OBS teal, so it cannot read as an OBS key. A hotkey
  // whose model is not loaded is dashed at full strength, with no badge —
  // not the dimmed not-set-up face, not the failed X. Tracking lost is
  // amber, the set's caution colour. The keys not built yet (item, hold
  // expression, tracking, reset position) are ready.
  'vts-expression',
  'vts-expression-hold',
  'vts-expression-on',
  'vts-hotkey',
  'vts-hotkey-unavailable',
  'vts-item',
  'vts-item-on',
  'vts-model',
  'vts-model-active',
  'vts-reset-position',
  'vts-tracking',
  'vts-tracking-lost',
] as const;

export type BuiltinIcon = (typeof BUILTIN_ICONS)[number];

/** What a state-pair default needs to know: read from the daemon's caches, never from a subprocess or D-Bus call. */
export interface IconState {
  /** audio.micMute: the default input is muted. audio.mute: the default output is muted. obs.mute: its OBS input is muted. discord.mute, discord.deafen: Discord says so. */
  muted?: boolean;
  /** media.control playpause: the chosen player is playing. sound.play: its sound is playing. */
  playing?: boolean;
  /** sound.play: its sound is playing in a loop. */
  looping?: boolean;
  /** media.info: no player, or nothing with a title or artist. */
  idle?: boolean;
  /** toggle: the key is latched down. */
  latched?: boolean;
  /** obs.stream, obs.record: the stream or recording is running (starting, live, reconnecting or stopping). */
  live?: boolean;
  /** obs.record, obs.recordPause: the recording is paused. */
  paused?: boolean;
  /** obs.stream: OBS is reconnecting the stream. */
  reconnecting?: boolean;
  /** virtual.power: its virtual deck is on. obs.scene: its scene is OBS's program scene. vts.model: its model is the one loaded in VTube Studio. vts.expression: VTube Studio says it is on. discord.inputMode: Discord is on voice activity. */
  active?: boolean;
  /** obs.source: its source is hidden in its scene. */
  hidden?: boolean;
  /** vts.hotkey: its model is not the one loaded in VTube Studio, so a press cannot run it. */
  unavailable?: boolean;
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
 * only the action type: `page`'s `back`, the sign of a `delta`,
 * `media.control`'s `method`, and the mute or play state of the three pairs.
 *
 * Null for two reasons, kept apart in the comments below:
 *   - the face is its own content: `clock`'s time, `media.info`'s track while
 *     one plays;
 *   - `noop`, a deliberate spacer.
 *
 * Every other action has a drawn icon. **A future action
 * whose icon is not drawn yet maps to null too — never to `missing`**, which
 * would put a broken-looking icon on keys that look fine.
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
    // The latching toggle: down and up are two faces, as mute and play are.
    case 'toggle':
      return state.latched ? 'toggle' : 'toggle-off';
    case 'command':
      return 'command';
    // The app's own icon comes first (src/actions/system.ts, defaultIcon); this
    // is what shows without one. An app chosen whose icon the theme does not
    // have: the key works, it just has no artwork. No app chosen yet (a
    // library drop, a hand edit): unfinished, drawn dimmed.
    case 'app':
      return typeof action.app === 'string' && action.app !== '' ? 'app-launch' : 'app-launch-unset';
    case 'editor': // the logo: this key is Deckhand itself
      return 'deckhand';
    case 'profile':
      return 'profile';
    case 'page':
      return action.back === true ? 'back' : 'forward';
    case 'brightness':
      if (typeof action.delta === 'number') return action.delta < 0 ? 'brightness-down' : 'brightness-up';
      return 'brightness-set'; // set brightness (`value`)
    case 'media.info':
      // The track and its art are the face while something plays;
      // idle, the icon alone, with no "No music" label.
      return state.idle ? 'now-playing' : null;
    case 'virtual.power':
      return state.active === false ? 'virtual-deck-off' : 'virtual-deck-on';
    case 'clock': // the time is the face
    case 'noop': // a spacer
      return null;
    case 'audio.sink':
      // A speaker and a headset, one of which the key picks.
      return 'output-select';
    case 'audio.cycle':
      return 'output-cycle';
    case 'audio.cycleSource':
      return 'input-cycle';
    case 'audio.source':
      // A desk mic and a headset mic, one of which the key picks.
      return 'input-select';
    case 'audio.micMute':
      return state.muted ? 'mic-muted' : 'mic';
    case 'audio.volume':
      // Volume up is `speaker`: the default delta is +5.
      return typeof action.delta === 'number' && action.delta < 0 ? 'volume-down' : 'speaker';
    case 'audio.mute':
      return state.muted ? 'speaker-muted' : 'speaker';
    // The soundboard shows what is happening: a solid block while it plays.
    case 'sound.play':
      if (state.looping) return 'sound-looping';
      return state.playing ? 'sound-playing' : 'sound-play';
    case 'sound.stopAll':
      return 'sound-stop-all';
    // Shows what is happening, as the mute pairs do: the state is the point.
    case 'obs.stream':
      // Reconnecting has its own icon: amber, broken arcs, a hollow centre —
      // only live has the solid dot. Never animated: a pulse would repaint
      // the key for as long as it is shown.
      if (state.reconnecting) return 'obs-stream-reconnecting';
      return state.live ? 'obs-stream-on' : 'obs-stream';
    case 'obs.record':
      // Paused is not recording: red would say it is.
      if (state.live && state.paused) return 'obs-paused';
      return state.live ? 'obs-record-on' : 'obs-record';
    case 'obs.recordPause':
      return state.paused ? 'obs-paused' : 'obs-pause';
    case 'obs.scene':
      return state.active ? 'obs-scene-active' : 'obs-scene';
    // One icon per type: several scene, mute or source keys look alike until
    // the person names them — no default label.
    case 'obs.mute':
      return state.muted ? 'obs-audio-muted' : 'obs-audio';
    case 'obs.source':
      return state.hidden ? 'obs-source-hidden' : 'obs-source';
    // Dashed at full strength, no badge: not the dimmed not-set-up face, not the failed X.
    case 'vts.hotkey':
      return state.unavailable ? 'vts-hotkey-unavailable' : 'vts-hotkey';
    case 'vts.model':
      return state.active ? 'vts-model-active' : 'vts-model';
    // Another model loaded: the same face, off — rare, and not worth an icon of its own.
    case 'vts.expression':
      return state.active ? 'vts-expression-on' : 'vts-expression';
    // One face each: nothing live from Twitch is shown.
    case 'twitch.chat':
      return 'twitch-chat';
    case 'twitch.marker':
      return 'twitch-marker';
    case 'twitch.clip':
      return 'twitch-clip';
    case 'twitch.streamInfo':
      return 'twitch-stream-info';
    // Discord: the mute pairs show what is happening, as audio's do; the
    // input mode shows the mode Discord is in.
    case 'discord.mute':
      return state.muted ? 'discord-muted' : 'discord-mute';
    case 'discord.deafen':
      return state.muted ? 'discord-deafened' : 'discord-deafen';
    case 'discord.inputMode':
      return state.active ? 'discord-voice-activity' : 'discord-push-to-talk';
    case 'discord.join':
      return 'discord-join';
    case 'discord.leave':
      return 'discord-leave';
    // One icon whichever way it turns: several user volume keys look alike until named — no default label.
    case 'discord.userVolume':
      return 'discord-user-volume';
    case 'media.control': {
      const method = String(action.method ?? 'playpause').toLowerCase();
      // Shows what a press will do: pause while playing.
      if (method === 'playpause') return state.playing ? 'pause' : 'play';
      return MEDIA_METHODS[method] ?? null;
    }
    default:
      return null;
  }
}

/**
 * A warning a key draws over any icon of its own, the person's included, or
 * null: a stream reconnecting, a recording paused. The deck's OBS faces
 * (src/actions/obs.ts) and the editor's grid both draw by this.
 */
export function warningIconFor(action: ActionDef | undefined, state: IconState): BuiltinIcon | null {
  if (action?.type === 'obs.stream' && state.reconnecting) return 'obs-stream-reconnecting';
  if (action?.type === 'obs.record' && state.live && state.paused) return 'obs-paused';
  return null;
}
