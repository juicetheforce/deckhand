/**
 * The API the preload script exposes to the renderer as `window.deckhand`,
 * and the state it carries. Types only, importing nothing that touches Node:
 * shared by main (which produces the state), the preload (which implements
 * the API) and the renderer (which calls it). The renderer has no Node and no
 * direct access to Electron.
 */
import type { DecksResult, StatusResult } from '../../../src/control/protocol.js';
import type { ButtonDef, Config } from '../../../src/types.js';
import type { ApplyResult, Edit } from './edits.js';

/** config.json changed on disk while the editor had unsaved edits. */
export interface Conflict {
  /** The file's text now. */
  fileText: string;
  /** Why that text cannot be used, if it is not a valid config. */
  fileError?: string;
}

/** The editor's copy of config.json (src/main/config-store.ts). */
export interface StoreState {
  config: Config;
  /** Accepted edits not yet written. */
  dirty: boolean;
  /** The file changed on disk while there were unsaved edits. Editing is blocked until resolved. */
  conflict: Conflict | null;
  /** The file on disk is not a valid config (and nothing is unsaved). Editing is blocked until it is fixed. */
  fileError: string | null;
  /** Saving would reformat the whole file; nothing is written until acknowledged. */
  reformatPending: boolean;
  /** The most recent write failure, cleared by a successful write. */
  saveError: string | null;
}

/** The store, or why config.json could not be opened at all (missing, invalid, a symlink). */
export type StoreView = { open: true; state: StoreState } | { open: false; error: string };

/** The editor's view of the daemon (src/main/daemon-client.ts). */
export interface DaemonView {
  connected: boolean;
  /** Why the editor is not connected, in words for the user; null when connected. */
  problem: string | null;
  status: StatusResult | null;
  /** Geometry of the connected decks. */
  decks: DecksResult | null;
}

export type DaemonResult = { ok: true } | { ok: false; code: string; error: string };

/** A KDE global shortcut a combo is bound to (scope §10). `component` is the display name ("KWin"). */
export interface SystemShortcut {
  component: string;
  componentId: string;
}

export interface EditorSnapshot {
  store: StoreView;
  daemon: DaemonView;
}

/** What the renderer reports back in the shared-import check (proof 0a). */
export interface SharedImportReport {
  parseCombo: number[];
  /** A value typed with StateSnapshot from the daemon's src/control/protocol.ts. */
  protocolTypeUsed: string;
  error?: string;
}

export interface DeckhandBridge {
  snapshot(): Promise<EditorSnapshot>;
  apply(edit: Edit): Promise<ApplyResult>;
  acknowledgeReformat(): Promise<void>;
  resolveConflict(choice: 'file' | 'mine'): Promise<void>;
  /** Try opening config.json again after it could not be opened. */
  reopenConfig(): Promise<StoreView>;
  /** Make a profile active on the decks (live switching, scope §10). */
  switchProfile(to: string): Promise<DaemonResult>;
  /** Show a page on a deck, saving any unsaved edits first so a new page exists for the daemon. */
  showPage(serial: string, page: string): Promise<DaemonResult>;
  /** The KDE global shortcut a combo is bound to, or null — including when KDE's service is not there (scope §10). */
  findSystemShortcut(combo: string): Promise<SystemShortcut | null>;
  previewSet(serial: string, key: number, button: ButtonDef): Promise<DaemonResult>;
  previewClear(serial: string, key?: number): Promise<DaemonResult>;
  /** Called on every store change; returns a function that stops the calls. */
  onStore(callback: (view: StoreView) => void): () => void;
  /** Called on every daemon view change; returns a function that stops the calls. */
  onDaemon(callback: (view: DaemonView) => void): () => void;

  /** Checks only (scripts/check-*.mjs): report a result to the main process, which prints it and quits. */
  reportCheck(name: string, report: unknown): void;
}
