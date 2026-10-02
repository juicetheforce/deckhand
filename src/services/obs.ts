import { promises as fs } from 'node:fs';
import { ActionNeeded, NotSetUp } from '../action-error.js';
import { obsCredentials, type ObsCredentials } from '../credentials.js';
import type { ObsAttempt, ObsConnection, ObsList, ObsOutputPhase } from '../control/protocol.js';
import { OBS_EVENTS, ObsClient, ObsError, RESOURCE_NOT_FOUND } from './obs-client.js';

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
 * session bus, or a press, or an OBS key coming into view when none was.
 *
 * A refused password is never retried by the scan: retrying cannot fix it.
 * Changing the credentials (credentialsChanged) clears it.
 *
 * **Not set up** — no saved connection (credentials.ts) — nothing connects at
 * all: OBS keys draw their not-set-up face and a press says where to set it
 * up. Saving the connection in Settings is what sets it up.
 *
 * Key faces read cachedState() only — never a request in a render.
 */

export type { ObsAttempt, ObsConnection } from '../control/protocol.js';
/** Where an output is, as a key shows it. */
export type OutputPhase = ObsOutputPhase;

export interface ObsState {
  connection: ObsConnection;
  stream: OutputPhase;
  record: OutputPhase;
  recordPaused: boolean;
  /** The program scene's name; null when not known (not connected). */
  programScene: string | null;
  /** Whether each input a shown Mute key names is muted, by input name. Absent: not known, or OBS has no such input. */
  inputMuted: Record<string, boolean>;
  /** Whether each scene item a shown Source key names is shown, by itemKey(scene, source). Absent: not known, or not there. */
  itemEnabled: Record<string, boolean>;
}

/**
 * What the shown keys name in OBS, beyond what every OBS key shows: the
 * inputs Mute keys toggle and the scene items Source keys show and hide. Only
 * these are asked for and kept — once each, when they are first shown, and
 * then kept current by OBS's events. Never polled.
 */
export interface ObsNeeds {
  inputs: string[];
  items: Array<{ scene: string; source: string }>;
}

const NO_NEEDS: ObsNeeds = { inputs: [], items: [] };

/** A scene item as the state keys it: OBS's events name the scene, the keys name the scene and the source. */
export const itemKey = (scene: string, source: string) => `${scene}\u0000${source}`;

// Low-volume categories only — never the volume meters or the transform
// stream (high-volume, outside "All"). Inputs' busiest event is
// InputVolumeChanged while someone drags a fader: parsed and ignored.
const EVENTS = OBS_EVENTS.General | OBS_EVENTS.Outputs | OBS_EVENTS.Scenes | OBS_EVENTS.Inputs | OBS_EVENTS.SceneItems;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4455;

/** What a press of an OBS key says while OBS is not set up. */
export const NOT_SET_UP_MESSAGE = "OBS is not set up: connect it in Deckhand's Settings › Integrations";
/** With no connection, nothing OBS showed is known any more. */
const NOTHING_KNOWN = { stream: 'stopped', record: 'stopped', recordPaused: false, programScene: null, inputMuted: {}, itemEnabled: {} } as const;

let state: ObsState = { connection: 'idle', ...NOTHING_KNOWN };
let needs: ObsNeeds = NO_NEEDS;
/** Each needed scene item's id in its scene: OBS's enable events carry the scene and the id, not the source. */
const itemIds = new Map<string, number>();
let client: ObsClient | null = null;
let connecting: Promise<ObsClient> | null = null;
let wanted = false;
/** Presses waiting on OBS: a connection a press opened is kept until it is answered. */
let pressing = 0;
/** Presses waiting for an event that says OBS really did what it was asked (requestAndConfirm). */
const waiters = new Set<{ match(type: string, data: Record<string, unknown>): boolean; resolve(data: Record<string, unknown> | null): void }>();
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
  announce();
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Whether a page some deck shows has an OBS key, and what those keys name.
 * Shown: connect if not connected. Not shown: let go of the connection. A
 * newly shown input or scene item is asked for once, now.
 */
export function setWanted(want: boolean, shown: ObsNeeds = NO_NEEDS): void {
  const added: ObsNeeds = {
    inputs: shown.inputs.filter((i) => !needs.inputs.includes(i)),
    items: shown.items.filter((it) => !needs.items.some((n) => itemKey(n.scene, n.source) === itemKey(it.scene, it.source))),
  };
  needs = shown;
  forgetUnneeded();
  if (want === wanted) {
    if (client?.isOpen && (added.inputs.length > 0 || added.items.length > 0)) void seed(client, added).catch(() => undefined);
    return;
  }
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

/**
 * The credentials were changed, saved or removed: a refused password may now
 * be right, and OBS may now be set up, or no longer. Announced even when the
 * state a key shows does not change, since whether OBS is set up has.
 */
export function credentialsChanged(): void {
  disconnect();
  if (state.connection === 'auth-failed' || state.connection === 'not-set-up') update({ connection: 'idle' });
  announce();
  if (wanted) void ensureConnected().catch(() => undefined);
}

/**
 * One connection attempt now, as a press makes: what Settings' Save asks
 * after saving. Keys showing OBS take the connection over; with none shown,
 * it is let go at once. If OBS is not there, the 60-second scan tries again
 * while a key wants it — nothing here schedules anything.
 */
export async function connectNow(): Promise<ObsAttempt> {
  return holding(async () => {
    try {
      const connected = await ensureConnected();
      return { ok: true, obsVersion: connected.obsVersion };
    } catch (err) {
      if (err instanceof NotSetUp) return { ok: false, reason: 'not-set-up', message: err.message };
      const saved = await obsCredentials().catch(() => null);
      return diagnose(err, saved?.host ?? DEFAULT_HOST, saved?.port ?? DEFAULT_PORT, saved?.password);
    }
  });
}

/**
 * Settings' Test connection: connect with these values — the ones in the
 * form, saved or not — and let go at once. Touches nothing the keys use.
 */
export async function testConnection(given: ObsCredentials): Promise<ObsAttempt> {
  const host = given.host ?? DEFAULT_HOST;
  const port = given.port ?? DEFAULT_PORT;
  try {
    const tested = await ObsClient.connect({ url: urlOf(host, port), password: given.password, events: 0, onEvent: () => undefined, onClose: () => undefined });
    tested.close();
    return { ok: true, obsVersion: tested.obsVersion };
  } catch (err) {
    return diagnose(err, host, port, given.password);
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WEBSOCKET_SETTINGS = 'OBS: Tools › WebSocket Server Settings';

/**
 * Which thing is wrong, in words that say where to fix it. A refused
 * connection carries no reason (Node's WebSocket gives none), and OBS not
 * running looks exactly like OBS running with its server off — off is its
 * default, so the most common first-time failure. On this machine the
 * difference is whether an OBS process exists; on another host it cannot be
 * told.
 */
async function diagnose(err: unknown, host: string, port: number, password: string | undefined): Promise<ObsAttempt> {
  const message = (err as Error).message;
  if (!(err instanceof ObsError)) return { ok: false, reason: 'protocol', message };
  if (err.kind === 'auth') {
    return password
      ? { ok: false, reason: 'auth', message: `OBS refused the password. Copy it from ${WEBSOCKET_SETTINGS} › Show Connect Info.` }
      : { ok: false, reason: 'no-password', message: `OBS asks for a password. Copy it from ${WEBSOCKET_SETTINGS} › Show Connect Info.` };
  }
  if (err.kind === 'protocol') return { ok: false, reason: 'protocol', message };
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: 'unreachable',
      message: `Nothing answered at ${host}:${port}. Check OBS is running there with its WebSocket server on (${WEBSOCKET_SETTINGS}), and the host and port.`,
    };
  }
  if (await obsIsRunning()) {
    return {
      ok: false,
      reason: 'server-off',
      message: `OBS is running, but its WebSocket server is off, or on a port other than ${port}. Turn it on in ${WEBSOCKET_SETTINGS} › Enable WebSocket server.`,
    };
  }
  return { ok: false, reason: 'not-running', message: 'OBS is not running. Start OBS, then test again.' };
}

/**
 * Whether an OBS process runs on this machine: any process named `obs` —
 * the RPM's /usr/bin/obs and the Flatpak's /app/bin/obs both are, and the
 * Flatpak's is visible from outside its sandbox. Read once, for a Test or a
 * Save that could not connect; nothing watches.
 */
export async function obsIsRunning(): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await fs.readFile(`/proc/${entry}/comm`, 'utf8')).trim() === 'obs') return true;
    } catch {
      // Gone since the listing, or not ours to read.
    }
  }
  return false;
}

const urlOf = (host: string, port: number) => `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;

/**
 * Send a request for a key press, connecting first if need be. Rejects with
 * a message fit for the key's failure badge.
 */
export async function request(requestType: string, requestData?: Record<string, unknown>, notFound?: string): Promise<Record<string, unknown>> {
  return pressWith(async (connected) => connected.request(requestType, requestData), notFound);
}

/**
 * Send a request, and resolve with the data of the first event `match`
 * accepts, or null if none comes within `withinMs` — for a request
 * obs-websocket answers "success" whether or not OBS acted on it.
 * ToggleRecordPause: OBS ignores a pause it cannot do, and says nothing.
 * StartStream and StartRecord: OBS sends STARTING, and a start that then
 * fails at once sends nothing more (OBSBasic::StartStreaming and
 * StartRecording return after their error dialog, without a STOPPED). The
 * wait is one-shot, inside the press; the waiter is in place before the
 * request is sent, since OBS may send the event before its answer.
 */
export async function requestAndConfirm(
  requestType: string,
  requestData: Record<string, unknown> | undefined,
  match: (type: string, data: Record<string, unknown>) => boolean,
  withinMs: number,
): Promise<Record<string, unknown> | null> {
  return pressWith(async (connected) => {
    let waiter!: { match: typeof match; resolve(data: Record<string, unknown> | null): void };
    const seen = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(null);
      }, withinMs);
      waiter = {
        match,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
      };
      waiters.add(waiter);
    });
    try {
      await connected.request(requestType, requestData);
    } catch (err) {
      waiters.delete(waiter);
      waiter.resolve(null);
      throw err;
    }
    return seen;
  });
}

/**
 * Ask OBS whether it is streaming and recording, and correct what the keys
 * show: for a start that OBS never finished and never said so (above), which
 * would otherwise stay "starting" until OBS's next output event. One request
 * each, after a press; never on a schedule.
 */
export async function refreshOutputs(): Promise<void> {
  const [stream, record] = await Promise.all([request('GetStreamStatus'), request('GetRecordStatus')]);
  // Running: live, unless it is on its way out (still active while stopping).
  const running = (current: OutputPhase): OutputPhase => (current === 'stopping' ? 'stopping' : 'live');
  update({
    stream: stream.outputReconnecting === true ? 'reconnecting' : stream.outputActive === true ? running(state.stream) : 'stopped',
    record: record.outputActive === true ? running(state.record) : 'stopped',
    recordPaused: record.outputActive === true && record.outputPaused === true,
  });
}

/**
 * `notFound`: what to say when OBS has nothing by the name the key gives
 * (RESOURCE_NOT_FOUND) — a scene or input renamed or deleted in OBS, which
 * the person can fix, so it is notified.
 */
async function pressWith<T>(run: (connected: ObsClient) => Promise<T>, notFound?: string): Promise<T> {
  return holding(async () => {
    try {
      return await run(await ensureConnected());
    } catch (err) {
      if (err instanceof NotSetUp) throw err;
      if (notFound && err instanceof ObsError && err.code === RESOURCE_NOT_FOUND) throw new ActionNeeded(notFound);
      // Not running, or the password: the message says what to do. A request
      // OBS itself refused is OBS's business, and only badges the key.
      const needed = err instanceof ObsError && (err.kind === 'unavailable' || err.kind === 'auth');
      throw needed ? new ActionNeeded(describeFailure(err)) : new Error(describeFailure(err));
    }
  });
}

/** libobs' OBS_SOURCE_AUDIO output flag (obs-source.h): an input with audio, which a Mute key can mute. */
const OBS_SOURCE_AUDIO = 1 << 1;

/**
 * What an OBS key's picker offers, asked of OBS now — connecting as a press
 * does, and letting go after if no key is shown. Scenes and a scene's sources
 * in the order OBS's own lists show them (highest index first, from
 * obs-websocket's sceneIndex and sceneItemIndex — checked against OBS's
 * window by eye); audio inputs only, by name.
 */
export async function list(kind: 'scenes' | 'inputs' | 'sources', scene?: string): Promise<ObsList> {
  return holding(async () => {
    let connected: ObsClient;
    try {
      connected = await ensureConnected();
    } catch (err) {
      if (err instanceof NotSetUp) return { ok: false, reason: 'not-set-up', message: err.message };
      if (err instanceof ObsError && err.kind === 'auth') return { ok: false, reason: 'auth', message: describeFailure(err) };
      return { ok: false, reason: 'unavailable', message: 'Start OBS to choose' };
    }
    const byIndex = (index: string) => (a: Record<string, unknown>, b: Record<string, unknown>) => Number(b[index] ?? 0) - Number(a[index] ?? 0);
    const records = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null) : []);
    const names = (items: Record<string, unknown>[], field: string) => [...new Set(items.map((i) => i[field]).filter((n): n is string => typeof n === 'string'))];
    try {
      if (kind === 'scenes') {
        const { scenes } = await connected.request('GetSceneList');
        return { ok: true, names: names(records(scenes).sort(byIndex('sceneIndex')), 'sceneName') };
      }
      if (kind === 'inputs') {
        const { inputs } = await connected.request('GetInputList');
        // GetInputList carries inputKindCaps since obs-websocket 5.6.0 (its source; protocol.md lists it only
        // on InputCreated). Without it, every input is offered.
        const audio = records(inputs).filter((i) => typeof i.inputKindCaps !== 'number' || (i.inputKindCaps & OBS_SOURCE_AUDIO) !== 0);
        return { ok: true, names: names(audio, 'inputName').sort((a, b) => a.localeCompare(b)) };
      }
      if (!scene) return { ok: false, reason: 'other', message: 'Choose a scene first' };
      const { sceneItems } = await connected.request('GetSceneItemList', { sceneName: scene });
      return { ok: true, names: names(records(sceneItems).sort(byIndex('sceneItemIndex')), 'sourceName') };
    } catch (err) {
      if (err instanceof ObsError && err.code === RESOURCE_NOT_FOUND) return { ok: false, reason: 'not-found', message: `OBS has no scene named "${scene}"` };
      return { ok: false, reason: err instanceof ObsError && err.kind === 'unavailable' ? 'unavailable' : 'other', message: (err as Error).message };
    }
  });
}

/** Keep a connection open while `run` needs it; with no OBS key shown, let it go after. */
async function holding<T>(run: () => Promise<T>): Promise<T> {
  pressing++;
  try {
    return await run();
  } finally {
    pressing--;
    // A press from a script, with no OBS key shown, does not keep OBS open.
    if (!wanted && pressing === 0) disconnect();
  }
}

function describeFailure(err: unknown): string {
  if (!(err instanceof ObsError)) return (err as Error).message;
  if (err.kind === 'unavailable') return 'OBS is not running, or its WebSocket server is off (OBS: Tools › WebSocket Server Settings)';
  if (err.kind === 'auth') return `${err.message}: set the password in Deckhand's Settings › Integrations › OBS, from OBS's Tools › WebSocket Server Settings › Show Connect Info`;
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
  // Read first, and outside the try: not set up is not OBS being unavailable,
  // and the 60-second scan must not retry it (retry() only retries unavailable).
  const saved = await obsCredentials().catch((err: Error) => {
    update({ connection: 'unavailable', ...NOTHING_KNOWN });
    throw err;
  });
  if (!saved) {
    update({ connection: 'not-set-up', ...NOTHING_KNOWN });
    throw new NotSetUp(NOT_SET_UP_MESSAGE);
  }
  update({ connection: 'connecting' });
  let opened: ObsClient;
  try {
    const credentials = saved;
    opened = await ObsClient.connect({
      url: urlOf(credentials.host ?? DEFAULT_HOST, credentials.port ?? DEFAULT_PORT),
      password: credentials.password,
      events: EVENTS,
      onEvent,
      onClose: () => {
        // Let go of on purpose (disconnect) is not OBS going away: that is idle, already said.
        if (client !== opened) return;
        client = null;
        // Gone: nothing it showed is known any more.
        itemIds.clear();
        update({ connection: 'unavailable', ...NOTHING_KNOWN });
      },
    });
  } catch (err) {
    const auth = err instanceof ObsError && err.kind === 'auth';
    update({ connection: auth ? 'auth-failed' : 'unavailable', ...NOTHING_KNOWN });
    if (auth) console.error(`[obs] ${(err as Error).message}`);
    throw err;
  }
  client = opened;
  console.log(`[obs] connected to OBS ${opened.obsVersion}`);
  try {
    const [stream, record, scene] = await Promise.all([
      opened.request('GetStreamStatus'),
      opened.request('GetRecordStatus'),
      opened.request('GetCurrentProgramScene'),
    ]);
    update({
      connection: 'connected',
      stream: stream.outputReconnecting === true ? 'reconnecting' : stream.outputActive === true ? 'live' : 'stopped',
      record: record.outputActive === true ? 'live' : 'stopped',
      recordPaused: record.outputPaused === true,
      programScene: programSceneOf(scene),
    });
    await seed(opened, needs);
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
    itemIds.clear();
    update({ connection: 'idle', ...NOTHING_KNOWN });
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

/** GetCurrentProgramScene's answer: `sceneName` since obs-websocket 5.4.0, `currentProgramSceneName` before (deprecated, still sent). */
function programSceneOf(data: Record<string, unknown>): string | null {
  const name = data.sceneName ?? data.currentProgramSceneName;
  return typeof name === 'string' ? name : null;
}

/** Forget what no shown key names any more. */
function forgetUnneeded(): void {
  const inputs = Object.fromEntries(Object.entries(state.inputMuted).filter(([name]) => needs.inputs.includes(name)));
  const wantedItems = new Set(needs.items.map((it) => itemKey(it.scene, it.source)));
  const items = Object.fromEntries(Object.entries(state.itemEnabled).filter(([key]) => wantedItems.has(key)));
  for (const key of itemIds.keys()) if (!wantedItems.has(key)) itemIds.delete(key);
  update({ inputMuted: inputs, itemEnabled: items });
}

/**
 * Ask OBS for these inputs' mute states and these items' visibility, once:
 * when first shown, on connecting, and when OBS renames, adds or removes
 * something a key names. One request per input, two per item (its id, then
 * its state). One OBS has no longer is forgotten — the key shows its resting
 * face, and a press says what is missing.
 */
async function seed(connected: ObsClient, which: ObsNeeds): Promise<void> {
  const muted = await Promise.all(
    which.inputs.map((inputName) =>
      connected.request('GetInputMute', { inputName }).then(
        (r) => [inputName, r.inputMuted === true] as const,
        () => [inputName, null] as const,
      ),
    ),
  );
  const enabled = await Promise.all(
    which.items.map(async ({ scene, source }) => {
      const key = itemKey(scene, source);
      try {
        const { sceneItemId } = await connected.request('GetSceneItemId', { sceneName: scene, sourceName: source });
        if (typeof sceneItemId !== 'number') throw new Error('no id');
        itemIds.set(key, sceneItemId);
        const r = await connected.request('GetSceneItemEnabled', { sceneName: scene, sceneItemId });
        return [key, r.sceneItemEnabled === true] as const;
      } catch {
        itemIds.delete(key);
        return [key, null] as const;
      }
    }),
  );
  if (client !== connected) return;
  const inputMuted = { ...state.inputMuted };
  for (const [name, value] of muted) {
    if (value === null || !needs.inputs.includes(name)) delete inputMuted[name];
    else inputMuted[name] = value;
  }
  const itemEnabled = { ...state.itemEnabled };
  for (const [key, value] of enabled) {
    if (value === null) delete itemEnabled[key];
    else itemEnabled[key] = value;
  }
  update({ inputMuted, itemEnabled });
}

/** The names an OBS event about inputs, scenes or scene items mentions. */
const STRUCTURE_EVENTS = new Set(['InputCreated', 'InputRemoved', 'InputNameChanged', 'SceneRemoved', 'SceneNameChanged', 'SceneItemCreated', 'SceneItemRemoved']);

function namesKeysUse(data: Record<string, unknown>): boolean {
  const names = [data.inputName, data.oldInputName, data.sceneName, data.oldSceneName, data.sourceName].filter((n): n is string => typeof n === 'string');
  return names.some((n) => needs.inputs.includes(n) || needs.items.some((it) => it.scene === n || it.source === n));
}

function onEvent(type: string, data: Record<string, unknown>): void {
  for (const waiter of [...waiters]) {
    if (!waiter.match(type, data)) continue;
    waiters.delete(waiter);
    waiter.resolve(data);
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
    case 'CurrentProgramSceneChanged':
      if (typeof data.sceneName === 'string') update({ programScene: data.sceneName });
      break;
    case 'SceneNameChanged':
      // The program scene renamed is still the program scene.
      if (typeof data.sceneName === 'string' && data.oldSceneName === state.programScene) update({ programScene: data.sceneName });
      break;
    case 'InputMuteStateChanged':
      if (typeof data.inputName === 'string' && needs.inputs.includes(data.inputName)) {
        update({ inputMuted: { ...state.inputMuted, [data.inputName]: data.inputMuted === true } });
      }
      break;
    case 'SceneItemEnableStateChanged':
      for (const [key, id] of itemIds) {
        if (id === data.sceneItemId && key.startsWith(`${String(data.sceneName)}\u0000`)) {
          update({ itemEnabled: { ...state.itemEnabled, [key]: data.sceneItemEnabled === true } });
        }
      }
      break;
    default:
      break;
  }
  // Something a key names appeared, went or was renamed: ask again for what the shown keys need.
  if (STRUCTURE_EVENTS.has(type) && client && namesKeysUse(data)) void seed(client, needs).catch(() => undefined);
}
