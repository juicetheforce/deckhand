import { ActionNeeded } from '../action-error.js';
import * as twitch from '../services/twitch.js';
import { TwitchError } from '../services/twitch-client.js';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

/**
 * Twitch keys (scope §7, "Streaming integrations"), through
 * services/twitch.ts. **Actions only**: a press is one request as the linked
 * account, on its own channel; no face shows anything live from Twitch, so
 * nothing is asked of Twitch to draw one. Failures only — nothing is notified
 * for a press that worked (scope §7, call 8).
 */

/** Twitch is not linked: every Twitch key draws dimmed, with the not-set-up badge. */
const UNSET: DisplayPatch = { unset: true };
const notSetUp = () => twitch.cachedState().link === 'not-set-up';

/** Twitch's own limit on a chat message. */
const MAX_CHAT = 500;

/** What a failed request tells the key's badge. ActionNeeded and NotSetUp pass through as they are. */
function explain(err: unknown): unknown {
  if (!(err instanceof TwitchError)) return err;
  if (err.kind === 'unavailable') return new Error('Twitch could not be reached');
  if (err.status === 429) return new Error(`Twitch is limiting requests: try again${err.retryAfter ? ` in ${err.retryAfter} s` : ' in a moment'}`);
  if (err.kind === 'unauthorized') return new Error("Twitch refused Deckhand's request");
  return new Error(`Twitch: ${err.message}`);
}

/**
 * twitch.chat — send a chat message to the linked account's own channel, as
 * that account. Works whether or not the channel is live (Twitch session 1).
 *
 *   { "type": "twitch.chat", "message": "Thanks for watching!" }
 *
 * Twitch can accept the request and still not send the message (is_sent
 * false — a duplicate, AutoMod, a channel setting): the key is marked with
 * Twitch's reason.
 */
export const chat: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const message = typeof params.message === 'string' ? params.message : '';
    if (message.trim() === '') throw new Error('no message written');
    if ([...message].length > MAX_CHAT) throw new ActionNeeded(`Twitch takes chat messages of up to ${MAX_CHAT} characters: shorten this one in the editor`);
    let answer: Record<string, unknown>;
    try {
      const id = await twitch.userId();
      answer = await twitch.request('POST', '/chat/messages', { broadcaster_id: id, sender_id: id, message }, { scope: 'user:write:chat', what: 'chat messages' });
    } catch (err) {
      throw explain(err);
    }
    const sent = Array.isArray(answer.data) ? (answer.data[0] as Record<string, unknown> | undefined) : undefined;
    if (sent?.is_sent !== true) {
      const reason = sent?.drop_reason as { message?: unknown; code?: unknown } | null | undefined;
      const why = typeof reason?.message === 'string' && reason.message ? reason.message : typeof reason?.code === 'string' ? reason.code : 'no reason given';
      throw new Error(`Twitch did not send the message: ${why}`);
    }
  },

  describe: async () => (notSetUp() ? UNSET : null),
};

/** Twitch's limit on a marker's description and a stream's title. */
const MAX_DESCRIPTION = 140;
const MAX_TITLE = 140;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * twitch.marker — mark this moment in the live stream, to find it later in
 * the VOD (Twitch's Highlighter, the Stream Manager).
 *
 *   { "type": "twitch.marker", "description": "Boss fight" }
 *
 * Only while live, and only with "Store past broadcasts" on: Twitch answers
 * 404 for both, with a code inside the message for the first
 * (BROADCASTER_NOT_LIVE, measured offline in Twitch session 1).
 */
export const marker: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const description = text(params.description).trim();
    if ([...description].length > MAX_DESCRIPTION) throw new ActionNeeded(`Twitch takes marker descriptions of up to ${MAX_DESCRIPTION} characters: shorten this one in the editor`);
    try {
      const id = await twitch.userId();
      await twitch.request('POST', '/streams/markers', { user_id: id, ...(description ? { description } : {}) }, { scope: 'channel:manage:broadcast', what: 'markers' });
    } catch (err) {
      if (err instanceof TwitchError && err.status === 404) {
        if (err.code === 'BROADCASTER_NOT_LIVE') throw new ActionNeeded('Markers need a live stream: go live on Twitch first');
        // Not live is coded; this is the other 404 Twitch documents — `[inference]` until seen on a live stream.
        throw new ActionNeeded(`Twitch did not add the marker (${err.message}): markers need "Store past broadcasts" on, in Twitch's Creator Dashboard › Settings › Stream`);
      }
      throw explain(err);
    }
  },

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * twitch.clip — clip the live stream: the last `duration` seconds (5–60,
 * Twitch's default 30), with an optional title.
 *
 *   { "type": "twitch.clip", "title": "What a save", "duration": 30 }
 *
 * **Twitch's 202 means accepted, not made**: a clip is made in the
 * background, and Twitch says to assume it failed if Get Clips has not
 * returned it after 60 s. Deckhand does not follow it up — that would be a
 * poll — so a clip that fails later goes unseen, and nothing is notified for
 * one that works (scope §7, call 8).
 */
export const clip: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const title = text(params.title).trim();
    const duration = typeof params.duration === 'number' ? params.duration : undefined;
    if (duration !== undefined && !(duration >= 5 && duration <= 60)) throw new ActionNeeded('A clip is 5 to 60 seconds long: change it in the editor');
    try {
      const id = await twitch.userId();
      const query = new URLSearchParams({ broadcaster_id: id });
      if (title) query.set('title', title);
      if (duration !== undefined) query.set('duration', String(Math.round(duration * 10) / 10));
      await twitch.request('POST', `/clips?${query}`, undefined, { scope: 'clips:edit', what: 'clips' });
    } catch (err) {
      if (err instanceof TwitchError && err.status === 404) throw new ActionNeeded('Clips need a live stream: go live on Twitch first');
      throw explain(err);
    }
  },

  describe: async () => (notSetUp() ? UNSET : null),
};

/**
 * twitch.streamInfo — set the stream's title, its category, or both: what a
 * streamer changes when they switch games. A field left out is left as it
 * is on Twitch. Works live or not.
 *
 *   { "type": "twitch.streamInfo", "title": "Ranked grind", "category": "33214", "categoryName": "Fortnite" }
 *
 * The category is Twitch's ID, chosen in the editor from Twitch's own
 * search, never typed; the name is kept only to show.
 */
export const streamInfo: ActionHandler = {
  redraw: 'events',
  async execute(_ctx, params: ActionDef) {
    const title = text(params.title).trim();
    const category = text(params.category).trim();
    if (!title && !category) throw new Error('no title or category chosen');
    if ([...title].length > MAX_TITLE) throw new ActionNeeded(`Twitch takes titles of up to ${MAX_TITLE} characters: shorten this one in the editor`);
    try {
      const id = await twitch.userId();
      await twitch.request(
        'PATCH',
        `/channels?broadcaster_id=${encodeURIComponent(id)}`,
        { ...(title ? { title } : {}), ...(category ? { game_id: category } : {}) },
        { scope: 'channel:manage:broadcast', what: 'changing the title or category' },
      );
    } catch (err) {
      throw explain(err);
    }
  },

  describe: async () => (notSetUp() ? UNSET : null),
};
