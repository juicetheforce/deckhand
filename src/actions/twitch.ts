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
