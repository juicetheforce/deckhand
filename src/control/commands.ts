import { isKnownAction } from '../actions/index.js';
import type { DeckSession } from '../deck.js';
import type { DeckGeometry } from '../geometry.js';
import { ProfileNotFoundError, type Profiles } from '../profiles.js';
import { pickableDevices, type AudioState } from '../services/audio.js';
import type { ActionDef, ButtonDef } from '../types.js';
import type { AudioList, BackupStatus, DeckStatus, ReloadResult, StateSnapshot } from './protocol.js';
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
 * The three event notifications, for the daemon to call when things change.
 * Each is cheap to call often: the server merges calls within one event-loop
 * turn, and "audio" is sent only when a device list actually changed.
 */
export function eventNotifiers(server: ControlServer, deps: ControlDeps) {
  let lastAudio = '';
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

    // Both read the audio cache, which pactl subscribe keeps current: a request
    // never spawns pactl, so a burst of them cannot become a burst of processes.
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
