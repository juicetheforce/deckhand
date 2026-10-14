import { ActionNeeded, NotSetUp } from '../action-error.js';
import { removeTwitchCredentials, setTwitchCredentials, twitchCredentials, type TwitchCredentials } from '../credentials.js';
import type { TwitchLink, TwitchLinking, TwitchStatus } from '../control/protocol.js';
import * as client from './twitch-client.js';
import { TwitchError } from './twitch-client.js';

/**
 * Twitch: the link to the person's account, and the requests Twitch keys
 * make through it (scope §7, "Streaming integrations"). Unlike OBS and VTube
 * Studio there is no connection: **a key's press is one request**, and
 * nothing else is sent while Twitch is not being linked or checked.
 *
 * **Linking** is by device code: the person approves Deckhand at
 * twitch.tv/activate, in any browser, and this polls Twitch at the interval
 * it gives until they do. **That poll runs only while linking** — until
 * approved, expired, Cancel, or the client that asked closing (scope §7,
 * call 4) — never at rest. A Cancel on Twitch's own page is never seen: the
 * code stays pending until it expires (Twitch session 1).
 *
 * **The hourly check runs while Twitch is linked**, and only then (scope §7,
 * call 1, an accepted timer — ARCHITECTURE): Twitch requires every app that
 * keeps a session to validate its token at start and hourly. It also
 * refreshes the access token before it lapses, so the link stays alive while
 * Deckhand runs — each refresh token's 30 days are its own.
 *
 * **Refresh tokens are single-use, and sending a replaced one ends the whole
 * link** (measured): one refresh at a time, shared by the hourly check and
 * every press; the new pair is saved before anything uses it.
 *
 * **A refused refresh keeps the link** (scope §7): Twitch's own faults have
 * looked exactly like a dead link, so the keys are marked refused and
 * notified, the tokens are kept, and the hourly check keeps trying — if
 * Twitch recovers, so does Deckhand, with nothing for the person to do.
 * Only Remove or a new link clears it.
 */

export type { TwitchLink } from '../control/protocol.js';

/** What the first wave of keys needs, and nothing more (scope §7, call 6). A key needing another scope asks for a new link. */
export const SCOPES = ['channel:manage:broadcast', 'clips:edit', 'user:write:chat'];

/** Twitch's required validation interval. */
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** At a check, refresh when the access token has less than this left: the next check, an hour on, would be too late. */
const REFRESH_WITHIN_MS = 75 * 60 * 1000;
/** What a slow_down adds to the poll interval (RFC 8628; Twitch's answers escalate, measured). */
const SLOW_DOWN_S = 5;

export const NOT_SET_UP_MESSAGE = "Twitch is not linked: link it in Deckhand's Settings › Integrations";
export const REFUSED_MESSAGE = "Twitch no longer accepts Deckhand's link: link again in Deckhand's Settings › Integrations";

interface TwitchState {
  link: TwitchLink;
  login: string | null;
  scopes: string[];
  linking: TwitchLinking;
}

let state: TwitchState = { link: 'not-set-up', login: null, scopes: [], linking: { state: 'none' } };
const listeners = new Set<() => void>();
/** config.json's twitch.clientId: the client ID the next link is made with. */
let configuredClientId: string | undefined;
let checker: NodeJS.Timeout | null = null;
let refreshing: Promise<TwitchCredentials> | null = null;
/** Bumped by every new link and every removal: a refresh answered for an older link is never saved. */
let generation = 0;
/** The link in progress: cancelled stops its poll at once. */
let attempt: { cancelled: boolean; wake(): void } | null = null;

export function cachedState(): TwitchState {
  return state;
}

export function status(): TwitchStatus {
  return { link: state.link, setUp: state.link !== 'not-set-up', login: state.login, scopes: state.scopes, linking: state.linking };
}

/** Called whenever what a key or Settings shows changes. Returns an unsubscribe. */
export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function update(change: Partial<TwitchState>): void {
  const next = { ...state, ...change };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const listener of listeners) listener();
}

/** From each config load: config.json's twitch.clientId, or none for Deckhand's own. Changes the next link only. */
export function setClientId(clientId: string | undefined): void {
  configuredClientId = clientId;
}

/** At the daemon's start: read the saved link, and if there is one, validate it now and hourly after (Twitch's rule). */
export async function start(): Promise<void> {
  let saved: TwitchCredentials | null;
  try {
    saved = await twitchCredentials();
  } catch (err) {
    console.error(`[twitch] cannot read the saved link: ${(err as Error).message}`);
    return;
  }
  if (!saved) return;
  update({ link: 'linked', login: saved.login, scopes: saved.scopes });
  startChecking();
  void check();
}

/** At the daemon's stop. */
export function stop(): void {
  stopChecking();
  cancelLinking();
}

function startChecking(): void {
  checker ??= setInterval(() => void check(), CHECK_EVERY_MS);
}

function stopChecking(): void {
  if (checker) clearInterval(checker);
  checker = null;
}

/**
 * Validate the saved access token, and refresh it if it is invalid, missing,
 * or would lapse before the next check. While refused, try the refresh again.
 * Never throws: a check that fails waits for the next one.
 */
async function check(): Promise<void> {
  try {
    const saved = await twitchCredentials();
    if (!saved) {
      stopChecking();
      update({ link: 'not-set-up', login: null, scopes: [] });
      return;
    }
    const lapsing = !saved.accessToken || (saved.expiresAt ?? 0) - Date.now() < REFRESH_WITHIN_MS;
    if (state.link === 'refused' || lapsing || !(await client.validate(saved.accessToken!))) await refresh(saved.accessToken);
  } catch (err) {
    if (state.link !== 'refused') console.error(`[twitch] the hourly check failed: ${(err as Error).message}`);
  }
}

/** The hourly check, now: for the tests, which cannot wait an hour. */
export const checkNow = check;

/**
 * The one refresh in progress, shared by everyone who needs it. `stale`: the
 * access token the caller found wanting — if another refresh has replaced it
 * since, the saved pair is returned as it is and nothing is spent.
 */
function refresh(stale: string | undefined): Promise<TwitchCredentials> {
  refreshing ??= refreshNow(stale).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshNow(stale: string | undefined): Promise<TwitchCredentials> {
  const linkAtStart = generation;
  const saved = await twitchCredentials();
  if (!saved) throw new NotSetUp(NOT_SET_UP_MESSAGE);
  if (saved.accessToken && saved.accessToken !== stale && state.link !== 'refused') return saved;
  let tokens: client.Tokens;
  try {
    tokens = await client.refreshTokens(saved.clientId, saved.refreshToken);
  } catch (err) {
    if (err instanceof TwitchError && err.kind === 'refused' && linkAtStart === generation) {
      if (state.link !== 'refused') console.error(`[twitch] Twitch refused the refresh ("${err.message}"): the link is kept, and tried again hourly`);
      update({ link: 'refused' });
      throw new ActionNeeded(REFUSED_MESSAGE);
    }
    throw err;
  }
  if (linkAtStart !== generation) {
    // Removed or linked again meanwhile: these tokens belong to nothing saved. Ending them ends only the link they came from.
    void client.revoke(saved.clientId, tokens.refreshToken).catch(() => undefined);
    throw new Error('the Twitch link changed while it was being refreshed');
  }
  const next: TwitchCredentials = {
    ...saved,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : saved.scopes,
  };
  // Saved before anything uses it: the refresh token just sent is spent, and sending it again would end the link.
  await setTwitchCredentials(next);
  if (state.link === 'refused') console.log('[twitch] Twitch accepts the link again');
  update({ link: 'linked', scopes: next.scopes });
  return next;
}

/**
 * A Helix request for a key's press, as the linked account: refreshes first
 * if the access token has lapsed, and once more on a 401, then tries once
 * again. `scope`: what the request needs — a link that does not allow it is
 * asked to be made again. Rejects with a message fit for the key's badge.
 */
export async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, need: { scope: string; what: string }): Promise<Record<string, unknown>> {
  const saved = await twitchCredentials();
  if (!saved) throw new NotSetUp(NOT_SET_UP_MESSAGE);
  if (state.link === 'refused') throw new ActionNeeded(REFUSED_MESSAGE);
  if (!saved.scopes.includes(need.scope)) {
    throw new ActionNeeded(`Twitch's link does not allow ${need.what}: link again in Deckhand's Settings › Integrations`);
  }
  let current = saved;
  if (!current.accessToken || (current.expiresAt ?? 0) <= Date.now()) current = await refresh(current.accessToken);
  try {
    return await client.helix(current.clientId, current.accessToken!, method, path, body);
  } catch (err) {
    if (!(err instanceof TwitchError) || err.kind !== 'unauthorized') throw err;
    current = await refresh(current.accessToken);
    return client.helix(current.clientId, current.accessToken!, method, path, body);
  }
}

/** The linked account's user ID, for a request's broadcaster and sender. */
export async function userId(): Promise<string> {
  const saved = await twitchCredentials();
  if (!saved) throw new NotSetUp(NOT_SET_UP_MESSAGE);
  return saved.userId;
}

/**
 * Settings' Link, or `deckhand twitch link`: ask Twitch for a code, in the
 * background — the "twitch" event carries the code to show, then how it
 * went. Returns at once: null when a link is already in progress, else a
 * function that cancels **this** link only — for when the client that asked
 * goes away (control/commands.ts), so it can never stop a later one.
 */
export function startLinking(): (() => void) | null {
  if (attempt) return null;
  const clientId = configuredClientId ?? client.DECKHAND_CLIENT_ID;
  let wake: () => void = () => undefined;
  const mine = { cancelled: false, wake: () => wake() };
  attempt = mine;
  update({ linking: { state: 'starting', message: 'Asking Twitch for a code…' } });
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  void link(mine, clientId, sleep)
    .catch((err: Error) => {
      if (mine.cancelled) return;
      console.error(`[twitch] linking failed: ${err.message}`);
      update({ linking: { state: 'failed', message: `Linking failed: ${err.message}` } });
    })
    .finally(() => {
      if (attempt === mine) attempt = null;
    });
  return () => {
    if (attempt === mine) cancelLinking();
  };
}

async function link(mine: { cancelled: boolean }, clientId: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  const code = await client.requestDeviceCode(clientId, SCOPES);
  if (mine.cancelled) return;
  const expiresAt = Date.now() + code.expiresIn * 1000;
  let interval = code.interval;
  update({
    linking: {
      state: 'waiting',
      message: `Approve Deckhand at twitch.tv/activate with the code ${code.userCode}`,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt,
    },
  });
  for (;;) {
    // Never sooner than Twitch's interval: an early poll is answered slow_down, and pushes the interval up (measured).
    await sleep(interval * 1000);
    if (mine.cancelled) return;
    if (Date.now() >= expiresAt) {
      update({ linking: { state: 'expired', message: 'The code expired before it was approved. Link again for a new one.' } });
      return;
    }
    let poll: client.Poll;
    try {
      poll = await client.pollDeviceCode(clientId, code.deviceCode, SCOPES);
    } catch (err) {
      // Twitch not answering for a moment: the code is still good, so keep asking until it expires.
      if (err instanceof TwitchError && err.kind === 'unavailable') continue;
      throw err;
    }
    if (mine.cancelled) return;
    if (poll.kind === 'pending') continue;
    if (poll.kind === 'slow-down') {
      interval += SLOW_DOWN_S;
      continue;
    }
    if (poll.kind === 'ended') {
      const expired = /expire/i.test(poll.message);
      update({ linking: { state: expired ? 'expired' : 'failed', message: expired ? 'The code expired before it was approved. Link again for a new one.' : `Twitch said: ${poll.message}` } });
      return;
    }
    await saveLink(clientId, poll.tokens);
    return;
  }
}

/** Approved: learn who the account is, and save the link whole. A link it replaces is forgotten, not revoked. */
async function saveLink(clientId: string, tokens: client.Tokens): Promise<void> {
  const who = await client.validate(tokens.accessToken);
  if (!who) throw new Error('Twitch did not accept the token it had just given');
  generation++;
  // Not revoked: whether ending an older link of the same account ends this
  // one too has not been measured, and if it does, this link would die the
  // moment it was made. An older link left alone lapses by itself in 30 days.
  await setTwitchCredentials({
    clientId,
    userId: who.userId,
    login: who.login,
    scopes: tokens.scopes,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  });
  console.log(`[twitch] linked as ${who.login}`);
  update({ link: 'linked', login: who.login, scopes: tokens.scopes, linking: { state: 'approved', message: `Linked as ${who.login}` } });
  startChecking();
}

/** Deckhand's Cancel, or the client that started the link going away. Does nothing when no link is in progress. */
export function cancelLinking(): void {
  const current = attempt;
  if (!current) return;
  attempt = null;
  current.cancelled = true;
  current.wake();
  update({ linking: { state: 'cancelled', message: 'Linking was cancelled.' } });
}

/**
 * Remove: forget the link, and end it at Twitch — revoking the refresh token
 * ends the whole link (measured). Best effort: the saved link is gone either
 * way. A link in progress is cancelled. No key is touched.
 */
export async function remove(): Promise<void> {
  cancelLinking();
  generation++;
  stopChecking();
  const saved = await twitchCredentials().catch(() => null);
  await removeTwitchCredentials();
  update({ link: 'not-set-up', login: null, scopes: [], linking: { state: 'none' } });
  if (saved) {
    await client.revoke(saved.clientId, saved.refreshToken).catch((err: Error) => {
      console.error(`[twitch] the link is forgotten, but Twitch did not confirm ending it: ${err.message}. It can be ended at twitch.tv/settings/connections`);
    });
  }
}
