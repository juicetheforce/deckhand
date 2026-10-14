/**
 * Twitch's two HTTP APIs, as Deckhand uses them: id.twitch.tv's OAuth
 * endpoints (linking by device code, refresh, validate, revoke) and Helix
 * (what keys do). Plain fetch, a one-shot deadline on every request — no
 * timer — and no state: services/twitch.ts holds the link, and is the only
 * caller. What each answer looks like was measured against real Twitch
 * (Twitch session 1, the probe), not only read from its docs.
 *
 * DECKHAND_TWITCH_ID_URL and DECKHAND_TWITCH_API_URL point both at a fake,
 * for tests (scripts/test/fake-twitch.mjs).
 */

/** Deckhand's own client ID: a public client, owned by the project's own Twitch account (scope §7). Public by Twitch's terms. */
export const DECKHAND_CLIENT_ID = 'wak2tnl8hoiznbfq5l8k2rvesfj1ea';

const idUrl = () => process.env.DECKHAND_TWITCH_ID_URL ?? 'https://id.twitch.tv/oauth2';
const apiUrl = () => process.env.DECKHAND_TWITCH_API_URL ?? 'https://api.twitch.tv/helix';

/** How long any one request may take before it counts as Twitch not answering. */
const DEADLINE_MS = 10_000;

/**
 * Why a request failed. `unavailable`: no answer — offline, DNS, a timeout,
 * or Twitch's own 5xx. `unauthorized`: Helix or validate refused the access
 * token (401) — a refresh may fix it. `refused`: a refresh was refused
 * ("Invalid refresh token") — revoked, replayed, lapsed, or Twitch's own
 * fault, which looks the same (scope §7). `answer`: any other refusal, with
 * Twitch's status and message.
 */
export class TwitchError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'unauthorized' | 'refused' | 'answer',
    message: string,
    readonly status?: number,
    /** For a 429: seconds until Twitch's bucket refills, from Ratelimit-Reset. */
    readonly retryAfter?: number,
    /** The code inside a Helix message, such as BROADCASTER_NOT_LIVE; null when there is none. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'TwitchError';
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds; varies (3.7–4.3 h measured). */
  expiresIn: number;
  scopes: string[];
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds the code lives (1800 measured). */
  expiresIn: number;
  /** Seconds between polls (5 measured). Polling sooner is answered slow_down, and pushes it up. */
  interval: number;
}

/** One poll of a device code. `ended`: anything but pending or slow_down — Twitch's message, as given. */
export type Poll = { kind: 'pending' } | { kind: 'slow-down' } | { kind: 'approved'; tokens: Tokens } | { kind: 'ended'; message: string };

export interface Validation {
  clientId: string;
  login: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

async function send(url: string, init: RequestInit): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new TwitchError('unavailable', timedOut ? 'Twitch did not answer in time' : 'Twitch could not be reached');
  }
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's page, an outage): the status says enough.
  }
  if (res.status >= 500) throw new TwitchError('unavailable', 'Twitch could not be reached', res.status);
  return { status: res.status, body, headers: res.headers };
}

const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });

/**
 * Twitch's own words for a refusal. Some Helix messages carry a code inside
 * the string — `code:"BROADCASTER_NOT_LIVE" message:"Stream markers cannot be
 * created when the channel is offline."` (measured) — so the inner message is
 * taken when there is one.
 */
export function messageOf(body: Record<string, unknown>): string {
  const message = text(body.message);
  const inner = /message:"((?:[^"\\]|\\.)*)"/.exec(message);
  return (inner ? inner[1].replace(/\\(.)/g, '$1') : message) || text(body.error) || 'Twitch refused the request';
}

/** The code inside such a message (`BROADCASTER_NOT_LIVE`), or null. */
export function codeOf(body: Record<string, unknown>): string | null {
  return /code:"([A-Z_]+)"/.exec(text(body.message))?.[1] ?? null;
}

function tokensOf(body: Record<string, unknown>): Tokens {
  const accessToken = text(body.access_token);
  const refreshToken = text(body.refresh_token);
  if (!accessToken || !refreshToken) throw new TwitchError('answer', 'Twitch answered without tokens');
  // The token answer's field is `scope`, an array (measured); validate's is `scopes`.
  return { accessToken, refreshToken, expiresIn: Number(body.expires_in) || 0, scopes: strings(body.scope) };
}

/** Start linking: a code for the person to approve at twitch.tv/activate. No secret: Deckhand is a public client. */
export async function requestDeviceCode(clientId: string, scopes: string[]): Promise<DeviceCode> {
  const { status, body } = await send(`${idUrl()}/device`, form({ client_id: clientId, scopes: scopes.join(' ') }));
  if (status !== 200) throw new TwitchError('answer', messageOf(body), status);
  const deviceCode = text(body.device_code);
  const userCode = text(body.user_code);
  const verificationUri = text(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) throw new TwitchError('answer', 'Twitch answered without a code');
  return { deviceCode, userCode, verificationUri, expiresIn: Number(body.expires_in) || 1800, interval: Number(body.interval) || 5 };
}

/**
 * Ask once whether the person has approved. A Cancel on Twitch's page is
 * never seen here — the code stays pending until it expires (measured).
 */
export async function pollDeviceCode(clientId: string, deviceCode: string, scopes: string[]): Promise<Poll> {
  const { status, body } = await send(
    `${idUrl()}/token`,
    form({ client_id: clientId, scopes: scopes.join(' '), device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  );
  if (status === 200) return { kind: 'approved', tokens: tokensOf(body) };
  const message = text(body.message);
  if (message === 'authorization_pending') return { kind: 'pending' };
  if (message === 'slow_down') return { kind: 'slow-down' };
  return { kind: 'ended', message: message || `Twitch answered ${status}` };
}

/**
 * Trade the refresh token for a new pair. **The token sent is spent either
 * way**, and sending it again ends the whole link (measured): the caller
 * saves the new pair before anything else happens, and never retries this
 * with the same token on its own.
 */
export async function refreshTokens(clientId: string, refreshToken: string): Promise<Tokens> {
  const { status, body } = await send(`${idUrl()}/token`, form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }));
  if (status === 200) return tokensOf(body);
  // 400 "Invalid refresh token" measured (the docs say 401): either is a refusal.
  if (status === 400 || status === 401) throw new TwitchError('refused', messageOf(body), status);
  throw new TwitchError('answer', messageOf(body), status);
}

/** Twitch's required check (at start and hourly). Null: the access token is no longer valid (401). */
export async function validate(accessToken: string): Promise<Validation | null> {
  const { status, body } = await send(`${idUrl()}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } });
  if (status === 401) return null;
  if (status !== 200) throw new TwitchError('answer', messageOf(body), status);
  return { clientId: text(body.client_id), login: text(body.login), userId: text(body.user_id), scopes: strings(body.scopes), expiresIn: Number(body.expires_in) || 0 };
}

/** Revoke a token. Revoking the **refresh** token ends the whole link; revoking only the access token does not (measured). */
export async function revoke(clientId: string, token: string): Promise<void> {
  const { status, body } = await send(`${idUrl()}/revoke`, form({ client_id: clientId, token }));
  if (status !== 200) throw new TwitchError('answer', messageOf(body), status);
}

/** A Helix request as the linked account. Rejects with `unauthorized` on a 401, so the caller can refresh once and retry. */
export async function helix(clientId: string, accessToken: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
  const answer = await send(`${apiUrl()}${path}`, {
    method,
    headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  if (answer.status === 401) throw new TwitchError('unauthorized', messageOf(answer.body), 401);
  if (answer.status === 429) {
    const reset = Number(answer.headers.get('ratelimit-reset'));
    const retryAfter = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : undefined;
    throw new TwitchError('answer', messageOf(answer.body), 429, retryAfter);
  }
  throw new TwitchError('answer', messageOf(answer.body), answer.status, undefined, codeOf(answer.body));
}
