import { ActionNeeded } from '../action-error.js';
import { obsCredentials } from '../credentials.js';
import { OBS_EVENTS, ObsClient, ObsError } from './obs-client.js';

/**
 * OBS Studio, through obs-websocket: the connection and the state OBS keys
 * show (scope §7, "Streaming integrations").
 *
 * **Cost scales with what is on screen** (ARCHITECTURE): no OBS key on a page
 * a deck shows, no connection. The daemon says when one is shown or not
 * (setWanted); a press connects at once (request). Once connected it stays
 * connected while OBS runs and a key needs it, fed by OBS's events — no
 * polling. **No timer of its own**: if OBS is not there, the next try is the
 * daemon's 60-second safety scan (retry), the same tick that retries a lost
 * session bus, or the next page shown, or a press.
 *
 * A refused password is never retried by the scan: retrying cannot fix it.
 * Changing the credentials (credentialsChanged) clears it.
 *
 * Key faces read cachedState() only — never a request in a render.
 */

/** Where an output is, as a key shows it. obs-websocket's OBS_WEBSOCKET_OUTPUT_* states, folded. */
export type OutputPhase = 'stopped' | 'starting' | 'live' | 'stopping' | 'reconnecting';

export type ObsConnection =
  /** Nothing needs OBS, and no connection has been tried. */
  | 'idle'
  | 'connecting'
  | 'connected'
  /** OBS is not running, its WebSocket server is off, or it went away. */
  | 'unavailable'
  /** OBS refused the password, or asked for one and none is set. */
  | 'auth-failed';

export interface ObsState {
  connection: ObsConnection;
  stream: OutputPhase;
  record: OutputPhase;
  recordPaused: boolean;
}

const EVENTS = OBS_EVENTS.General | OBS_EVENTS.Outputs;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;

let state: ObsState = { connection: 'idle', stream: 'stopped', record: 'stopped', recordPaused: false };
let client: ObsClient | null = null;
let connecting: Promise<ObsClient> | null = null;
let wanted = false;
/** Presses waiting on OBS: a connection a press opened is kept until it is answered. */
let pressing = 0;
/** Presses waiting for an event that says OBS really did what it was asked (requestAndConfirm). */
const waiters = new Set<{ match(type: string, data: Record<string, unknown>): boolean; resolve(): void }>();
const listeners = new Set<() => void>();

export function cachedState(): ObsState {
  return state;
}

/** Called whenever the state a key shows changes. Returns an unsubscribe. */
export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function update(change: Partial<ObsState>): void {
  const next = { ...state, ...change };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Whether a page some deck shows has an OBS key. Shown: connect if not
 * connected. Not shown: let go of the connection.
 */
export function setWanted(want: boolean): void {
  if (want === wanted) return;
  wanted = want;
  if (want) {
    if (state.connection !== 'auth-failed') void ensureConnected().catch(() => undefined);
  } else {
    disconnect();
  }
}

/** From the daemon's 60-second safety scan: try again if a key wants OBS and it was not there. Does nothing otherwise. */
export function retry(): void {
  if (wanted && state.connection === 'unavailable' && !client && !connecting) void ensureConnected().catch(() => undefined);
}

/** The credentials were changed: a refused password may now be right. */
export function credentialsChanged(): void {
  disconnect();
  if (state.connection === 'auth-failed') update({ connection: 'idle' });
  if (wanted) void ensureConnected().catch(() => undefined);
}

/**
 * Send a request for a key press, connecting first if need be. Rejects with
 * a message fit for the key's failure badge.
 */
export async function request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return pressWith(async (connected) => connected.request(requestType, requestData));
}

/**
 * Send a request, and resolve true once OBS sends the event that says it was
 * done, false if none comes within `withinMs` — for a request obs-websocket
 * answers "success" whether or not OBS acted on it (ToggleRecordPause: OBS
 * ignores a pause it cannot do, and says nothing). The wait is one-shot,
 * inside the press; the waiter is in place before the request is sent, since
 * OBS may send the event before its answer.
 */
export async function requestAndConfirm(
  requestType: string,
  requestData: Record<string, unknown> | undefined,
  match: (type: string, data: Record<string, unknown>) => boolean,
  withinMs: number,
): Promise<boolean> {
  return pressWith(async (connected) => {
    let waiter!: { match: typeof match; resolve(): void };
    const seen = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(false);
      }, withinMs);
      waiter = {
        match,
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      waiters.add(waiter);
    });
    try {
      await connected.request(requestType, requestData);
    } catch (err) {
      waiters.delete(waiter);
      waiter.resolve();
      throw err;
    }
    return seen;
  });
}

async function pressWith<T>(run: (connected: ObsClient) => Promise<T>): Promise<T> {
  pressing++;
  try {
    return await run(await ensureConnected());
  } catch (err) {
    // Not running, or the password: the message says what to do. A request
    // OBS itself refused is OBS's business, and only badges the key.
    const needed = err instanceof ObsError && (err.kind === 'unavailable' || err.kind === 'auth');
    throw needed ? new ActionNeeded(describeFailure(err)) : new Error(describeFailure(err));
  } finally {
    pressing--;
    // A press from a script, with no OBS key shown, does not keep OBS open.
    if (!wanted && pressing === 0) disconnect();
  }
}

function describeFailure(err: unknown): string {
  if (!(err instanceof ObsError)) return (err as Error).message;
  if (err.kind === 'unavailable') return 'OBS is not running, or its WebSocket server is off (OBS: Tools › WebSocket Server Settings)';
  if (err.kind === 'auth') return `${err.message}: set the password from OBS (Tools › WebSocket Server Settings › Show Connect Info) with deckhand obs password`;
  return err.message;
}

function ensureConnected(): Promise<ObsClient> {
  if (client?.isOpen) return Promise.resolve(client);
  if (connecting) return connecting;
  connecting = connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function connect(): Promise<ObsClient> {
  update({ connection: 'connecting' });
  let opened: ObsClient;
  try {
    const credentials = await obsCredentials();
    opened = await ObsClient.connect({
      url: `ws://${credentials.host ?? DEFAULT_HOST}:${credentials.port ?? DEFAULT_PORT}`,
      password: credentials.password,
      events: EVENTS,
      onEvent,
      onClose: () => {
        // Let go of on purpose (disconnect) is not OBS going away: that is idle, already said.
        if (client !== opened) return;
        client = null;
        // Gone: nothing it showed is known any more.
        update({ connection: 'unavailable', stream: 'stopped', record: 'stopped', recordPaused: false });
      },
    });
  } catch (err) {
    const auth = err instanceof ObsError && err.kind === 'auth';
    update({ connection: auth ? 'auth-failed' : 'unavailable', stream: 'stopped', record: 'stopped', recordPaused: false });
    if (auth) console.error(`[obs] ${(err as Error).message}`);
    throw err;
  }
  client = opened;
  console.log(`[obs] connected to OBS ${opened.obsVersion}`);
  try {
    const [stream, record] = await Promise.all([opened.request('GetStreamStatus'), opened.request('GetRecordStatus')]);
    update({
      connection: 'connected',
      stream: stream.outputReconnecting === true ? 'reconnecting' : stream.outputActive === true ? 'live' : 'stopped',
      record: record.outputActive === true ? 'live' : 'stopped',
      recordPaused: record.outputPaused === true,
    });
  } catch (err) {
    opened.close();
    throw err;
  }
  // No longer wanted while it connected (the page changed), and no press waiting: let it go.
  if (!wanted && pressing === 0) disconnect();
  return opened;
}

function disconnect(): void {
  const open = client;
  client = null;
  open?.close();
  if (state.connection === 'connected' || state.connection === 'connecting') {
    update({ connection: 'idle', stream: 'stopped', record: 'stopped', recordPaused: false });
  }
}

/** obs-websocket's output states, folded into what a key shows. */
export function phaseOf(outputState: unknown, current: OutputPhase): OutputPhase {
  switch (outputState) {
    case 'OBS_WEBSOCKET_OUTPUT_STARTING':
      return 'starting';
    case 'OBS_WEBSOCKET_OUTPUT_STARTED':
    case 'OBS_WEBSOCKET_OUTPUT_RECONNECTED':
    case 'OBS_WEBSOCKET_OUTPUT_PAUSED':
    case 'OBS_WEBSOCKET_OUTPUT_RESUMED':
      return 'live';
    case 'OBS_WEBSOCKET_OUTPUT_STOPPING':
      return 'stopping';
    case 'OBS_WEBSOCKET_OUTPUT_STOPPED':
      return 'stopped';
    case 'OBS_WEBSOCKET_OUTPUT_RECONNECTING':
      return 'reconnecting';
    default:
      return current;
  }
}

function onEvent(type: string, data: Record<string, unknown>): void {
  for (const waiter of [...waiters]) {
    if (!waiter.match(type, data)) continue;
    waiters.delete(waiter);
    waiter.resolve();
  }
  switch (type) {
    case 'StreamStateChanged':
      update({ stream: phaseOf(data.outputState, state.stream) });
      break;
    case 'RecordStateChanged': {
      const record = phaseOf(data.outputState, state.record);
      const paused =
        data.outputState === 'OBS_WEBSOCKET_OUTPUT_PAUSED' ? true : data.outputState === 'OBS_WEBSOCKET_OUTPUT_RESUMED' || record === 'stopped' ? false : state.recordPaused;
      update({ record, recordPaused: paused });
      break;
    }
    default:
      break;
  }
}
