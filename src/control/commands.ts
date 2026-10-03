import { isKnownAction } from '../actions/index.js';
import type { DeckSession } from '../deck.js';
import type { DeckGeometry } from '../geometry.js';
import { ProfileNotFoundError, type Profiles } from '../profiles.js';
import { obsCredentials, removeObsCredentials, removeVtsCredentials, setObsCredentials, vtsCredentials } from '../credentials.js';
import { forgetApps, listApps } from '../services/apps.js';
import * as obsService from '../services/obs.js';
import * as vtsService from '../services/vts.js';
import { pickableDevices, type AudioState } from '../services/audio.js';
import { resolveIcon } from '../services/icon-theme.js';
import type { ActionDef, ButtonDef } from '../types.js';
import type { AppListing, AudioList, BackupStatus, DeckStatus, ObsStatus, ReloadResult, StateSnapshot, VtsStatus } from './protocol.js';
import {
  ControlError,
  EVENT_NAMES,
  PROTOCOL_VERSION,
  type Connection,
  type ControlServer,
  type EventName,
  type Handler,
} from './server.js';

/**
 * What each control-socket command does.
 * Everything the handlers need from the daemon comes in through ControlDeps,
 * so the smoke test can run them against fake decks.
 */

export interface ControlDeps {
  sessions: Map<string, DeckSession>;
  /** Null only before the first config has loaded. */
  profiles: () => Profiles | null;
  configPath: string;
  lastReload: () => ReloadResult;
  /** Where rolling config backups are kept, and how many; from memory, never the disk. */
  backups: () => BackupStatus;
  /**
   * Connected decks that have no session because no profile has a layout for
   * them, with the geometry read when they were last opened. The daemon opens
   * such a deck briefly on attach, reads its controls and closes it again; it
   * is never held open.
   */
  unattachedDecks: () => ReadonlyMap<string, DeckGeometry>;
  /**
   * Release every key a socket action still holds (input.releaseAllHeldBy
   * with source 'socket'), returning the keycodes released.
   */
  releaseSocketKeys: () => Promise<number[]>;
  /** The audio cache (services/audio.ts cachedState), or null before its first refresh. */
  audioState: () => AudioState | null;
}

/**
 * The event notifications, for the daemon to call when things change.
 * Each is cheap to call often: the server merges calls within one event-loop
 * turn, and "audio" is sent only when a device list actually changed.
 */
export function eventNotifiers(server: ControlServer, deps: ControlDeps) {
  let lastAudio = '';
  let obsEvents = Promise.resolve();
  let vtsEvents = Promise.resolve();
  return {
    state: () => server.notify('state', () => stateSnapshot(deps)),
    config: () => server.notify('config', () => deps.lastReload()),
    audio: () => {
      const lists = audioLists(deps.audioState());
      if (lists === null) return;
      const serialized = JSON.stringify(lists);
      if (serialized === lastAudio) return;
      lastAudio = serialized;
      server.notify('audio', () => lists);
    },
    // obs.status's reply, which reads the credentials file: read in order, so
    // a later change is never overtaken by an earlier one's slower read.
    obs: () => {
      obsEvents = obsEvents.then(async () => {
        const status = await obsStatus().catch(() => null);
        if (status) server.notify('obs', () => status);
      });
    },
    // vts.status's reply, read in order as obs's is.
    vts: () => {
      vtsEvents = vtsEvents.then(async () => {
        const status = await vtsStatus().catch(() => null);
        if (status) server.notify('vts', () => status);
      });
    },
  };
}

/** audio.sinks / audio.sources results, also what the "audio" event carries. */
export function audioLists(state: AudioState | null): { sinks: AudioList; sources: AudioList } | null {
  if (!state) return null;
  return {
    sinks: { default: state.defaultSink, devices: pickableDevices(state.sinkDevices, 'sink') },
    sources: { default: state.defaultSource, devices: pickableDevices(state.sourceDevices, 'source') },
  };
}

/** action.run's hold between "action" and "onRelease". */
export const DEFAULT_HOLD_MS = 100;
export const MAX_HOLD_MS = 10_000;

/** The part of "status" that the "state" event also carries. */
export function stateSnapshot(deps: ControlDeps): StateSnapshot {
  const profiles = deps.profiles();
  const configured = profiles?.configuredSerials() ?? new Set<string>();
  const unattached = deps.unattachedDecks();
  const serials = new Set<string>([...deps.sessions.keys(), ...unattached.keys(), ...configured]);

  const decks: DeckStatus[] = [...serials].sort().map((serial) => {
    const session = deps.sessions.get(serial);
    const entry: DeckStatus = {
      serial,
      connected: session !== undefined || unattached.has(serial),
      configured: configured.has(serial),
    };
    if (session) {
      entry.profile = profiles?.shownProfileFor(serial);
      entry.page = session.currentPage();
      entry.brightness = session.currentBrightness();
      entry.previews = session.previewKeys();
      entry.latched = session.latchedKeys();
      entry.failed = session.failedKeys();
    }
    return entry;
  });

  const activeId = profiles?.activeProfile();
  return {
    activeProfile: activeId === undefined ? null : { id: activeId, name: profiles?.profileName(activeId) ?? null },
    decks,
  };
}

export function createHandlers(deps: ControlDeps): Record<string, Handler> {
  /**
   * Which connection set each preview, keyed "serial:key". Last writer wins.
   * When a connection closes, the previews it still owns are cleared, so a
   * crashed editor cannot leave a key showing something unsaved.
   */
  const previewOwners = new Map<string, Connection>();
  const cleanupRegistered = new WeakSet<Connection>();

  /**
   * One socket action at a time across the whole daemon.
   * The input helper's queue is shared with physical key presses, so each
   * socket keystroke waiting in it is a delay for a press; with one socket
   * action at a time, a press waits behind at most one helper command.
   */
  let socketActionRunning = false;

  const releasePreviewsOf = (connection: Connection) => {
    for (const [slot, owner] of previewOwners) {
      if (owner !== connection) continue;
      previewOwners.delete(slot);
      const separator = slot.lastIndexOf(':');
      const session = deps.sessions.get(slot.slice(0, separator));
      void session?.clearPreview(Number(slot.slice(separator + 1)));
    }
  };

  return {
    async status() {
      return {
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        config: { path: deps.configPath, lastReload: deps.lastReload(), backups: deps.backups() },
        ...stateSnapshot(deps),
      };
    },

    async decks() {
      const result: Array<{ serial: string } & DeckGeometry> = [];
      for (const [serial, session] of deps.sessions) result.push({ serial, ...session.geometry });
      for (const [serial, geometry] of deps.unattachedDecks()) {
        if (!deps.sessions.has(serial)) result.push({ serial, ...geometry });
      }
      return result.sort((a, b) => a.serial.localeCompare(b.serial));
    },

    async repaint(args) {
      const serial = optionalString(args, 'serial');
      const targets = serial === undefined ? [...deps.sessions.keys()] : [serial];
      if (serial !== undefined) sessionFor(deps, serial);
      // Repaints of different decks run side by side; each deck merges its own bursts.
      await Promise.all(targets.map((s) => deps.sessions.get(s)?.repaint()));
      return { repainted: targets.sort() };
    },

    async 'profile.switch'(args) {
      const to = requireString(args, 'to');
      const profiles = deps.profiles();
      if (!profiles) throw new ControlError('internal', 'no config loaded yet');
      let changed: boolean;
      try {
        // The same path the "profile" action takes; never a reimplementation.
        changed = await profiles.switchTo(to, deps.sessions);
      } catch (err) {
        if (err instanceof ProfileNotFoundError) throw new ControlError('not_found', err.message);
        throw err;
      }
      const id = profiles.activeProfile();
      return { active: { id, name: profiles.profileName(id) }, changed };
    },

    async 'preview.set'(args, connection) {
      const serial = requireString(args, 'serial');
      const key = requireKey(args, 'key');
      const button = requireButton(args, 'button');
      const session = sessionFor(deps, serial);
      if (!session.hasKey(key)) throw new ControlError('not_found', `deck "${serial}" has no key ${key}`);

      previewOwners.set(`${serial}:${key}`, connection);
      if (!cleanupRegistered.has(connection)) {
        cleanupRegistered.add(connection);
        connection.onClose(() => releasePreviewsOf(connection));
      }
      try {
        await session.setPreview(key, button);
      } catch (err) {
        if (previewOwners.get(`${serial}:${key}`) === connection && !session.previewKeys().includes(key)) {
          previewOwners.delete(`${serial}:${key}`);
        }
        throw new ControlError('render_failed', (err as Error).message);
      }
      return {};
    },

    async 'preview.clear'(args) {
      const serial = requireString(args, 'serial');
      const key = args.key === undefined ? undefined : requireKey(args, 'key');
      const session = sessionFor(deps, serial);
      if (key !== undefined && !session.hasKey(key)) {
        throw new ControlError('not_found', `deck "${serial}" has no key ${key}`);
      }
      const cleared = await session.clearPreview(key);
      for (const index of cleared) previewOwners.delete(`${serial}:${index}`);
      return { cleared };
    },

    async subscribe(args, connection) {
      const events = args.events;
      if (!Array.isArray(events) || events.some((e) => typeof e !== 'string')) {
        throw new ControlError('bad_request', `"events" must be a list drawn from ${EVENT_NAMES.join(', ')}`);
      }
      const unknown = events.filter((e) => !EVENT_NAMES.includes(e as EventName));
      if (unknown.length > 0) {
        throw new ControlError('bad_request', `unknown event(s) ${unknown.join(', ')}; known: ${EVENT_NAMES.join(', ')}`);
      }
      // Replaces the set. No snapshot is sent: subscribe first, then ask for
      // status, and no change can fall between the two.
      connection.subscriptions = new Set(events as EventName[]);
      return { events: [...connection.subscriptions] };
    },

    /**
     * Clear one key's failure mark, at the person's word (the editor's
     * Clear). A press that works and an edit of the key clear it too; nothing
     * else does — never a timer or a page switch (ARCHITECTURE).
     */
    async 'failure.clear'(args) {
      const session = sessionFor(deps, requireString(args, 'serial'));
      return { cleared: session.clearFailure(requireString(args, 'profile'), requireString(args, 'page'), requireKey(args, 'key')) };
    },

    /**
     * OBS: the connection, what it shows, and which credentials are set —
     * never a secret. The password is reported only as set or not
     * (credentials.ts; scope §3, "Secrets").
     */
    async 'obs.status'() {
      return obsStatus();
    },

    /**
     * Set OBS's host, port or password — which sets OBS up, if it was not. A
     * field left out is unchanged; null or "" removes it. Then one attempt to
     * connect, as a press makes, so the reply can say how it went (`attempt`).
     * Replies as obs.status does, never echoing the password.
     */
    async 'obs.credentials'(args) {
      const change: { host?: string | null; port?: number | null; password?: string | null } = {};
      for (const name of ['host', 'password'] as const) {
        if (!(name in args)) continue;
        const value = args[name];
        if (value !== null && typeof value !== 'string') throw new ControlError('bad_request', `"${name}" must be a string or null`);
        change[name] = value;
      }
      if ('port' in args) {
        const port = args.port;
        if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
          throw new ControlError('bad_request', '"port" must be a whole number from 1 to 65535, or null');
        }
        change.port = port;
      }
      if (Object.keys(change).length === 0) throw new ControlError('bad_request', 'give at least one of "host", "port" and "password"');
      await setObsCredentials(change);
      obsService.credentialsChanged();
      const attempt = await obsService.connectNow();
      return { ...(await obsStatus()), attempt };
    },

    /**
     * Settings' Test connection: connect with these values and let go — the
     * form's, saved or not; a field left out uses the saved one. Says which
     * thing is wrong. Changes nothing.
     */
    async 'obs.test'(args) {
      const saved = (await obsCredentials()) ?? {};
      const host = 'host' in args ? args.host : saved.host;
      const port = 'port' in args ? args.port : saved.port;
      const password = 'password' in args ? args.password : saved.password;
      if (host !== undefined && host !== null && typeof host !== 'string') throw new ControlError('bad_request', '"host" must be a string');
      if (port !== undefined && port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new ControlError('bad_request', '"port" must be a whole number from 1 to 65535');
      }
      if (password !== undefined && password !== null && typeof password !== 'string') throw new ControlError('bad_request', '"password" must be a string');
      return obsService.testConnection({ host: host || undefined, port: port ?? undefined, password: password || undefined });
    },

    /**
     * What an OBS key's picker offers: `kind` "scenes", "inputs" (audio ones)
     * or "sources" (of `scene`). Connects as a press does; OBS not there is
     * an answer (ok false, a reason), not an error.
     */
    async 'obs.list'(args) {
      const kind = args.kind;
      if (kind !== 'scenes' && kind !== 'inputs' && kind !== 'sources') throw new ControlError('bad_request', '"kind" must be "scenes", "inputs" or "sources"');
      if (kind === 'sources' && (typeof args.scene !== 'string' || args.scene === '')) throw new ControlError('bad_request', '"scene" must name a scene');
      return obsService.list(kind, kind === 'sources' ? (args.scene as string) : undefined);
    },

    /**
     * Remove OBS's saved connection: disconnects at once and deletes its
     * credentials. No key is touched — OBS keys stay where they are, show
     * that OBS is not set up, and come back when it is set up again.
     */
    async 'obs.remove'() {
      await removeObsCredentials();
      obsService.credentialsChanged();
      return obsStatus();
    },

    /**
     * VTube Studio: the connection, the model loaded, where Connect is, and
     * whether a token is saved — never the token itself (credentials.ts).
     */
    async 'vts.status'() {
      return vtsStatus();
    },

    /**
     * Settings' Connect: ask VTube Studio for access. Replies at once —
     * `started` false when a request is already under way; how it goes comes
     * as "vts" events (`approval`), since it waits for the person to answer
     * VTS's window. `port`: where to look first (else the saved one, or
     * 8001). Only this ever asks VTS for a token (scope §7).
     */
    async 'vts.connect'(args) {
      const port = args.port;
      if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new ControlError('bad_request', '"port" must be a whole number from 1 to 65535');
      }
      const started = await vtsService.requestAccess(port as number | undefined);
      return { started, ...(await vtsStatus()) };
    },

    /**
     * What a VTube Studio key's picker offers: `kind` "models", or "hotkeys"
     * of `model` (an ID). Connects as a press does; VTS not there is an
     * answer, not an error.
     */
    async 'vts.list'(args) {
      const kind = args.kind;
      if (kind !== 'models' && kind !== 'hotkeys') throw new ControlError('bad_request', '"kind" must be "models" or "hotkeys"');
      if (kind === 'hotkeys' && (typeof args.model !== 'string' || args.model === '')) throw new ControlError('bad_request', '"model" must name a model by its ID');
      return vtsService.list(kind, kind === 'hotkeys' ? (args.model as string) : undefined);
    },

    /**
     * Remove VTube Studio's saved token: disconnects and deletes it. A
     * request still waiting in VTS's window is let go — the window stays,
     * the person's to answer. No key is touched. Deckhand stays in VTS's own
     * plugin list until removed there.
     */
    async 'vts.remove'() {
      await removeVtsCredentials();
      vtsService.removeAccess();
      return vtsStatus();
    },

    // Both read the audio cache, which pactl subscribe keeps current: a request
    // never spawns pactl, so a burst of them cannot become a burst of processes.
    // The installed applications an app key can open, each with its icon
    // resolved. Read afresh: what was cached is forgotten first, so opening
    // the editor's app list picks up a new app or a changed icon theme — for
    // the deck's keys too, the next time they are drawn. The one thing that
    // re-reads them; nothing watches.
    async apps(): Promise<AppListing[]> {
      forgetApps();
      const apps = await listApps();
      return Promise.all(apps.map(async (a) => ({ id: a.id, name: a.name, icon: a.icon ? await resolveIcon(a.icon, 96) : null })));
    },

    async 'audio.sinks'() {
      const lists = audioLists(deps.audioState());
      if (!lists) throw new ControlError('internal', 'audio state has not been read yet');
      return lists.sinks;
    },

    async 'audio.sources'() {
      const lists = audioLists(deps.audioState());
      if (!lists) throw new ControlError('internal', 'audio state has not been read yet');
      return lists.sources;
    },

    async 'action.run'(args) {
      const serial = requireString(args, 'serial');
      const action = requireAction(args.action, 'action');
      const onRelease = args.onRelease === undefined ? undefined : requireAction(args.onRelease, 'onRelease');
      let holdMs = DEFAULT_HOLD_MS;
      if (args.holdMs !== undefined) {
        if (onRelease === undefined) throw new ControlError('bad_request', '"holdMs" only applies with "onRelease"');
        if (typeof args.holdMs !== 'number' || !Number.isFinite(args.holdMs) || args.holdMs < 0 || args.holdMs > MAX_HOLD_MS) {
          throw new ControlError('bad_request', `"holdMs" must be a number from 0 to ${MAX_HOLD_MS}`);
        }
        holdMs = args.holdMs;
      }
      const session = sessionFor(deps, serial);

      if (socketActionRunning) {
        throw new ControlError('busy', 'another action sent over the socket is still running');
      }
      socketActionRunning = true;
      // Nothing below depends on the client: if it disconnects, the action,
      // its release and the final key release all still happen.
      try {
        let failure: Error | null = null;
        try {
          await session.runFromSocket(action);
        } catch (err) {
          failure = err as Error;
        }
        if (onRelease) {
          // A failed press still gets its release, straight away: it may have
          // pressed some keys before failing.
          if (failure === null) await new Promise((resolve) => setTimeout(resolve, holdMs));
          try {
            await session.runFromSocket(onRelease);
          } catch (err) {
            failure ??= err as Error;
          }
        }
        // Whatever is still held — a keyHold "down" with no matching "up", a
        // multi that pressed and stopped, an onRelease that released the wrong
        // key — is released now. No socket action can leave a key down.
        try {
          const released = await deps.releaseSocketKeys();
          if (released.length > 0) {
            console.warn(`[control] action.run left ${released.length} key(s) held (${released.join(' ')}); released them`);
          }
        } catch (err) {
          console.error(`[control] could not release keys held by action.run: ${(err as Error).message}`);
        }
        if (failure) throw new ControlError('action_failed', failure.message);
        return {};
      } finally {
        socketActionRunning = false;
      }
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKey(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ControlError('bad_request', `"${name}" must be a key index (a whole number, 0 or more)`);
  }
  return value;
}

/** An action as the socket accepts it: an object whose type is registered. */
export function requireAction(value: unknown, name: string): ActionDef {
  if (!isObject(value) || typeof value.type !== 'string') {
    throw new ControlError('bad_request', `"${name}" must be an action object with a "type"`);
  }
  if (!isKnownAction(value.type)) throw new ControlError('bad_request', `"${name}" has unknown action type "${value.type}"`);
  return value as ActionDef;
}

function requireButton(args: Record<string, unknown>, name: string): ButtonDef {
  const value = args[name];
  if (!isObject(value)) throw new ControlError('bad_request', `"${name}" must be a button object`);
  // null is a real value here: a preview of a label-only button.
  if (value.icon !== undefined && value.icon !== null && typeof value.icon !== 'string') {
    throw new ControlError('bad_request', `"${name}.icon" must be a path`);
  }
  if (value.label !== undefined && typeof value.label !== 'string') {
    throw new ControlError('bad_request', `"${name}.label" must be a string`);
  }
  if (value.action !== undefined) requireAction(value.action, `${name}.action`);
  return value as ButtonDef;
}

/** The running session for a serial, or the error a client should see. */
export function sessionFor(deps: ControlDeps, serial: string): DeckSession {
  const session = deps.sessions.get(serial);
  if (session) return session;
  const known = deps.unattachedDecks().has(serial) || deps.profiles()?.configuredSerials().has(serial);
  if (known) throw new ControlError('deck_not_connected', `deck "${serial}" is not connected or has no layout`);
  throw new ControlError('not_found', `no deck with serial "${serial}"`);
}

/** Argument helpers shared by the handlers. */
export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new ControlError('bad_request', `"${name}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  if (args[name] === undefined) return undefined;
  return requireString(args, name);
}

async function vtsStatus(): Promise<VtsStatus> {
  const credentials = await vtsCredentials();
  const { connection, modelId, approval } = vtsService.cachedState();
  return { connection, modelId, approval, setUp: credentials !== null, port: credentials?.port ?? null };
}

async function obsStatus(): Promise<ObsStatus> {
  const credentials = await obsCredentials();
  return {
    ...obsService.cachedState(),
    /** A connection is saved (credentials.ts): OBS keys can do something. */
    setUp: credentials !== null,
    host: credentials?.host ?? null,
    port: credentials?.port ?? null,
    passwordSet: credentials?.password !== undefined,
  };
}
