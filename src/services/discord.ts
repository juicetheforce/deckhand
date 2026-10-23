import { createHash, randomBytes } from 'node:crypto';
import { ActionNeeded, NotSetUp, StillConnecting } from '../action-error.js';
import { discordCredentials, removeDiscordCredentials, setDiscordCredentials, type DiscordCredentials } from '../credentials.js';
import type { DiscordApproval, DiscordConnection, DiscordList, DiscordStatus } from '../control/protocol.js';
import {
  DiscordClient,
  DiscordError,
  DiscordTokenError,
  exchangeCode,
  findSocket,
  refreshTokens,
  revokeToken,
  SCOPES,
} from './discord-client.js';

/**
 * The Discord desktop app, through its local RPC (discord-client.ts): the
 * connection, the authorization each person gives their own application,
 * and the voice state Discord keys show. The same shape as services/vts.ts,
 * with one decided difference:
 *
 * **Connected while Discord runs and the active profile has a Discord key
 * on any page** — not only a shown one, as OBS and VTube Studio are (scope
 * §7, "Discord", Ryan 2026-10-22; ARCHITECTURE). Discord's handshake has
 * taken up to 20 s (measured on both clients), which would otherwise fall
 * on the first press after every page switch. Not a precedent. An idle
 * connection costs nothing — Discord sends events only on change — and
 * there is **no timer of its own**: when Discord is not running, the next
 * try is the daemon's 60-second safety scan (retry), or a press.
 *
 * **A press never waits on a handshake.** Not connected yet, a press starts
 * connecting if nothing is, and is refused at once saying Discord is
 * connecting — never marked, as its face already shows it (StillConnecting).
 * While the handshake runs, every Discord key shows a connecting badge, so
 * none looks dead.
 *
 * **Not set up** — no saved authorization — nothing connects. **Only
 * Settings' Connect ever asks Discord to authorize** (requestAccess), with
 * the person's own application ID; no key, scan or reconnect does.
 * Tokens are refreshed only when connecting, and only near or past their end
 * — no timer (the timer list is unchanged). A refused refresh with the access
 * token spent, or an application ID Discord does not know, is **refused**:
 * never retried until Connect again.
 *
 * Mute, deafen and the input mode come from Discord's VOICE_SETTINGS_UPDATE,
 * and the people in your voice channel, with the volume you hear each at,
 * from VOICE_STATE_* — subscribed only while the profile has a User volume
 * key. Never polled. Key faces read cachedState() only — never a request in a
 * render. A press asks Discord afresh where it needs a value.
 */

export type { DiscordConnection } from '../control/protocol.js';

export type InputMode = 'PUSH_TO_TALK' | 'VOICE_ACTIVITY';

export interface DiscordState {
  connection: DiscordConnection;
  /** Mute, deafen and the input mode, as Discord last said; null while not known (not connected). */
  mute: boolean | null;
  deaf: boolean | null;
  mode: InputMode | null;
  /** The voice channel you are in, by ID; null in none, or not known. */
  channelId: string | null;
  /** The others in that channel, by user ID: the volume you hear each at (0–200) and their name. Kept only while a User volume key wants it. */
  users: Record<string, { volume: number; name: string }>;
  approval: DiscordApproval;
}

/** Refresh when connecting with less than this left: the token lasts seven days (measured). */
const REFRESH_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
/** SELECT_VOICE_CHANNEL's own wait, in seconds, and the command's deadline past it. */
const JOIN_TIMEOUT_S = 10;
const JOIN_DEADLINE_MS = 15_000;
/** How long a picker waits on the handshake: under the editor's 10 s for any reply. A one-shot deadline. */
const LIST_WAIT_MS = 8000;
/** Discord's range for the volume you hear someone at. */
export const MAX_USER_VOLUME = 200;

const SETTINGS = "Deckhand's Settings › Integrations › Discord";
export const NOT_SET_UP_MESSAGE = `Discord is not set up: connect it in ${SETTINGS}`;
export const REFUSED_MESSAGE = `Discord no longer accepts Deckhand: Connect again in ${SETTINGS}`;
export const NOT_RUNNING_MESSAGE = 'Discord is not running: start it, then press again';
export const CONNECTING_MESSAGE = 'Discord is still connecting: press again in a moment';

/** With no connection, nothing Discord showed is known any more. */
const NOTHING_KNOWN = { mute: null, deaf: null, mode: null, channelId: null, users: {} } as const;

let state: DiscordState = { connection: 'idle', ...NOTHING_KNOWN, approval: { state: 'none' } };
let client: DiscordClient | null = null;
let connecting: Promise<DiscordClient> | null = null;
/** The active profile has a Discord key on some page: keep connected. */
let wanted = false;
/** …and one of them is a User volume key: keep the channel's people. */
let wantUsers = false;
/** The channel whose voice states are subscribed, or null. */
let usersChannel: string | null = null;
/** The signed-in account's ID, from AUTHENTICATE: not one of "the others". */
let selfId: string | null = null;
/** Presses and picker lists under way: the connection is kept until each is answered. */
let pressing = 0;
/** The connection an authorization is waiting on, while Discord shows its window. */
let asking: DiscordClient | null = null;
/** The one refresh under way, shared: a refresh token is spent once. */
let refreshing: Promise<DiscordCredentials> | null = null;
/** Counts authorizations saved and removed: a connect begun on an older one is not used. */
let generation = 0;
const listeners = new Set<() => void>();

export function cachedState(): DiscordState {
  return state;
}

/** Called whenever the state a key or Settings shows changes. Returns an unsubscribe. */
export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function update(change: Partial<DiscordState>): void {
  const next = { ...state, ...change };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  announce();
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** The "discord.status" reply: never a token. */
export async function status(): Promise<DiscordStatus> {
  const saved = await discordCredentials().catch(() => null);
  return {
    connection: state.connection,
    setUp: saved !== null,
    clientId: saved?.clientId ?? null,
    userName: saved ? saved.userName || null : null,
    approval: state.approval,
  };
}

/**
 * Whether the active profile has a Discord key on any page, and whether one
 * is a User volume key. Wanted: connect if not connected. Not: let go.
 */
export function setWanted(want: boolean, users = false): void {
  const usersChanged = users !== wantUsers;
  wantUsers = users;
  if (usersChanged && client?.isOpen) void followChannel(client, users ? state.channelId : null);
  if (want === wanted) return;
  wanted = want;
  if (want) {
    if (state.connection !== 'refused') void ensureConnected().catch(() => undefined);
  } else {
    disconnect();
  }
}

/** From the daemon's 60-second safety scan: try again if a key wants Discord and it was not there. Does nothing otherwise. */
export function retry(): void {
  if (wanted && state.connection === 'unavailable' && !client && !connecting) void ensureConnected().catch(() => undefined);
}

/** Every key failure a press can have, as the badge and the notification say it. */
async function pressWith<T>(run: (connected: DiscordClient) => Promise<T>): Promise<T> {
  return holding(async () => {
    if (!client?.isOpen) {
      if (state.connection === 'refused') throw new ActionNeeded(REFUSED_MESSAGE);
      if (!(await discordCredentials().catch(() => null))) throw new NotSetUp(NOT_SET_UP_MESSAGE);
      if (!connecting && !(await findSocket())) {
        update({ connection: 'unavailable', ...NOTHING_KNOWN });
        throw new ActionNeeded(NOT_RUNNING_MESSAGE);
      }
      // Never wait on the handshake (scope §7): start it if nothing has, and say so now.
      void ensureConnected().catch(() => undefined);
      throw new StillConnecting(CONNECTING_MESSAGE);
    }
    try {
      return await run(client);
    } catch (err) {
      if (err instanceof DiscordError && err.kind === 'unavailable') throw new ActionNeeded(NOT_RUNNING_MESSAGE);
      if (err instanceof DiscordError && err.kind === 'answer') throw new Error(`Discord refused: ${err.message}`);
      throw err;
    }
  });
}

/** Mute: on if off, off if on, as Discord last said. */
export function toggleMute(): Promise<void> {
  return pressWith(async (connected) => {
    applySettings(await connected.command('SET_VOICE_SETTINGS', { mute: state.mute !== true }));
  });
}

/** Deafen: on if off, off if on. Discord mutes with it, and says so. */
export function toggleDeaf(): Promise<void> {
  return pressWith(async (connected) => {
    applySettings(await connected.command('SET_VOICE_SETTINGS', { deaf: state.deaf !== true }));
  });
}

/** Push-to-talk ⇄ voice activity. Only the type is sent: Discord keeps the rest of the mode (measured). */
export function toggleInputMode(): Promise<InputMode> {
  return pressWith(async (connected) => {
    const next: InputMode = state.mode === 'PUSH_TO_TALK' ? 'VOICE_ACTIVITY' : 'PUSH_TO_TALK';
    applySettings(await connected.command('SET_VOICE_SETTINGS', { mode: { type: next } }));
    return next;
  });
}

/**
 * Join a voice channel. Already in it: nothing is sent. `force`: moves you
 * from the channel you are in, as a press means. The reply is the channel —
 * **Discord sent no VOICE_CHANNEL_SELECT for a join in the probe** (it did
 * for a leave) — so the cache follows the reply.
 */
export function join(channelId: string, notFound: string): Promise<'joined' | 'already'> {
  return pressWith(async (connected) => {
    if (state.channelId === channelId) return 'already';
    let reply: Record<string, unknown>;
    try {
      reply = await connected.command('SELECT_VOICE_CHANNEL', { channel_id: channelId, force: true, timeout: JOIN_TIMEOUT_S }, { timeoutMs: JOIN_DEADLINE_MS });
    } catch (err) {
      // 4005: invalid channel — gone, or a server you have left.
      if (err instanceof DiscordError && err.code === 4005) throw new ActionNeeded(notFound);
      if (err instanceof DiscordError && err.code === 5001) throw new Error('Discord could not join the channel in time');
      throw err;
    }
    const joined = typeof reply.id === 'string' ? reply.id : channelId;
    console.log(`[discord] voice channel ${joined} (the join's reply)`);
    if (client === connected) {
      update({ channelId: joined });
      void followChannel(connected, wantUsers ? joined : null);
    }
    return 'joined';
  });
}

/** Leave the voice channel you are in. In none: nothing is sent. */
export function leave(): Promise<'left' | 'none'> {
  return pressWith(async (connected) => {
    const current = await connected.command('GET_SELECTED_VOICE_CHANNEL');
    if (typeof current.id !== 'string') {
      if (client === connected) update({ channelId: null });
      return 'none';
    }
    await connected.command('SELECT_VOICE_CHANNEL', { channel_id: null }, { timeoutMs: JOIN_DEADLINE_MS });
    if (client === connected) {
      update({ channelId: null });
      void followChannel(connected, null);
    }
    return 'left';
  });
}

/**
 * Change the volume you hear someone at by `delta`, within Discord's 0–200.
 * Read from Discord first, not the cache: they must be in the voice
 * channel you are in now. Resolves the new level, or what is missing — you
 * in no channel, or them not in yours — and then nothing is sent. At the
 * end of the range nothing is sent either.
 */
export function adjustUserVolume(userId: string, delta: number): Promise<{ volume: number } | { missing: 'no-channel' | 'not-in-channel' }> {
  return pressWith(async (connected) => {
    const channel = await connected.command('GET_SELECTED_VOICE_CHANNEL');
    if (typeof channel.id !== 'string') return { missing: 'no-channel' as const };
    const them = voiceStates(channel).find((v) => v.id === userId);
    if (!them) return { missing: 'not-in-channel' as const };
    const next = Math.max(0, Math.min(MAX_USER_VOLUME, Math.round(them.volume + delta)));
    if (next === Math.round(them.volume)) return { volume: next };
    const reply = await connected.command('SET_USER_VOICE_SETTINGS', { user_id: userId, volume: next });
    const volume = typeof reply.volume === 'number' ? reply.volume : next;
    if (client === connected && usersChannel !== null && state.users[userId]) update({ users: { ...state.users, [userId]: { ...state.users[userId], volume } } });
    return { volume };
  });
}

/**
 * What a Discord key's picker offers, asked of Discord now — connecting as
 * the profile does, waiting up to 8 s for the handshake (a picker can; a
 * press never does), and letting go after if the profile has no Discord
 * key: your servers, one server's voice channels, or the others in your
 * voice channel.
 */
export async function list(kind: 'guilds' | 'channels' | 'users', guildId?: string): Promise<DiscordList> {
  return holding(async () => {
    let connected: DiscordClient;
    try {
      let deadline: NodeJS.Timeout | undefined;
      const slow = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new DiscordError('slow', 'still connecting')), LIST_WAIT_MS);
      });
      connected = await Promise.race([ensureConnected(), slow]).finally(() => clearTimeout(deadline));
    } catch (err) {
      if (err instanceof NotSetUp) return { ok: false, reason: 'not-set-up', message: err.message };
      if (err instanceof DiscordError && (err.kind === 'refused' || err.kind === 'invalid-client')) return { ok: false, reason: 'refused', message: REFUSED_MESSAGE };
      if (err instanceof DiscordError && err.kind === 'slow') return { ok: false, reason: 'connecting', message: 'Discord is slow to answer: ask again in a moment' };
      return { ok: false, reason: 'unavailable', message: 'Start Discord to choose' };
    }
    try {
      if (kind === 'guilds') {
        const { guilds } = await connected.command('GET_GUILDS');
        return { ok: true, items: named(guilds) };
      }
      if (kind === 'channels') {
        if (!guildId) return { ok: false, reason: 'other', message: 'Choose a server first' };
        const { channels } = await connected.command('GET_CHANNELS', { guild_id: guildId });
        // 2: voice, 13: stage.
        return { ok: true, items: named(Array.isArray(channels) ? channels.filter((c) => c && (c.type === 2 || c.type === 13)) : []) };
      }
      const channel = await connected.command('GET_SELECTED_VOICE_CHANNEL');
      if (typeof channel.id !== 'string') return { ok: false, reason: 'no-channel', message: 'Join a voice channel in Discord to choose someone in it' };
      return { ok: true, items: voiceStates(channel).map(({ id, name }) => ({ id, name })) };
    } catch (err) {
      return { ok: false, reason: err instanceof DiscordError && err.kind === 'unavailable' ? 'unavailable' : 'other', message: (err as Error).message };
    }
  });
}

/** Keep the connection open while `run` needs it; with no Discord key in the profile, let it go after. */
async function holding<T>(run: () => Promise<T>): Promise<T> {
  pressing++;
  try {
    return await run();
  } finally {
    pressing--;
    if (!wanted && pressing === 0) disconnect();
  }
}

function ensureConnected(): Promise<DiscordClient> {
  if (client?.isOpen) return Promise.resolve(client);
  if (state.connection === 'refused') return Promise.reject(new DiscordError('refused', REFUSED_MESSAGE));
  if (connecting) return connecting;
  connecting = connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Open a connection whose events and close count only while it is the one in use. */
async function openClient(path: string, clientId: string): Promise<DiscordClient> {
  let opened: DiscordClient | null = null;
  opened = await DiscordClient.connect({
    path,
    clientId,
    onEvent: (evt, data) => {
      if (opened && client === opened) onEvent(opened, evt, data);
    },
    onClose: () => {
      if (!opened || client !== opened) return;
      // Discord quit, or closed it: the next try rides the 60-second scan.
      client = null;
      usersChannel = null;
      console.log('[discord] Discord closed the connection');
      update({ connection: 'unavailable', ...NOTHING_KNOWN });
    },
  });
  return opened;
}

async function connect(): Promise<DiscordClient> {
  const begun = generation;
  // Read first, and outside the try: not set up is not Discord being unavailable,
  // and the 60-second scan must not retry it (retry() only retries unavailable).
  const saved = await discordCredentials().catch((err: Error) => {
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  });
  if (!saved) {
    update({ connection: 'not-set-up', ...NOTHING_KNOWN });
    throw new NotSetUp(NOT_SET_UP_MESSAGE);
  }
  const path = await findSocket();
  if (!path) {
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw new DiscordError('unavailable', NOT_RUNNING_MESSAGE);
  }
  update({ connection: 'connecting' });
  let tokens = saved;
  let refreshed = false;
  if (saved.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
    const outcome = await refresh(saved);
    if (outcome instanceof DiscordCredentials_) {
      tokens = outcome.saved;
      refreshed = true;
    } else if (saved.expiresAt <= Date.now()) {
      // Spent, and no new one: refused for good, or Discord unreachable for now.
      return failConnect(outcome);
    }
  }
  let opened: DiscordClient;
  try {
    opened = await openClient(path, tokens.clientId);
  } catch (err) {
    if (err instanceof DiscordError && err.kind === 'invalid-client') {
      console.error(`[discord] Discord does not know the saved application ID ${tokens.clientId}`);
      update({ connection: 'refused', ...NOTHING_KNOWN });
      throw new DiscordError('refused', REFUSED_MESSAGE);
    }
    console.error(`[discord] could not connect: ${(err as Error).message}`);
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  }
  try {
    let auth: Record<string, unknown>;
    try {
      auth = await opened.command('AUTHENTICATE', { access_token: tokens.accessToken });
    } catch (err) {
      if (!(err instanceof DiscordError) || err.kind !== 'answer' || refreshed) throw err;
      // Not accepted: a refresh may fix it, once.
      const outcome = await refresh(tokens);
      if (!(outcome instanceof DiscordCredentials_)) throw outcome.kind === 'refused' ? new DiscordError('refused', REFUSED_MESSAGE) : new DiscordError('unavailable', outcome.message);
      auth = await opened.command('AUTHENTICATE', { access_token: outcome.saved.accessToken });
    }
    // Connect again or Remove happened meanwhile: this authorization is not the one in use.
    if (generation !== begun) throw new DiscordError('unavailable', 'the authorization changed while connecting');
    await startSession(opened, auth);
  } catch (err) {
    opened.close();
    if (err instanceof DiscordError && (err.kind === 'answer' || err.kind === 'refused')) {
      console.error(`[discord] Discord no longer accepts the saved authorization${err.kind === 'answer' ? `: ${err.message}` : ''}`);
      update({ connection: 'refused', ...NOTHING_KNOWN });
      throw new DiscordError('refused', REFUSED_MESSAGE);
    }
    if (state.connection === 'connecting') update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  }
  // No longer wanted while it connected (the profile changed), and nothing waiting: let it go.
  if (!wanted && pressing === 0) disconnect();
  return opened;
}

function failConnect(outcome: DiscordTokenError): never {
  if (outcome.kind === 'refused') {
    console.error(`[discord] Discord refused to refresh the authorization: ${outcome.message}`);
    update({ connection: 'refused', ...NOTHING_KNOWN });
    throw new DiscordError('refused', REFUSED_MESSAGE);
  }
  update({ connection: 'unavailable', ...NOTHING_KNOWN });
  throw new DiscordError('unavailable', outcome.message);
}

/** Wraps a refresh's saved result, so it is told apart from its failure. */
class DiscordCredentials_ {
  constructor(readonly saved: DiscordCredentials) {}
}

/**
 * Trade the refresh token for a new pair, saved — in one write — before
 * anything uses it. One at a time. Resolves the failure rather than throwing:
 * the caller decides whether the old access token will still do.
 */
async function refresh(saved: DiscordCredentials): Promise<DiscordCredentials_ | DiscordTokenError> {
  refreshing ??= (async () => {
    const tokens = await refreshTokens(saved.clientId, saved.refreshToken);
    const next: DiscordCredentials = {
      ...saved,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : saved.scopes,
    };
    await setDiscordCredentials(next);
    console.log('[discord] refreshed the authorization');
    return next;
  })().finally(() => {
    refreshing = null;
  });
  try {
    return new DiscordCredentials_(await refreshing);
  } catch (err) {
    if (err instanceof DiscordTokenError) return err;
    return new DiscordTokenError('unavailable', (err as Error).message);
  }
}

/** An authenticated connection becomes the one in use: what keys show is read, then kept by events. */
async function startSession(opened: DiscordClient, auth: Record<string, unknown>): Promise<void> {
  selfId = typeof record(auth.user).id === 'string' ? (record(auth.user).id as string) : null;
  const settings = await opened.command('GET_VOICE_SETTINGS');
  await opened.subscribe('VOICE_SETTINGS_UPDATE');
  await opened.subscribe('VOICE_CHANNEL_SELECT');
  const channel = await opened.command('GET_SELECTED_VOICE_CHANNEL');
  client = opened;
  usersChannel = null;
  const channelId = typeof channel.id === 'string' ? channel.id : null;
  console.log('[discord] connected');
  update({ connection: 'connected', ...NOTHING_KNOWN, ...settingsOf(settings), channelId });
  if (wantUsers) await followChannel(opened, channelId, channel);
}

/**
 * Keep the people in `channelId` (null: none): unsubscribe the last
 * channel's voice states, subscribe this one's. Subscribing sends everyone
 * in it at once (measured), and GET_SELECTED_VOICE_CHANNEL's answer, when
 * given, fills it before then.
 */
async function followChannel(connected: DiscordClient, channelId: string | null, channel?: Record<string, unknown>): Promise<void> {
  if (usersChannel === channelId) return;
  const previous = usersChannel;
  usersChannel = channelId;
  const users: DiscordState['users'] = {};
  for (const v of channel ? voiceStates(channel) : []) users[v.id] = { volume: v.volume, name: v.name };
  update({ users });
  try {
    if (previous) for (const evt of VOICE_STATE_EVENTS) await connected.unsubscribe(evt, { channel_id: previous }).catch(() => undefined);
    if (channelId) for (const evt of VOICE_STATE_EVENTS) await connected.subscribe(evt, { channel_id: channelId });
  } catch (err) {
    console.error(`[discord] could not follow the voice channel: ${(err as Error).message}`);
  }
}

const VOICE_STATE_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE'];

function onEvent(connected: DiscordClient, evt: string, data: Record<string, unknown>): void {
  if (evt === 'VOICE_SETTINGS_UPDATE') {
    applySettings(data);
  } else if (evt === 'VOICE_CHANNEL_SELECT') {
    const channelId = typeof data.channel_id === 'string' ? data.channel_id : null;
    // Logged: whether a join sends this is open (scope §7), and the journal answers it.
    console.log(`[discord] voice channel ${channelId ?? 'none'} (Discord's event)`);
    update({ channelId });
    if (wantUsers) void followChannel(connected, channelId);
  } else if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE') {
    const [v] = voiceStates({ voice_states: [data] });
    if (v && usersChannel !== null) update({ users: { ...state.users, [v.id]: { volume: v.volume, name: v.name } } });
  } else if (evt === 'VOICE_STATE_DELETE') {
    const id = record(data.user).id;
    if (typeof id === 'string' && state.users[id]) {
      const users = { ...state.users };
      delete users[id];
      update({ users });
    }
  }
}

function applySettings(data: Record<string, unknown>): void {
  update(settingsOf(data));
}

function settingsOf(data: Record<string, unknown>): Partial<DiscordState> {
  const change: Partial<DiscordState> = {};
  if (typeof data.mute === 'boolean') change.mute = data.mute;
  if (typeof data.deaf === 'boolean') change.deaf = data.deaf;
  const type = record(data.mode).type;
  if (type === 'PUSH_TO_TALK' || type === 'VOICE_ACTIVITY') change.mode = type;
  return change;
}

/** The others in a channel answer (GET_SELECTED_VOICE_CHANNEL, or one VOICE_STATE_* event): ID, volume, and the name Discord shows. */
function voiceStates(channel: Record<string, unknown>): Array<{ id: string; volume: number; name: string }> {
  const list = Array.isArray(channel.voice_states) ? channel.voice_states : [];
  return list.flatMap((entry: unknown) => {
    const v = record(entry);
    const user = record(v.user);
    if (typeof user.id !== 'string' || user.id === selfId) return [];
    const name = [v.nick, user.global_name, user.username].find((n): n is string => typeof n === 'string' && n !== '') ?? user.id;
    return [{ id: user.id, volume: typeof v.volume === 'number' ? v.volume : 100, name }];
  });
}

function named(value: unknown): Array<{ id: string; name: string }> {
  return (Array.isArray(value) ? value : []).flatMap((entry: unknown) => {
    const item = record(entry);
    return typeof item.id === 'string' ? [{ id: item.id, name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id }] : [];
  });
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function disconnect(): void {
  const open = client;
  client = null;
  usersChannel = null;
  open?.close();
  if (state.connection === 'connected' || state.connection === 'connecting') update({ connection: 'idle', ...NOTHING_KNOWN });
}

/**
 * Settings' Connect: authorize Deckhand in Discord with the person's own
 * application, in the background — the "discord" event says how it goes.
 * Resolves at once: false when one is already under way.
 *
 * Discord shows its Authorize window and this waits for the person, **with
 * no deadline**, until Cancel. Authorize gives a code, exchanged for tokens
 * with PKCE and no secret (measured); the tokens are saved, and the same
 * connection — already through its slow handshake — becomes the one keys use.
 */
export async function requestAccess(clientId: string): Promise<boolean> {
  if (state.approval.state === 'checking' || state.approval.state === 'waiting') return false;
  update({ approval: { state: 'checking', message: 'Looking for Discord…' } });
  void ask(clientId).catch((err: Error) => {
    console.error(`[discord] authorizing failed: ${err.message}`);
    update({ approval: { state: 'failed', message: err.message } });
  });
  return true;
}

async function ask(clientId: string): Promise<void> {
  const path = await findSocket();
  if (!path) {
    update({ approval: { state: 'not-running', message: 'Discord is not running. Start it, then Connect again.' } });
    return;
  }
  let opened: DiscordClient;
  try {
    opened = await openClient(path, clientId);
  } catch (err) {
    const kind = err instanceof DiscordError ? err.kind : 'unavailable';
    const message =
      kind === 'invalid-client'
        ? 'Discord does not know that Application ID. Copy it again from General Information in the Developer Portal.'
        : kind === 'slow'
          ? 'Discord did not answer in time. Connect again in a moment.'
          : 'Discord closed the connection. Connect again once it is running.';
    update({ approval: { state: 'failed', message } });
    return;
  }
  asking = opened;
  update({ approval: { state: 'waiting', message: 'Approve Deckhand in Discord’s Authorize window.' } });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  try {
    let code: string;
    try {
      const reply = await opened.command('AUTHORIZE', { client_id: clientId, scopes: SCOPES, code_challenge: challenge, code_challenge_method: 'S256' }, { timeoutMs: null });
      code = typeof reply.code === 'string' ? reply.code : '';
      if (!code) throw new DiscordError('answer', 'Discord answered without a code');
    } catch (err) {
      // Cancelled or removed while waiting: that has already said so.
      if (asking !== opened) return;
      update({ approval: authorizeFailure(err) });
      return;
    }
    let tokens;
    try {
      tokens = await exchangeCode(clientId, code, verifier);
    } catch (err) {
      if (asking !== opened) return;
      const e = err instanceof DiscordTokenError ? err : new DiscordTokenError('unavailable', (err as Error).message);
      const message =
        e.error === 'invalid_client'
          ? 'Discord refused the authorization: turn on Public Client under OAuth2 in the Developer Portal, Save Changes, then Connect again.'
          : e.kind === 'unavailable'
            ? 'Discord’s servers could not be reached. Check the connection, then Connect again.'
            : `Discord refused the authorization: ${e.message}`;
      update({ approval: { state: 'failed', message } });
      return;
    }
    if (asking !== opened) return;
    const auth = await opened.command('AUTHENTICATE', { access_token: tokens.accessToken });
    const user = record(auth.user);
    const userName = [user.global_name, user.username].find((n): n is string => typeof n === 'string' && n !== '') ?? '';
    await setDiscordCredentials({
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      scopes: tokens.scopes,
      userName,
    });
    asking = null;
    generation++;
    console.log(`[discord] authorized as ${userName || 'a Discord account'}`);
    // The connection in use, if any, was made with the old authorization: this one replaces it.
    disconnect();
    if (state.connection === 'refused' || state.connection === 'not-set-up') update({ connection: 'idle' });
    update({ approval: { state: 'approved', message: `Authorized${userName ? ` as ${userName}` : ''}. Discord keys connect while Discord runs and the profile has them.` } });
    if (wanted) {
      try {
        await startSession(opened, auth);
        return;
      } catch (err) {
        console.error(`[discord] could not start on the new authorization: ${(err as Error).message}`);
        update({ connection: 'unavailable', ...NOTHING_KNOWN });
      }
    }
    opened.close();
    announce();
  } finally {
    if (asking === opened) {
      asking = null;
      opened.close();
    }
  }
}

function authorizeFailure(err: unknown): DiscordApproval {
  if (err instanceof DiscordError && err.kind === 'answer') {
    if (/redirect_uri/i.test(err.message)) {
      return { state: 'failed', message: 'Discord refused: add http://127.0.0.1 as a redirect under OAuth2 in the Developer Portal, Save Changes, then Connect again.' };
    }
    if (/denied|cancel/i.test(err.message)) return { state: 'denied', message: 'Not authorized in Discord. Connect again and choose Authorize.' };
    return { state: 'failed', message: `Discord refused: ${err.message}` };
  }
  return { state: 'failed', message: 'Discord closed before the authorization was answered. Connect again once it is running.' };
}

/** Settings' Cancel: stop waiting for the Authorize window. Nothing was saved. */
export function cancelAccess(): void {
  const waiting = asking;
  if (!waiting) return;
  asking = null;
  waiting.close();
  update({ approval: { state: 'cancelled', message: 'Cancelled. If Discord still shows its Authorize window, close it there.' } });
}

/**
 * Remove: forget the authorization, and revoke it at Discord (best effort).
 * No key is touched. `true`: Discord accepted the revoke; false when it did
 * not answer, or refused; null when nothing was saved.
 */
export async function remove(): Promise<boolean | null> {
  const waiting = asking;
  asking = null;
  waiting?.close();
  const saved = await discordCredentials().catch(() => null);
  await removeDiscordCredentials();
  generation++;
  disconnect();
  update({ approval: { state: 'none' } });
  if (state.connection === 'refused') update({ connection: 'idle' });
  announce();
  if (wanted) void ensureConnected().catch(() => undefined);
  if (!saved) return null;
  try {
    // The refresh token first: it is what keeps the authorization alive.
    await revokeToken(saved.clientId, saved.refreshToken, 'refresh_token');
    if (saved.accessToken) await revokeToken(saved.clientId, saved.accessToken, 'access_token');
    return true;
  } catch (err) {
    console.error(`[discord] the authorization is forgotten, but Discord did not confirm revoking it: ${(err as Error).message}. It can be removed in Discord's Settings › Authorized Apps`);
    return false;
  }
}
