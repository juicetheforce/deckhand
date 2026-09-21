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
export type DecksResult = Array<{ serial: string } & DeckGeometry>;

/** The "profile.switch" result. */
export type SwitchResult = { active: { id: string; name: string | null }; changed: boolean };
