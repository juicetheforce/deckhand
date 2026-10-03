import dgram from 'node:dgram';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionNeeded, NotSetUp } from '../action-error.js';
import { setVtsCredentials, vtsCredentials } from '../credentials.js';
import type { VtsApproval, VtsConnection, VtsList } from '../control/protocol.js';
import { VTS_ERRORS, VtsClient, VtsError } from './vts-client.js';

/**
 * VTube Studio, through its public API: the connection, the access it gives
 * Deckhand, and the state VTS keys show (scope §7, "Streaming
 * integrations"). The same shape as services/obs.ts, on purpose:
 *
 * **Cost scales with what is on screen** (ARCHITECTURE): no VTS key on a page
 * a deck shows, no connection. Once connected it stays connected while VTS
 * runs and a key needs it, fed by VTS's events — no polling. **No timer of
 * its own**: if VTS is not there, the next try is the daemon's 60-second
 * safety scan (retry), a press, or a VTS key coming into view.
 *
 * **Not set up** — no saved token — nothing connects. **Only Settings'
 * Connect ever asks VTS for a token** (requestAccess): no key, scan or
 * reconnect does, so VTS's window never appears by itself in the middle of
 * someone's stream (scope §7). A token VTS has revoked is **refused**, as a
 * wrong OBS password is: never retried until Connect gives a new one.
 *
 * **VTS's broadcast is listened to only inside Connect**, for a few seconds,
 * when the connection fails — to say whether VTS is not running, its API is
 * off, or it is on another port. Never at rest (scope §7).
 *
 * **Expression state** — what Toggle expression keys show — is VTS's for
 * the model loaded only. It is asked once when an expression key comes into
 * view, again on every model load, and after a ToggleExpression or
 * RemoveAllExpressions hotkey; where VTS has ExpressionToggledEvent (its beta
 * branch) that keeps it current too. On the stable branch a change made
 * through a hotkey — from VTS's own window or its keyboard shortcuts too —
 * is seen by its HotkeyTriggeredEvent (VTS session 2, measured); one made
 * without a hotkey (another plugin setting it directly) is not, until the
 * next of those (scope §7, the stated gap). Never polled.
 *
 * Key faces read cachedState() only — never a request in a render.
 */

export type { VtsConnection } from '../control/protocol.js';

export interface VtsState {
  connection: VtsConnection;
  /** The model loaded now, by ID; null when none, or not known. */
  modelId: string | null;
  /** The loaded model's expressions, by file: on or off. Only while an expression key is shown; empty when not known. */
  expressions: Record<string, boolean>;
  /** The model `expressions` were read from: they are only trusted for it. */
  expressionsModel: string | null;
  approval: VtsApproval;
}

/** VTS's default API port; VTS moves to 8002 and up if it is taken. */
export const DEFAULT_PORT = 8001;
/** Where VTS broadcasts its API state, every ~4.3 s on 1.35.10 (documented as 2 s). DECKHAND_VTS_BROADCAST_PORT overrides it, for tests. */
const BROADCAST_PORT = 47779;
/** How long Connect listens for that broadcast: longer than the ~4.3 s measured between two. */
const BROADCAST_LISTEN_MS = 6000;
/** How long a Model press waits for VTS to say its model has loaded: loads took ~1.1–1.7 s on 1.35.10 (VTS session 2). */
const MODEL_LOAD_CONFIRM_MS = 8000;

/** What a press of a VTS key says while VTS is not set up, and once VTS stops accepting the saved token. */
export const NOT_SET_UP_MESSAGE = "VTube Studio is not set up: connect it in Deckhand's Settings › Integrations";
export const REFUSED_MESSAGE = "VTube Studio no longer allows Deckhand: Connect again in Deckhand's Settings › Integrations, and allow it in VTube Studio";
const UNAVAILABLE_MESSAGE = "VTube Studio is not running, or its API is off (VTube Studio's settings: Allow Plugin API access)";

/** Deckhand's logo, sent with the token request so VTS's window shows it: exactly 128×128, as VTS requires. Beside dist/, as built-in icons are. */
const ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'logo', 'png', 'apps', '128.png');

/** With no connection, nothing VTS showed is known any more. */
const NOTHING_KNOWN = { modelId: null, expressions: {}, expressionsModel: null } as const;
/** Hotkey actions that change the loaded model's expressions (Files/HotkeyAction.cs). */
const EXPRESSION_HOTKEYS = new Set(['ToggleExpression', 'RemoveAllExpressions']);
/** ExpressionStateRequest's and ExpressionActivationRequest's invalid file, file not found (Files/ErrorID.cs). */
export const EXPRESSION_NOT_FOUND = new Set([600, 601, 650, 651]);

let state: VtsState = { connection: 'idle', ...NOTHING_KNOWN, approval: { state: 'none' } };
let client: VtsClient | null = null;
let connecting: Promise<VtsClient> | null = null;
let wanted = false;
/** An expression key is on a page a deck shows: keep the loaded model's expression state. */
let wantExpressions = false;
/** False once VTS has said it has no ExpressionToggledEvent (error 950, its stable branch). */
let expressionEvents = true;
/** Presses and picker lists waiting on VTS: a connection one opened is kept until it is answered. */
let pressing = 0;
/** The connection a token request is waiting on, while VTS shows its window. */
let asking: VtsClient | null = null;
/** Presses waiting for an event that says VTS really did what it was asked (loadModel). */
const waiters = new Set<{ match(type: string, data: Record<string, unknown>): boolean; resolve(seen: boolean): void }>();
const listeners = new Set<() => void>();

export function cachedState(): VtsState {
  return state;
}

/** Called whenever the state a key or Settings shows changes. Returns an unsubscribe. */
export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function update(change: Partial<VtsState>): void {
  const next = { ...state, ...change };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  announce();
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Whether a page some deck shows has a VTS key, and whether one of them is an
 * expression key. Shown: connect if not connected. Not shown: let go of the
 * connection. An expression key newly shown asks VTS for the expressions'
 * state, once.
 */
export function setWanted(want: boolean, expressions = false): void {
  const newlyExpressions = expressions && !wantExpressions;
  wantExpressions = expressions;
  if (!expressions && state.expressionsModel !== null) update({ expressions: {}, expressionsModel: null });
  if (want === wanted) {
    if (newlyExpressions && client?.isOpen) void readExpressions(client);
    return;
  }
  wanted = want;
  if (want) {
    if (state.connection !== 'refused') void ensureConnected().catch(() => undefined);
  } else {
    disconnect();
  }
}

/** From the daemon's 60-second safety scan: try again if a key wants VTS and it was not there. Does nothing otherwise. */
export function retry(): void {
  if (wanted && state.connection === 'unavailable' && !client && !connecting) void ensureConnected().catch(() => undefined);
}

/**
 * The saved token was given, or removed: a refused connection may now be
 * accepted, and VTS may now be set up, or no longer. Announced even when what
 * a key shows does not change, since whether VTS is set up has.
 */
export function credentialsChanged(): void {
  disconnect();
  if (state.connection === 'refused' || state.connection === 'not-set-up') update({ connection: 'idle' });
  announce();
  if (wanted) void ensureConnected().catch(() => undefined);
}

/**
 * Settings' Connect: ask VTube Studio for access, in the background — the
 * "vts" event says how it goes (protocol.ts, VtsApprovalState). Resolves at
 * once: false when a request is already under way.
 *
 * Finds VTS at `port` (or the saved one, or 8001); if nothing answers, listens
 * to VTS's broadcast once to say why — or to find it on another port. Then
 * VTS shows its window, and this waits for the person, **with no deadline**:
 * a closed connection does not take VTS's window back (VTS session 1), so
 * giving up would only lose an Allow clicked later. Allow saves the port and
 * the token, which sets VTS up; Deny saves nothing.
 */
export async function requestAccess(port?: number): Promise<boolean> {
  if (state.approval.state === 'checking' || state.approval.state === 'waiting') return false;
  update({ approval: { state: 'checking', message: 'Looking for VTube Studio…' } });
  void ask(port).catch((err: Error) => {
    console.error(`[vts] asking for access failed: ${err.message}`);
    update({ approval: { state: 'failed', message: err.message } });
  });
  return true;
}

async function ask(given: number | undefined): Promise<void> {
  const saved = await vtsCredentials().catch(() => null);
  let port = given ?? saved?.port ?? DEFAULT_PORT;
  let opened: VtsClient;
  try {
    opened = await VtsClient.connect({ port, onEvent: () => undefined, onClose: () => undefined });
  } catch (err) {
    if (!(err instanceof VtsError) || err.kind !== 'unavailable') throw err;
    const heard = await listenForBroadcast();
    if (!heard) {
      update({ approval: { state: 'not-running', message: 'VTube Studio is not running. Start it, then Connect again.' } });
      return;
    }
    if (!heard.active) {
      update({ approval: { state: 'api-off', message: "VTube Studio's API is off. Turn on Allow Plugin API access in VTube Studio's settings, then Connect again." } });
      return;
    }
    if (heard.port === port) {
      update({ approval: { state: 'unreachable', message: `VTube Studio says its API is on at port ${port}, but nothing answered there.` } });
      return;
    }
    // VTS moves to 8002 and up when its port is taken: follow it.
    port = heard.port;
    try {
      opened = await VtsClient.connect({ port, onEvent: () => undefined, onClose: () => undefined });
    } catch {
      update({ approval: { state: 'unreachable', message: `VTube Studio says its API is on at port ${port}, but nothing answered there.` } });
      return;
    }
  }
  asking = opened;
  update({ approval: { state: 'waiting', message: "Allow Deckhand in VTube Studio's window. It may be behind other windows." } });
  const icon = await fs.readFile(ICON_PATH).then(
    (png) => png.toString('base64'),
    (err: Error) => {
      console.error(`[vts] no icon for VTube Studio's window: ${err.message}`);
      return undefined;
    },
  );
  try {
    const token = await opened.requestToken(icon);
    await setVtsCredentials({ port, token });
    console.log(`[vts] VTube Studio ${opened.vtsVersion} allowed Deckhand, port ${port}`);
    update({ approval: { state: 'approved', message: 'Allowed. VTube Studio keys connect while VTube Studio runs.' } });
    credentialsChanged();
  } catch (err) {
    // Removed while waiting: removeAccess has already said so.
    if (asking !== opened) return;
    if (err instanceof VtsError && err.kind === 'denied') {
      update({ approval: { state: 'denied', message: 'VTube Studio said no: Deny was clicked. Connect asks again.' } });
    } else if (err instanceof VtsError && err.kind === 'busy') {
      update({
        approval: {
          state: 'busy',
          message: "VTube Studio is already showing a request for access, perhaps from an earlier Connect. Answer it in VTube Studio's window, then Connect again.",
        },
      });
    } else if (err instanceof VtsError && err.kind === 'unavailable') {
      update({ approval: { state: 'failed', message: 'VTube Studio closed before the request was answered. Connect again once it is running.' } });
    } else {
      throw err;
    }
  } finally {
    if (asking === opened) asking = null;
    opened.close();
  }
}

/**
 * Remove saved: called after the credentials are removed. A request still
 * waiting is let go — its window stays in VTS, and is the person's to answer.
 */
export function removeAccess(): void {
  const waiting = asking;
  asking = null;
  waiting?.close();
  update({ approval: { state: 'none' } });
  credentialsChanged();
}

/**
 * VTS's broadcast, once: the first one heard within BROADCAST_LISTEN_MS, or
 * null. Bound with SO_REUSEADDR, so other listeners on the port are not
 * locked out (one plugin that locked them out: Cazzar's, its issue #13).
 */
function listenForBroadcast(): Promise<{ active: boolean; port: number } | null> {
  const listenPort = Number(process.env.DECKHAND_VTS_BROADCAST_PORT) || BROADCAST_PORT;
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (heard: { active: boolean; port: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      socket.close();
      resolve(heard);
    };
    const deadline = setTimeout(() => finish(null), BROADCAST_LISTEN_MS);
    socket.on('message', (packet) => {
      try {
        const message = JSON.parse(packet.toString('utf8')) as { messageType?: unknown; data?: { active?: unknown; port?: unknown } };
        if (message.messageType !== 'VTubeStudioAPIStateBroadcast') return;
        const port = message.data?.port;
        if (typeof port !== 'number' || !Number.isInteger(port)) return;
        finish({ active: message.data?.active === true, port });
      } catch {
        // Not VTS's: keep listening.
      }
    });
    socket.on('error', () => finish(null));
    socket.bind(listenPort);
  });
}

/**
 * Send a request for a key press, connecting first if need be. `notFound`
 * maps an error ID VTS gives for something the key names and VTS no longer
 * has to what to tell the person — they can fix it, so it is notified.
 * Rejects with a message fit for the key's failure badge.
 */
export async function request(messageType: string, data?: Record<string, unknown>, notFound?: Record<number, string>): Promise<Record<string, unknown>> {
  return pressWith((connected) => connected.request(messageType, data), notFound);
}

/**
 * The Model key's press: load a model, and resolve once VTS says it has
 * loaded — VTS answers at once and loads ~1–2 s later (VTS session 2), so
 * the answer alone proves nothing. `already`: it was loaded, so nothing is
 * sent — **VTS reloads a model asked for again**, and the avatar drops out
 * on stream meanwhile. `unconfirmed`: no event within the one-shot deadline.
 * The waiter is in place before the request is sent.
 */
export async function loadModel(modelID: string, notFound: Record<number, string>): Promise<'loaded' | 'already' | 'unconfirmed'> {
  return pressWith(async (connected) => {
    if (state.modelId === modelID) return 'already';
    const loaded = waitFor((type, data) => type === 'ModelLoadedEvent' && data.modelLoaded === true && data.modelID === modelID, MODEL_LOAD_CONFIRM_MS);
    try {
      await connected.request('ModelLoadRequest', { modelID });
    } catch (err) {
      loaded.cancel();
      throw err;
    }
    return (await loaded.seen) ? 'loaded' : 'unconfirmed';
  }, notFound);
}

/** The first event `match` accepts within `withinMs`: true, or false at the deadline, on cancel, or when the connection goes. */
function waitFor(match: (type: string, data: Record<string, unknown>) => boolean, withinMs: number): { seen: Promise<boolean>; cancel(): void } {
  let waiter!: { match: typeof match; resolve(seen: boolean): void };
  const seen = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => waiter.resolve(false), withinMs);
    waiter = {
      match,
      resolve: (result) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(result);
      },
    };
    waiters.add(waiter);
  });
  return { seen, cancel: () => waiter.resolve(false) };
}

/** Run a press on a connection, connecting first if need be; failures become what the key's badge says. */
async function pressWith<T>(run: (connected: VtsClient) => Promise<T>, notFound?: Record<number, string>): Promise<T> {
  return holding(async () => {
    try {
      return await run(await ensureConnected());
    } catch (err) {
      if (err instanceof NotSetUp) throw err;
      if (err instanceof VtsError) {
        if (err.kind === 'refused') {
          refuse();
          throw new ActionNeeded(REFUSED_MESSAGE);
        }
        if (err.kind === 'unavailable') throw new ActionNeeded(UNAVAILABLE_MESSAGE);
        const found = err.errorID !== undefined ? notFound?.[err.errorID] : undefined;
        if (found) throw new ActionNeeded(found);
      }
      throw err;
    }
  });
}

/**
 * What a VTS key's picker offers, asked of VTS now — connecting as a press
 * does, and letting go after if no key is shown: the models, one model's
 * hotkeys (loaded or not: VTS lists any model's by ID), or one model's
 * expressions — **only while it is the one loaded** (scope §7): VTS has no
 * way to ask another model's, and answers for whichever is loaded, whatever
 * model is named (VTS session 2), so the answer's model is checked. In VTS's
 * own order. A hotkey with no name is shown by its file.
 */
export async function list(kind: 'models' | 'hotkeys' | 'expressions', modelId?: string): Promise<VtsList> {
  return holding(async () => {
    let connected: VtsClient;
    try {
      connected = await ensureConnected();
    } catch (err) {
      if (err instanceof NotSetUp) return { ok: false, reason: 'not-set-up', message: err.message };
      if (err instanceof VtsError && err.kind === 'refused') return { ok: false, reason: 'refused', message: REFUSED_MESSAGE };
      return { ok: false, reason: 'unavailable', message: 'Start VTube Studio to choose' };
    }
    const records = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null) : []);
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    try {
      if (kind === 'models') {
        const { availableModels } = await connected.request('AvailableModelsRequest');
        return { ok: true, items: records(availableModels).map((m) => ({ id: text(m.modelID), name: text(m.modelName) })).filter((m) => m.id !== '') };
      }
      if (!modelId) return { ok: false, reason: 'other', message: 'Choose a model first' };
      if (kind === 'expressions') {
        const notLoaded = { ok: false, reason: 'not-loaded', message: 'Load it in VTube Studio to see its expressions.' } as const;
        if (state.modelId !== modelId) return notLoaded;
        // details: which hotkeys use each expression — the names people know them by (Ryan: "EyesLove (Heart Eyes)").
        const answer = await connected.request('ExpressionStateRequest', { details: true });
        if (answer.modelLoaded !== true || answer.modelID !== modelId) return notLoaded;
        return {
          ok: true,
          items: records(answer.expressions)
            .map((e) => {
              const base = text(e.name) || text(e.file);
              // Several hotkeys: the first named one in VTS's order, the others noted.
              const [first, ...others] = records(e.usedInHotkeys)
                .map((h) => text(h.name))
                .filter((n) => n !== '');
              return { id: text(e.file), name: first ? `${base} (${first})` : base, ...(others.length > 0 ? { note: `also ${others.join(', ')}` } : {}) };
            })
            .filter((e) => e.id !== ''),
        };
      }
      const answer = await connected.request('HotkeysInCurrentModelRequest', { modelID: modelId });
      // Only a list VTS says is that model's is trusted (what VTS answers for an ID it does not have is untested).
      if (answer.modelID !== modelId) return { ok: false, reason: 'not-found', message: 'VTube Studio has no such model any more' };
      return {
        ok: true,
        items: records(answer.availableHotkeys)
          .map((h) => ({ id: text(h.hotkeyID), name: text(h.name) || text(h.file) || text(h.type), type: text(h.type), file: text(h.file) }))
          .filter((h) => h.id !== ''),
      };
    } catch (err) {
      if (err instanceof VtsError && err.kind === 'refused') {
        refuse();
        return { ok: false, reason: 'refused', message: REFUSED_MESSAGE };
      }
      if (err instanceof VtsError && MODEL_NOT_FOUND.has(err.errorID ?? -1)) return { ok: false, reason: 'not-found', message: 'VTube Studio has no such model any more' };
      return { ok: false, reason: err instanceof VtsError && err.kind === 'unavailable' ? 'unavailable' : 'other', message: (err as Error).message };
    }
  });
}

/** ModelIDMissing, ModelIDInvalid, ModelIDNotFound (Files/ErrorID.cs). */
export const MODEL_NOT_FOUND = new Set([150, 151, VTS_ERRORS.ModelIDNotFound]);

/** Keep a connection open while `run` needs it; with no VTS key shown, let it go after. */
async function holding<T>(run: () => Promise<T>): Promise<T> {
  pressing++;
  try {
    return await run();
  } finally {
    pressing--;
    if (!wanted && pressing === 0) disconnect();
  }
}

function ensureConnected(): Promise<VtsClient> {
  if (client?.isOpen) return Promise.resolve(client);
  if (state.connection === 'refused') return Promise.reject(new VtsError('refused', REFUSED_MESSAGE));
  if (connecting) return connecting;
  connecting = connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function connect(): Promise<VtsClient> {
  // Read first, and outside the try: not set up is not VTS being unavailable,
  // and the 60-second scan must not retry it (retry() only retries unavailable).
  const saved = await vtsCredentials().catch((err: Error) => {
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  });
  if (!saved?.token) {
    update({ connection: 'not-set-up', ...NOTHING_KNOWN });
    throw new NotSetUp(NOT_SET_UP_MESSAGE);
  }
  update({ connection: 'connecting' });
  let opened: VtsClient;
  try {
    opened = await VtsClient.connect({
      port: saved.port ?? DEFAULT_PORT,
      onEvent,
      onClose: () => {
        // Let go of on purpose (disconnect) is not VTS going away: that is idle, already said.
        if (client !== opened) return;
        client = null;
        releaseWaiters();
        update({ connection: 'unavailable', ...NOTHING_KNOWN });
      },
    });
  } catch (err) {
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  }
  try {
    if (!(await opened.authenticate(saved.token))) {
      opened.close();
      console.error('[vts] VTube Studio no longer accepts the saved token: revoked in its plugin list?');
      update({ connection: 'refused', ...NOTHING_KNOWN });
      throw new VtsError('refused', REFUSED_MESSAGE);
    }
    await opened.request('EventSubscriptionRequest', { eventName: 'ModelLoadedEvent', subscribe: true });
    await opened.request('EventSubscriptionRequest', { eventName: 'HotkeyTriggeredEvent', subscribe: true });
    // VTS's beta branch only; the stable one answers 950, and the hotkey event stands in for it.
    expressionEvents = await opened.request('EventSubscriptionRequest', { eventName: 'ExpressionToggledEvent', subscribe: true, config: { ignoreLive2DItems: true } }).then(
      () => true,
      (err: unknown) => {
        if (err instanceof VtsError && err.errorID === VTS_ERRORS.EventSubscriptionRequestEventTypeUnknown) return false;
        throw err;
      },
    );
    const model = await opened.request('CurrentModelRequest');
    client = opened;
    console.log(`[vts] connected to VTube Studio ${opened.vtsVersion}${expressionEvents ? '' : ' (no ExpressionToggledEvent: the stable branch)'}`);
    update({ connection: 'connected', modelId: model.modelLoaded === true && typeof model.modelID === 'string' ? model.modelID : null });
    if (wantExpressions) void readExpressions(opened);
  } catch (err) {
    opened.close();
    if (state.connection === 'connecting') update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  }
  // No longer wanted while it connected (the page changed), and no press waiting: let it go.
  if (!wanted && pressing === 0) disconnect();
  return opened;
}

/** VTS stopped accepting the token mid-connection (error 8 — the session is no longer authenticated, and VTS does not close it). */
function refuse(): void {
  if (state.connection === 'refused') return;
  const open = client;
  client = null;
  open?.close();
  releaseWaiters();
  console.error('[vts] VTube Studio stopped accepting the saved token: revoked in its plugin list?');
  update({ connection: 'refused', ...NOTHING_KNOWN });
}

function disconnect(): void {
  const open = client;
  client = null;
  open?.close();
  releaseWaiters();
  if (state.connection === 'connected' || state.connection === 'connecting') update({ connection: 'idle', ...NOTHING_KNOWN });
}

/** The connection went: nothing a press waits for can arrive on it. */
function releaseWaiters(): void {
  for (const waiter of [...waiters]) waiter.resolve(false);
}

function onEvent(type: string, data: Record<string, unknown>): void {
  for (const waiter of [...waiters]) if (waiter.match(type, data)) waiter.resolve(true);
  if (type === 'ModelLoadedEvent') {
    // A load sends "unloaded" for the old model, then "loaded" for the new one ~2 s later (VTS session 1).
    if (data.modelLoaded === true && typeof data.modelID === 'string') {
      update({ modelId: data.modelID });
      // A model keeps its expressions across a switch (VTS session 2): ask, never assume off.
      if (wantExpressions && client) void readExpressions(client);
    } else if (data.modelID === state.modelId) {
      update({ modelId: null, expressions: {}, expressionsModel: null });
    }
  } else if (type === 'HotkeyTriggeredEvent') {
    // The event comes before VTS's answer, and the state is right once answered (VTS session 2): a request sent now is answered after.
    if (wantExpressions && !expressionEvents && client && data.isLive2DItem !== true && EXPRESSION_HOTKEYS.has(String(data.hotkeyAction))) void readExpressions(client);
  } else if (type === 'ExpressionToggledEvent') {
    if (data.isLive2DItem === true || data.modelID !== state.modelId || state.expressionsModel !== state.modelId) return;
    if (typeof data.expressionFile !== 'string') return;
    update({ expressions: { ...state.expressions, [data.expressionFile]: data.active === true } });
  }
}

/** Ask VTS for the loaded model's expressions, and keep them for that model. Failures leave nothing known. */
async function readExpressions(connected: VtsClient): Promise<void> {
  try {
    const answer = await connected.request('ExpressionStateRequest', { details: false });
    // Only an answer for the model loaded now is kept: VTS answers for whichever model is loaded (VTS session 2).
    if (client !== connected || answer.modelLoaded !== true || answer.modelID !== state.modelId) return;
    const expressions: Record<string, boolean> = {};
    for (const e of Array.isArray(answer.expressions) ? (answer.expressions as unknown[]) : []) {
      const expression = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
      if (typeof expression.file === 'string') expressions[expression.file] = expression.active === true;
    }
    update({ expressions, expressionsModel: state.modelId });
  } catch (err) {
    if (err instanceof VtsError && err.kind === 'refused') refuse();
    else console.error(`[vts] could not read the expressions: ${(err as Error).message}`);
  }
}

/**
 * The Toggle expression key's press: turn one of the loaded model's
 * expressions on if it is off, off if it is on — the state read from VTS
 * first, not the cache, which on VTS's stable branch can miss a change made
 * without a hotkey. `not-loaded`: its model is not the one loaded (or none
 * is), and nothing is sent. A direct activation fires no event (VTS session
 * 1), so the cache is set from what was asked.
 */
export async function toggleExpression(modelID: string, file: string, notFound: Record<number, string>): Promise<'on' | 'off' | 'not-loaded'> {
  return pressWith(async (connected) => {
    if (state.modelId !== modelID) return 'not-loaded';
    const answer = await connected.request('ExpressionStateRequest', { details: false, expressionFile: file });
    if (answer.modelID !== modelID) return 'not-loaded';
    const now = (Array.isArray(answer.expressions) ? (answer.expressions as unknown[]) : []).find((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && (e as Record<string, unknown>).file === file);
    const active = !(now?.active === true);
    await connected.request('ExpressionActivationRequest', { expressionFile: file, active });
    if (state.expressionsModel === modelID) update({ expressions: { ...state.expressions, [file]: active } });
    return active ? 'on' : 'off';
  }, notFound);
}

export { VTS_ERRORS };
