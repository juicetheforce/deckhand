import { ActionNeeded } from '../action-error.js';
import * as discord from '../services/discord.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';
import { MUTED_UNMUTED, stateIcon, withStateIcon } from './state-icon.js';

/**
 * Discord keys, through services/discord.ts. Faces read its cached state,
 * kept current by Discord's own events; a press asks Discord.
 *
 * Every Discord key is drawn dimmed with the not-set-up badge while Discord
 * is not authorized, and with the connecting badge while Discord is
 * answering its handshake — which has taken up to 20 s — so none ever looks
 * dead.
 */

const UNSET: DisplayPatch = { unset: true };
const CONNECTING: DisplayPatch = { connecting: true };

/** The face every Discord key shares: not set up, connecting, or nothing to add. */
function shared(): DisplayPatch | null {
  const { connection } = discord.cachedState();
  if (connection === 'not-set-up') return UNSET;
  if (connection === 'connecting') return CONNECTING;
  return null;
}

const named = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const CHOOSE_AGAIN = 'choose it again in the editor';

/** discord.mute — mute or unmute your microphone in Discord; lit red while muted, from Discord's own events. */
export const mute: ActionHandler = {
  redraw: 'events',
  async execute() {
    await discord.toggleMute();
  },
  iconState: () => ({ muted: discord.cachedState().connection === 'connected' && discord.cachedState().mute === true }),
  // Its own icon for each state (state-icon.ts): iconMuted / iconUnmuted.
  describe: async (_ctx, params) => withStateIcon(shared(), stateIcon(params, discord.cachedState().connection === 'connected' && discord.cachedState().mute === true, MUTED_UNMUTED)),
};

/** discord.deafen — deafen or undeafen in Discord (Discord mutes with it); lit red while deafened. */
export const deafen: ActionHandler = {
  redraw: 'events',
  async execute() {
    await discord.toggleDeaf();
  },
  iconState: () => ({ muted: discord.cachedState().connection === 'connected' && discord.cachedState().deaf === true }),
  // iconOn while deafened, iconOff while not.
  describe: async (_ctx, params) => withStateIcon(shared(), stateIcon(params, discord.cachedState().connection === 'connected' && discord.cachedState().deaf === true)),
};

/**
 * discord.inputMode — switch Discord between push-to-talk and voice
 * activity. The face is the mode Discord is in: voice activity the solid
 * disc, push-to-talk the ring.
 */
export const inputMode: ActionHandler = {
  redraw: 'events',
  async execute() {
    await discord.toggleInputMode();
  },
  iconState: () => ({ active: discord.cachedState().connection === 'connected' && discord.cachedState().mode === 'VOICE_ACTIVITY' }),
  // iconOn on voice activity, iconOff on push-to-talk.
  describe: async (_ctx, params) => withStateIcon(shared(), stateIcon(params, discord.cachedState().connection === 'connected' && discord.cachedState().mode === 'VOICE_ACTIVITY')),
};

/**
 * discord.join — join a voice channel: a one-shot, with no state on the key.
 *
 *   { "type": "discord.join", "guild": "<server ID>", "channel": "<channel ID>",
 *     "guildName": "My server", "channelName": "General" }
 *
 * By ID; the names are kept only to show, and to say what is missing. In
 * another channel, a press moves you.
 */
export const join: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const channel = named(params.channel);
    if (!channel) throw new Error('no voice channel chosen');
    const name = named(params.channelName) ?? 'That voice channel';
    await discord.join(channel, `${name} is not in Discord any more, or not yours to join: ${CHOOSE_AGAIN}`);
  },
  describe: async () => shared(),
};

/** discord.leave — leave the voice channel you are in: a one-shot; in none, it does nothing. */
export const leave: ActionHandler = {
  redraw: 'events',
  async execute() {
    await discord.leave();
  },
  describe: async () => shared(),
};

/**
 * discord.userVolume — nudge the volume you hear one person at, as Volume
 * nudges the output's: `delta` (default +5; negative for quieter), within
 * Discord's 0–200. It changes only what you hear.
 *
 *   { "type": "discord.userVolume", "user": "<user ID>", "userName": "Theo", "delta": 10 }
 *   { "type": "discord.userVolume", "user": "<user ID>", "delta": -10, "showLevel": true }
 *
 * The person must be in the voice channel you are in. The level is shown
 * only with `showLevel: true`, from Discord's events — never asked for in a
 * render.
 */
export const userVolume: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const user = named(params.user);
    if (!user) throw new Error('no one chosen');
    const delta = typeof params.delta === 'number' ? params.delta : 5;
    const name = named(params.userName) ?? 'The person chosen';
    const outcome = await discord.adjustUserVolume(user, delta);
    // Says what to do, so it is notified; someone not in your channel is only marked.
    if ('missing' in outcome && outcome.missing === 'no-channel') throw new ActionNeeded('You are not in a voice channel in Discord: join one first');
    if ('missing' in outcome) throw new Error(`${name} is not in your voice channel`);
  },
  describe: async (_ctx, params: ActionDef) => {
    const face = shared();
    if (face || params.showLevel !== true) return face;
    const s = discord.cachedState();
    const level = s.connection === 'connected' ? s.users[String(params.user)]?.volume : undefined;
    return level === undefined ? null : { label: `${Math.round(level)}%` };
  },
};
