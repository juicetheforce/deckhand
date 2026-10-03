import { openTextSocket, type TextSocket } from './text-socket.js';

/**
 * A client for VTube Studio's public API: JSON messages over a WebSocket
 * (text-socket.ts — not Node's own, which cannot read VTS's compressed
 * messages). Every message is one envelope:
 *
 *   { apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID,
 *     messageType, data }
 *
 * A reply carries the request's `requestID` and `<Request>` → `<Response>`,
 * or `APIError` with `{ errorID, message }`. An event's `messageType` ends in
 * "Event" and carries an ID of VTS's own.
 *
 * https://github.com/DenchiSoft/VTubeStudio — and what VTS 1.35.10 really
 * does, which differs in places (code-state, "VTube Studio — session 1").
 *
 * Connection only: when to connect, and what the answers mean for a key, are
 * services/vts.ts's. The timers here are one-shot deadlines; the token
 * request has none — it waits for a person.
 */

/**
 * **Permanent** (Ryan, 2026-10-02; ARCHITECTURE): VTS refuses a saved token
 * if either string differs from the ones it was given for, so changing them
 * after a release silently disconnects every user. The popup draws the name
 * as a bold title over the developer as a grey subtitle.
 */
export const PLUGIN_NAME = 'Deckhand';
export const PLUGIN_DEVELOPER = 'Open-source contributors';

/** VTS's error IDs that mean something to a caller (Files/ErrorID.cs, and the probe). */
export const VTS_ERRORS = {
  /** A request needing authentication on a session that is not: what a revoked session gets (not 50, as the README says). */
  RequestRequiresAuthentication: 8,
  /** The person clicked Deny in VTS's window. */
  TokenRequestDenied: 50,
  /** A token request is already showing in VTS's window — another plugin's, or one whose connection has gone. */
  TokenRequestCurrentlyOngoing: 51,
  /** No model loaded, or none by that ID. */
  ModelIDNotFound: 152,
  /** ModelLoadRequest more than once in 2 s. */
  ModelLoadCooldownNotOver: 153,
  /** A hotkey pressed with no model loaded. */
  HotkeyExecutionFailedBecauseNoModelLoaded: 201,
  /** The hotkey's ID is not in the model loaded now. */
  HotkeyIDNotFoundInModel: 202,
  /** EventSubscriptionRequest for an event this VTS does not have: ExpressionToggledEvent on the stable branch. */
  EventSubscriptionRequestEventTypeUnknown: 950,
} as const;

const HANDSHAKE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Why a connection or request failed. `unavailable`: VTS is not there (not
 * running, its API off, or gone mid-request). `refused`: the saved token is
 * no longer accepted — revoked in VTS, or given for another name.
 * `denied`, `busy`: a token request clicked Deny, or blocked by one already
 * showing. `api`: VTS answered the request with an error (`errorID`).
 * `protocol`: what answered is not VTS's API.
 */
export type VtsFailure = 'unavailable' | 'refused' | 'denied' | 'busy' | 'api' | 'protocol';

export class VtsError extends Error {
  constructor(
    readonly kind: VtsFailure,
    message: string,
    readonly errorID?: number,
  ) {
    super(message);
  }
}

export interface VtsClientOptions {
  port: number;
  onEvent(type: string, data: Record<string, unknown>): void;
  /** The connection closed after it opened. Not called for a failed connect. */
  onClose(): void;
}

interface Pending {
  resolve(data: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout | null;
}

/** Only ever a loopback connection (scope §7: port only, localhost only). */
const HOST = '127.0.0.1';

export class VtsClient {
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private socket!: TextSocket;
  vtsVersion = '';

  private constructor(private options: VtsClientOptions) {}

  /**
   * Connect, and ask VTS's API state — which needs no token, and proves VTS
   * is what answered. Rejects with a VtsError.
   */
  static async connect(options: VtsClientOptions): Promise<VtsClient> {
    const client = new VtsClient(options);
    try {
      client.socket = await openTextSocket({
        host: HOST,
        port: options.port,
        timeoutMs: HANDSHAKE_TIMEOUT_MS,
        onMessage: (text) => client.receive(text),
        onClose: () => client.closed(),
      });
    } catch (err) {
      throw new VtsError('unavailable', `VTube Studio is not reachable at port ${options.port}: ${(err as Error).message}`);
    }
    try {
      const state = await client.request('APIStateRequest');
      client.vtsVersion = String(state.vTubeStudioVersion ?? '');
    } catch (err) {
      client.close();
      if (err instanceof VtsError && err.kind === 'unavailable') throw err;
      throw new VtsError('protocol', `what answered at port ${options.port} is not VTube Studio's API: ${(err as Error).message}`);
    }
    return client;
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  /**
   * Send one request; resolves with its `data`, rejects with a VtsError.
   * `timeoutMs` null waits for as long as VTS takes — for the token request,
   * which waits for a person.
   */
  request(messageType: string, data?: Record<string, unknown>, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.socket.isOpen) return Promise.reject(new VtsError('unavailable', 'VTube Studio is not connected'));
    const requestID = `deckhand-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(requestID);
              reject(new VtsError('unavailable', `VTube Studio did not answer ${messageType}`));
            }, timeoutMs);
      this.pending.set(requestID, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data: data ?? {} }));
    });
  }

  /** Authenticate this session with a saved token. False: VTS no longer accepts it (revoked, or given for another name). */
  async authenticate(token: string): Promise<boolean> {
    const answer = await this.request('AuthenticationRequest', { pluginName: PLUGIN_NAME, pluginDeveloper: PLUGIN_DEVELOPER, authenticationToken: token });
    return answer.authenticated === true;
  }

  /**
   * Ask for a token: VTS shows its window, and this resolves when the person
   * answers — with the token on Allow; a VtsError `denied` on Deny, `busy`
   * if a request is already showing, `unavailable` if VTS goes away first.
   * No deadline: closing the connection does not take VTS's window back
   * (VTS session 1), so there is nothing to gain by giving up on it.
   */
  async requestToken(icon: string | undefined): Promise<string> {
    const answer = await this.request('AuthenticationTokenRequest', { pluginName: PLUGIN_NAME, pluginDeveloper: PLUGIN_DEVELOPER, ...(icon ? { pluginIcon: icon } : {}) }, null);
    const token = answer.authenticationToken;
    if (typeof token !== 'string' || token === '') throw new VtsError('protocol', 'VTube Studio answered the token request without a token');
    return token;
  }

  close(): void {
    this.socket.close();
  }

  private receive(text: string): void {
    let message: { requestID?: unknown; messageType?: unknown; data?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    const type = typeof message.messageType === 'string' ? message.messageType : '';
    const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {};
    const pending = typeof message.requestID === 'string' ? this.pending.get(message.requestID) : undefined;
    if (pending) {
      this.pending.delete(message.requestID as string);
      if (pending.timer) clearTimeout(pending.timer);
      if (type === 'APIError') pending.reject(errorOf(data));
      else pending.resolve(data);
      return;
    }
    if (type.endsWith('Event')) this.options.onEvent(type, data);
  }

  private closed(): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new VtsError('unavailable', 'VTube Studio closed the connection'));
      this.pending.delete(id);
    }
    this.options.onClose();
  }
}

function errorOf(data: Record<string, unknown>): VtsError {
  const errorID = typeof data.errorID === 'number' ? data.errorID : undefined;
  const message = typeof data.message === 'string' ? data.message : `VTube Studio error ${errorID ?? '?'}`;
  switch (errorID) {
    case VTS_ERRORS.RequestRequiresAuthentication:
      return new VtsError('refused', message, errorID);
    case VTS_ERRORS.TokenRequestDenied:
      return new VtsError('denied', message, errorID);
    case VTS_ERRORS.TokenRequestCurrentlyOngoing:
      return new VtsError('busy', message, errorID);
    default:
      return new VtsError('api', message, errorID);
  }
}
