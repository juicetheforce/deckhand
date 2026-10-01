import { createHash } from 'node:crypto';

/**
 * A client for obs-websocket protocol v5, the server built into OBS Studio 28
 * and later. JSON only, over Node's own WebSocket — no dependency (scope §7,
 * "Streaming integrations"). The protocol, as this file uses it:
 *
 *   OBS → Hello       (op 0)  versions, and an auth challenge and salt
 *   us  → Identify    (op 1)  rpcVersion 1, the auth string, event categories
 *   OBS → Identified  (op 2)
 *   OBS → Event       (op 5)  eventType, eventData
 *   us  → Request     (op 6)  requestType, requestId, requestData
 *   OBS → Response    (op 7)  requestStatus { result, code, comment }, responseData
 *
 * https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 *
 * Connection only: when to connect, and what the answers mean for a key, are
 * services/obs.ts's. The timers here are one-shot and bounded — a deadline for
 * the handshake and for each request — never recurring.
 */

/** Event categories (Identify's `eventSubscriptions`). Only low-volume ones are used: never the volume meters. */
export const OBS_EVENTS = {
  General: 1 << 0,
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  Outputs: 1 << 6,
  SceneItems: 1 << 7,
} as const;

/** obs-websocket's close codes that mean something to a caller. */
const AUTHENTICATION_FAILED = 4009;
const UNSUPPORTED_RPC_VERSION = 4010;

const RPC_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Why a connection or request failed. `unavailable`: OBS is not there (not
 * running, its WebSocket server off, or gone mid-request) — Node's WebSocket
 * reports no reason for a refused connection, so every close before the Hello
 * counts as this. `auth`: the password is wrong or missing — retrying cannot
 * help. `protocol`: OBS answered something this client does not speak.
 */
export type ObsFailure = 'unavailable' | 'auth' | 'protocol';

export class ObsError extends Error {
  constructor(
    readonly kind: ObsFailure,
    message: string,
  ) {
    super(message);
  }
}

const sha256base64 = (text: string) => createHash('sha256').update(text).digest('base64');

/** The Identify auth string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function authenticationString(password: string, salt: string, challenge: string): string {
  return sha256base64(sha256base64(password + salt) + challenge);
}

export interface ObsClientOptions {
  url: string;
  password?: string;
  /** OBS_EVENTS bits to receive. */
  events: number;
  onEvent(type: string, data: Record<string, unknown>): void;
  /** The connection closed after it was identified. Not called for a failed connect. */
  onClose(code: number): void;
}

interface Pending {
  resolve(data: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Message {
  op: number;
  d: Record<string, unknown>;
}

export class ObsClient {
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(
    private ws: WebSocket,
    private options: ObsClientOptions,
    readonly obsVersion: string,
  ) {}

  /** Connect, authenticate and identify. Rejects with an ObsError. */
  static connect(options: ObsClientOptions): Promise<ObsClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(options.url, 'obswebsocket.json');
      } catch (err) {
        reject(new ObsError('unavailable', `cannot connect to ${options.url}: ${(err as Error).message}`));
        return;
      }
      let settled = false;
      let obsVersion = '';
      const fail = (err: ObsError) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        ws.close();
        reject(err);
      };
      const deadline = setTimeout(() => fail(new ObsError('unavailable', `OBS did not answer at ${options.url}`)), HANDSHAKE_TIMEOUT_MS);

      ws.addEventListener('message', (event) => {
        if (settled) return;
        let message: Message;
        try {
          message = parse(event.data);
        } catch (err) {
          fail(new ObsError('protocol', `OBS sent something that is not obs-websocket: ${(err as Error).message}`));
          return;
        }
        if (message.op === 0) {
          obsVersion = String(message.d.obsStudioVersion ?? '');
          const auth = message.d.authentication as { challenge?: unknown; salt?: unknown } | undefined;
          const identify: Record<string, unknown> = { rpcVersion: RPC_VERSION, eventSubscriptions: options.events };
          if (auth) {
            if (!options.password) {
              fail(new ObsError('auth', 'OBS asks for a password, and none is set'));
              return;
            }
            identify.authentication = authenticationString(options.password, String(auth.salt), String(auth.challenge));
          }
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (message.op === 2) {
          settled = true;
          clearTimeout(deadline);
          const client = new ObsClient(ws, options, obsVersion);
          client.listen();
          resolve(client);
        }
      });
      ws.addEventListener('close', (event) => {
        if (event.code === AUTHENTICATION_FAILED) fail(new ObsError('auth', 'OBS refused the password'));
        else if (event.code === UNSUPPORTED_RPC_VERSION) fail(new ObsError('protocol', 'OBS does not speak obs-websocket protocol v5 (OBS 28 or later)'));
        else fail(new ObsError('unavailable', `OBS is not reachable at ${options.url}`));
      });
      // A refused or dropped connection also closes, which is where it is reported.
      ws.addEventListener('error', () => undefined);
    });
  }

  private listen(): void {
    this.ws.addEventListener('message', (event) => {
      let message: Message;
      try {
        message = parse(event.data);
      } catch {
        return;
      }
      if (message.op === 5) {
        this.options.onEvent(String(message.d.eventType), (message.d.eventData as Record<string, unknown>) ?? {});
      } else if (message.op === 7) {
        const pending = this.pending.get(String(message.d.requestId));
        if (!pending) return;
        this.pending.delete(String(message.d.requestId));
        clearTimeout(pending.timer);
        const status = message.d.requestStatus as { result?: boolean; code?: number; comment?: string } | undefined;
        if (status?.result) pending.resolve((message.d.responseData as Record<string, unknown>) ?? {});
        else pending.reject(new ObsError('protocol', status?.comment ?? `OBS refused ${String(message.d.requestType)} (code ${status?.code ?? '?'})`));
      }
    });
    this.ws.addEventListener('close', (event) => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new ObsError('unavailable', 'OBS closed the connection'));
        this.pending.delete(id);
      }
      this.options.onClose(event.code);
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Send one request; resolves with its responseData, rejects with an ObsError. */
  request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new ObsError('unavailable', 'OBS is not connected'));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsError('unavailable', `OBS did not answer ${requestType}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.ws.close(1000);
  }
}

function parse(data: unknown): Message {
  if (typeof data !== 'string') throw new Error('a binary frame (only obswebsocket.json is spoken)');
  const message = JSON.parse(data) as Partial<Message>;
  if (typeof message.op !== 'number' || !message.d || typeof message.d !== 'object') throw new Error('no op or d');
  return message as Message;
}
