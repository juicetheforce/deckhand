import type { DeckGeometry } from '../geometry.js';

/**
 * The shapes the control socket sends, for
 * every client: the CLI and the editor.
 *
 * Types only, and this file must import nothing but other import-free type
 * files (geometry.ts is one). The editor's renderer imports it; a type-only
 * import of a file that imports Node or daemon code drags that code's types —
 * @types/node, sharp, dbus-next — into the renderer's type check, which then
 * lets renderer code use `process` or `Buffer` without complaint.
 */

/** The result of the most recent config load or reload. */
export interface ReloadResult {
  ok: boolean;
  /** ISO 8601 time. */
  at: string;
  error?: string;
}

/** Where rolling config backups are kept. Read from memory, so the socket never touches the disk for it. */
export interface BackupStatus {
  dir: string;
  count: number;
  /** ISO time of the newest backup, or null if there is none. */
  newest: string | null;
  /** The most recent failure, if the last attempt failed. */
  error?: string;
}

/** One entry in the control socket's device list. */
export interface PickableDevice {
  node: string;
  label: string;
  available: 'yes' | 'no' | 'unknown';
}

/** audio.sinks / audio.sources results; the "audio" event carries one of each. */
export interface AudioList {
  default: string;
  devices: PickableDevice[];
}

export interface DeckStatus {
  serial: string;
  connected: boolean;
  configured: boolean;
  profile?: string;
  page?: string;
  brightness?: number;
  /** Keys showing a preview. */
  previews?: number[];
  /** Keys latched down by a toggle, so the editor's grid can show it. */
  latched?: number[];
  /** Keys whose last press failed, on any page or profile. */
  failed?: KeyFailure[];
}

/** A key whose last press failed. It stays so until a press of it succeeds, or it is edited. */
export interface KeyFailure {
  profile: string;
  page: string;
  key: number;
  /** The failed action's error message, as logged. */
  error: string;
}

/** The part of "status" that the "state" event also carries. */
export interface StateSnapshot {
  activeProfile: { id: string; name: string | null } | null;
  decks: DeckStatus[];
}

/** The "status" result. */
export type StatusResult = StateSnapshot & {
  protocol: number;
  pid: number;
  // backups is absent when talking to a daemon from before rolling backups.
  config: { path: string; lastReload: ReloadResult; backups?: BackupStatus };
};

/** The "decks" result. */
/** One installed application, as the `apps` command lists it. */
export interface AppListing {
  /** The desktop file ID: what an app key's `app` holds. */
  id: string;
  name: string;
  /** Its icon, resolved to a file at 96 px, or null when none can be found. */
  icon: string | null;
}

export type DecksResult = Array<{ serial: string } & DeckGeometry>;

/** The "profile.switch" result. */
export type SwitchResult = { active: { id: string; name: string | null }; changed: boolean };

/** Where an OBS output is, as a key shows it: obs-websocket's output states, folded. */
export type ObsOutputPhase = 'stopped' | 'starting' | 'live' | 'stopping' | 'reconnecting';

export type ObsConnection =
  /** Nothing needs OBS, and no connection has been tried. */
  | 'idle'
  /** No saved connection: OBS has not been set up in Deckhand's Settings. Nothing connects. */
  | 'not-set-up'
  | 'connecting'
  | 'connected'
  /** OBS is not running, its WebSocket server is off, or it went away. */
  | 'unavailable'
  /** OBS refused the password, or asked for one and none is set. */
  | 'auth-failed';

/** The "obs.status" result, and what the "obs" event carries. Never a secret: only whether a password is set. */
export interface ObsStatus {
  connection: ObsConnection;
  stream: ObsOutputPhase;
  record: ObsOutputPhase;
  recordPaused: boolean;
  /** A connection is saved: OBS keys can do something. */
  setUp: boolean;
  host: string | null;
  port: number | null;
  passwordSet: boolean;
}

/** How one attempt to reach OBS went: "obs.test", and "obs.credentials"'s `attempt`. */
export type ObsAttempt =
  | { ok: true; obsVersion: string }
  | { ok: false; reason: 'not-set-up' | 'not-running' | 'server-off' | 'unreachable' | 'auth' | 'no-password' | 'protocol'; message: string };

/**
 * The "obs.list" result: what an OBS key's picker offers — scenes, audio
 * inputs, or one scene's sources — in OBS's own order where it has one. Not
 * reachable is an answer, not an error: the picker says "Start OBS to choose".
 */
export type ObsList =
  | { ok: true; names: string[] }
  | { ok: false; reason: 'not-set-up' | 'unavailable' | 'auth' | 'not-found' | 'other'; message: string };
