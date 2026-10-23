import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A client for the Discord desktop app's local RPC: JSON over a Unix socket,
 * each message one frame — an 8-byte header, the opcode then the body's
 * length (both little-endian 32-bit), then the body:
 *
 *   HANDSHAKE (0) { v: 1, client_id }   → a FRAME with evt READY, or CLOSE
 *   FRAME (1)     { cmd, args, nonce, evt? } → a FRAME with the same nonce;
 *                 evt ERROR and { code, message } when it failed
 *   CLOSE (2)     { code, message }: Discord ends the connection (4000
 *                 Invalid Client ID, measured)
 *   PING (3) → answered PONG (4) with the same body
 *
 * An event is a FRAME with cmd DISPATCH, an evt, and no nonce. What each
 * answer looks like was measured against real Discord by the stage 0 probe
 * (scope §7, "Discord"), not only read from community docs.
 *
 * **The handshake can be slow** — READY usually comes within 0.3 s, but
 * has taken 20 s (measured on both the Flatpak and the RPM; Discord's doing).
 * So its deadline is long (HANDSHAKE_TIMEOUT_MS). Commands answer in
 * milliseconds. Both deadlines are one-shot; AUTHORIZE has none — it waits
 * for a person.
 *
 * Connection only: when to connect, and what the answers mean for a key, are
 * services/discord.ts's.
 */

/** READY took up to 20 s (measured): well past it, as scope §7 decided ("30 s or more"). */
export const HANDSHAKE_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 5000;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Discord's RPC error codes that mean something to a caller. */
export const DISCORD_ERRORS = {
  /** AUTHENTICATE with a token Discord does not accept: revoked, expired, or another app's. */
  InvalidToken: 4009,
  /** AUTHORIZE refused — no redirect registered (measured), or the person said no. */
  OAuth2Error: 5000,
  /** SELECT_VOICE_CHANNEL timed out joining. */
  SelectChannelTimedOut: 5001,
  /** SELECT_VOICE_CHANNEL without force while in another channel. */
  SelectVoiceForceRequired: 5003,
} as const;

/** CLOSE's code for an application ID Discord does not know (measured). */
export const CLOSE_INVALID_CLIENT = 4000;

/**
 * Why a connection or command failed. `unavailable`: no Discord at the
 * socket, or it went away. `slow`: no READY within the handshake's
 * deadline. `invalid-client`: Discord does not know the application ID.
 * `answer`: Discord answered with an error (`code`). `refused`: Discord no
 * longer accepts the saved authorization (services/discord.ts decides it).
 */
export type DiscordFailure = 'unavailable' | 'slow' | 'invalid-client' | 'answer' | 'refused';

export class DiscordError extends Error {
  constructor(
    readonly kind: DiscordFailure,
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * Where a Discord the person runs listens, in the order tried: the standard
 * place, which the RPM (and Discord's own .deb and tar) use, then the
 * Flathub Flatpak's two — its wrapper's relay, and the sandbox's own
 * runtime directory as the host sees it (both measured to connect). The
 * first that is a socket wins. Each `-0` to `-9`, as Discord takes the
 * next number when one is taken.
 */
export function socketCandidates(runtimeDir = process.env.XDG_RUNTIME_DIR): string[] {
  if (!runtimeDir) return [];
  const dirs = [runtimeDir, path.join(runtimeDir, 'app', 'com.discordapp.Discord'), path.join(runtimeDir, '.flatpak', 'com.discordapp.Discord', 'xdg-run')];
  return dirs.flatMap((dir) => Array.from({ length: 10 }, (_, n) => path.join(dir, `discord-ipc-${n}`)));
}

/**
 * The first candidate something listens on now, or null: Discord is not
 * running (or runs somewhere not supported). **A socket file is not
 * enough**: the Flatpak leaves its own runtime directory's
 * `discord-ipc-0` behind when Discord quits (seen 2026-10-22), so each
 * one that exists is connected to, and let go at once. Connecting is
 * immediate; only Discord's handshake, after it, is slow.
 */
export async function findSocket(runtimeDir?: string): Promise<string | null> {
  for (const candidate of socketCandidates(runtimeDir)) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isSocket() && (await listening(candidate))) return candidate;
  }
  return null;
}

/** Whether something accepts a connection at this socket: refused (a file left behind) or no answer within a second is no. */
function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const done = (answer: boolean) => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(answer);
    };
    const deadline = setTimeout(() => done(false), 1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface DiscordClientOptions {
  path: string;
  clientId: string;
  onEvent(evt: string, data: Record<string, unknown>, args: Record<string, unknown>): void;
  /** The connection closed after READY. Not called for a failed connect, or for close(). */
  onClose(): void;
  /** For tests: the handshake's deadline. */
  handshakeMs?: number;
}

type Pending = { resolve(data: Record<string, unknown>): void; reject(err: Error): void; timer: NodeJS.Timeout | null };

export class DiscordClient {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private open = true;
  private closedByUs = false;
  /** What READY said: the Discord user signed in, when it says so. */
  ready: Record<string, unknown> = {};

  private constructor(
    private readonly socket: net.Socket,
    private readonly options: DiscordClientOptions,
  ) {}

  /** Connect and handshake. Resolves at READY; rejects with a DiscordError. */
  static connect(options: DiscordClientOptions): Promise<DiscordClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(options.path);
      const client = new DiscordClient(socket, options);
      let settled = false;
      const fail = (err: DiscordError) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        client.open = false;
        socket.destroy();
        reject(err);
      };
      const deadline = setTimeout(
        () => fail(new DiscordError('slow', 'Discord did not answer the connection in time')),
        options.handshakeMs ?? HANDSHAKE_TIMEOUT_MS,
      );
      client.onReady = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        client.ready = data;
        resolve(client);
      };
      client.onRefused = (code, message) =>
        fail(code === CLOSE_INVALID_CLIENT ? new DiscordError('invalid-client', 'Discord does not know that application ID', code) : new DiscordError('unavailable', `Discord closed the connection: ${message || code}`, code));
      socket.on('connect', () => client.send(OP_HANDSHAKE, { v: 1, client_id: options.clientId }));
      socket.on('data', (chunk) => client.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      socket.on('error', () => fail(new DiscordError('unavailable', 'Discord is not running')));
      socket.on('close', () => {
        if (!settled) {
          fail(new DiscordError('unavailable', 'Discord closed the connection'));
          return;
        }
        client.closed();
      });
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Called at READY, and when Discord refuses the handshake: set by connect(). */
  private onReady: (data: Record<string, unknown>) => void = () => undefined;
  private onRefused: (code: number, message: string) => void = () => undefined;

  /**
   * One command, answered by its nonce. `timeoutMs` null: no deadline
   * (AUTHORIZE, which waits for a person). Rejects with `answer` and
   * Discord's code for an ERROR, `unavailable` when the connection goes.
   */
  command(cmd: string, args: Record<string, unknown> = {}, { evt, timeoutMs = COMMAND_TIMEOUT_MS }: { evt?: string; timeoutMs?: number | null } = {}): Promise<Record<string, unknown>> {
    if (!this.open) return Promise.reject(new DiscordError('unavailable', 'Discord is not connected'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => this.settle(nonce, new DiscordError('unavailable', `Discord did not answer ${cmd} in time`)), timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      this.send(OP_FRAME, { cmd, args, nonce, ...(evt ? { evt } : {}) });
    });
  }

  /** SUBSCRIBE to an event; `args` names what it is for (a channel's voice states). */
  subscribe(evt: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.command('SUBSCRIBE', args, { evt });
  }

  unsubscribe(evt: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.command('UNSUBSCRIBE', args, { evt });
  }

  /** Let go on purpose: onClose is not called. Waiting commands are rejected. */
  close(): void {
    this.closedByUs = true;
    this.open = false;
    this.socket.destroy();
    this.rejectAll();
  }

  private closed(): void {
    const wasOpen = this.open;
    this.open = false;
    this.rejectAll();
    if (wasOpen && !this.closedByUs) this.options.onClose();
  }

  private rejectAll(): void {
    for (const nonce of [...this.pending.keys()]) this.settle(nonce, new DiscordError('unavailable', 'Discord closed the connection'));
  }

  private settle(nonce: string, outcome: Error | Record<string, unknown>): void {
    const waiting = this.pending.get(nonce);
    if (!waiting) return;
    this.pending.delete(nonce);
    if (waiting.timer) clearTimeout(waiting.timer);
    if (outcome instanceof Error) waiting.reject(outcome);
    else waiting.resolve(outcome);
  }

  private send(op: number, body: unknown): void {
    const json = Buffer.from(JSON.stringify(body), 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(json.length, 4);
    this.socket.write(Buffer.concat([header, json]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (this.buffer.length < 8 + length) return;
      const body = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = length === 0 ? {} : JSON.parse(body.toString('utf8'));
        message = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        continue;
      }
      this.handle(op, message);
    }
  }

  private handle(op: number, message: Record<string, unknown>): void {
    if (op === OP_PING) {
      this.send(OP_PONG, message);
      return;
    }
    if (op === OP_CLOSE) {
      this.onRefused(Number(message.code) || 0, typeof message.message === 'string' ? message.message : '');
      this.socket.destroy();
      return;
    }
    if (op !== OP_FRAME) return;
    const data = record(message.data);
    if (message.cmd === 'DISPATCH' && message.evt === 'READY') {
      this.onReady(data);
      return;
    }
    const nonce = typeof message.nonce === 'string' ? message.nonce : null;
    if (nonce && this.pending.has(nonce)) {
      if (message.evt === 'ERROR') this.settle(nonce, new DiscordError('answer', typeof data.message === 'string' ? data.message : 'Discord refused the request', Number(data.code) || undefined));
      else this.settle(nonce, data);
      return;
    }
    if (message.cmd === 'DISPATCH' && typeof message.evt === 'string') this.options.onEvent(message.evt, data, record(message.args));
  }
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/*
 * Discord's OAuth2 token endpoint, as Deckhand uses it: the code AUTHORIZE
 * gives exchanged for tokens, the refresh, and the revoke. **No client
 * secret, ever**: each person's application is a Public Client, and PKCE
 * proves the exchange (measured, on the Flatpak and the RPM). The refresh
 * token rotates on every refresh; sending a replaced one is refused
 * (`invalid_grant`) but does not end the link, unlike Twitch's (measured).
 *
 * DECKHAND_DISCORD_API_URL points it at a fake, for tests
 * (scripts/test/fake-discord.mjs).
 */

const apiUrl = () => process.env.DECKHAND_DISCORD_API_URL ?? 'https://discord.com/api';
/** Registered on each person's application (the setup steps): Discord refuses AUTHORIZE without one (measured). Nothing is ever sent to it. */
export const REDIRECT_URI = 'http://127.0.0.1';
/** What AUTHORIZE asks for: the three measured to work. Fewer may do — not yet measured (scope §7). */
export const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const HTTP_DEADLINE_MS = 10_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds: 604800, seven days, measured. */
  expiresIn: number;
  scopes: string[];
}

/**
 * Why a token request failed. `unavailable`: no answer — offline, a
 * timeout, Discord's own 5xx. `refused`: `invalid_grant`, a code or refresh
 * token Discord will not take. `answer`: any other refusal, with Discord's
 * words.
 */
export class DiscordTokenError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'refused' | 'answer',
    message: string,
    readonly error?: string,
  ) {
    super(message);
  }
}

async function post(endpoint: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${endpoint}`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'User-Agent': 'Deckhand (https://github.com/juicetheforce/deckhand)' },
      signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
    });
  } catch (err) {
    throw new DiscordTokenError('unavailable', (err as Error).name === 'TimeoutError' ? 'Discord did not answer in time' : 'Discord could not be reached');
  }
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    body = record(raw === '' ? {} : JSON.parse(raw));
  } catch {
    // Not JSON: the status says enough.
  }
  if (res.status >= 500) throw new DiscordTokenError('unavailable', 'Discord could not be reached');
  return { status: res.status, body };
}

function refusal(status: number, body: Record<string, unknown>): DiscordTokenError {
  const error = typeof body.error === 'string' ? body.error : '';
  const description = typeof body.error_description === 'string' ? body.error_description : '';
  return new DiscordTokenError(error === 'invalid_grant' ? 'refused' : 'answer', description || error || `Discord answered ${status}`, error || undefined);
}

function tokensOf(body: Record<string, unknown>): Tokens {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!accessToken || !refreshToken) throw new DiscordTokenError('answer', 'Discord answered without tokens');
  const scopes = typeof body.scope === 'string' ? body.scope.split(' ').filter((s) => s !== '') : [];
  return { accessToken, refreshToken, expiresIn: Number(body.expires_in) || 0, scopes };
}

/** AUTHORIZE's code, for tokens: with the PKCE verifier and the registered redirect, and no secret. */
export async function exchangeCode(clientId: string, code: string, codeVerifier: string): Promise<Tokens> {
  const { status, body } = await post('/oauth2/token', { client_id: clientId, grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI });
  if (status !== 200) throw refusal(status, body);
  return tokensOf(body);
}

/** A new pair for the refresh token. The caller saves it before anything uses it: the old refresh token is spent. */
export async function refreshTokens(clientId: string, refreshToken: string): Promise<Tokens> {
  const { status, body } = await post('/oauth2/token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (status !== 200) throw refusal(status, body);
  return tokensOf(body);
}

/**
 * Revoke a token, with the application's ID and no secret. Discord answered
 * 200 to such a request (a made-up token, 2026-10-22) and 400 without the
 * client ID, so a public client is accepted here; that it ends a real link
 * is `[inference]` until checked (scope §7, "Discord").
 */
export async function revokeToken(clientId: string, token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
  const { status, body } = await post('/oauth2/token/revoke', { client_id: clientId, token, token_type_hint: hint });
  if (status !== 200) throw refusal(status, body);
}
