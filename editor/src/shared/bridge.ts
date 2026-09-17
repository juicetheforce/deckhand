/**
 * The API the preload script exposes to the renderer as `window.deckhand`,
 * and the state it carries. Types only, importing nothing that touches Node:
 * shared by main (which produces the state), the preload (which implements
 * the API) and the renderer (which calls it). The renderer has no Node and no
 * direct access to Electron.
 */
import type { DecksResult, StatusResult } from '../../../src/control/protocol.js';
import type { ButtonDef, Config } from '../../../src/types.js';
import type { ApplyResult, ButtonLocation, Edit, IconChoice } from './edits.js';
import type { PairIconField } from './icons.js';

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

/**
 * At most this many bookmarked folders (scope §10). The maintainer expects to keep five
 * to eight, and the row scrolls, so the cap is a guard rather than a limit he
 * would meet.
 */
export const MAX_BOOKMARKS = 12;

/** A folder or image in the icon picker (src/main/icon-browser.ts). */
export interface IconFolderEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** As the config would store it: ~/... under the home directory. */
  configPath: string;
  /** Images only: the file's stamp, for the icon URL (src/main/icon-files.ts). */
  stamp?: string;
  /** Folders in a listing: how many folders and images it holds, for its tile (mockup 5a). */
  items?: number;
  /** Bookmarks only: the folder is no longer there. */
  missing?: boolean;
}

export interface IconFolderListing {
  path: string;
  configPath: string;
  /** null at the file system root. */
  parent: string | null;
  folders: IconFolderEntry[];
  images: IconFolderEntry[];
}

export interface IconSearchMatch extends IconFolderEntry {
  /** Where the match lives, relative to the searched folder; "" for the folder itself. */
  folder: string;
}

export type IconFolderResult = { ok: true; listing: IconFolderListing } | { ok: false; error: string };
export type IconSearchResult =
  | { ok: true; matches: IconSearchMatch[]; truncated: boolean }
  | { ok: false; error: string }
  /** A newer search replaced this one before it finished. */
  | { ok: false; superseded: true };

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

  /**
   * Which action-library sections are collapsed, by group name. Sections
   * default to expanded (the maintainer, 2026-09-16): collapsed-by-default would hide
   * capabilities from someone who does not know to look for them, which is the
   * §2 problem the library exists to solve — collapsing is a choice, never
   * inherited. Editor preferences, never config.json.
   */
  collapsedLibrary(): Promise<string[]>;
  setCollapsedLibrary(groups: string[]): Promise<void>;

  /** Bookmarked icon folders, in order; missing ones are kept and marked (src/main/preferences.ts). */
  bookmarks(): Promise<IconFolderEntry[]>;
  /** Bookmark a folder (ignored when the list is full or it is already there); returns the list. */
  addBookmark(folder: string): Promise<IconFolderEntry[]>;
  removeBookmark(folder: string): Promise<IconFolderEntry[]>;

  /**
   * Watch exactly these icon paths (as the config stores them) and return
   * their stamps now; onIconStamps reports later changes. The renderer puts a
   * stamp in the icon URL so a file changed on disk is fetched again.
   */
  watchIconFiles(configPaths: string[]): Promise<Record<string, string>>;
  onIconStamps(callback: (stamps: Record<string, string>) => void): () => void;

  /** The icon picker's opening folder: the current icon's folder, a recent one, Pictures, or home. */
  iconStartFolder(currentIcon: string | null): Promise<string>;
  /** List a folder, and watch it: onIconFolderChanged reports changes until another folder is listed or stopIconWatch. */
  listIconFolder(folder: string): Promise<IconFolderResult>;
  stopIconWatch(): Promise<void>;
  /** Images below a folder whose name contains the query. A newer call supersedes an unfinished one. */
  searchIcons(folder: string, query: string): Promise<IconSearchResult>;
  /** The system folder dialog; null if cancelled. */
  chooseIconFolder(current: string | null): Promise<string | null>;
  /**
   * Set a key's icon to one of its three states (scope §10) — or, with `slot`,
   * one icon of its action's state pair (C2) — save, and once the daemon has
   * reloaded, clear the preview on that key — so the key shows the saved icon
   * and responds to presses again. Remembers the icon's folder as recent.
   */
  commitIcon(at: ButtonLocation, icon: IconChoice, preview: { serial: string; key: number } | null, slot: PairIconField | null): Promise<ApplyResult>;
  onIconFolderChanged(callback: (folder: string) => void): () => void;
  /** Called on every store change; returns a function that stops the calls. */
  onStore(callback: (view: StoreView) => void): () => void;
  /** Called on every daemon view change; returns a function that stops the calls. */
  onDaemon(callback: (view: DaemonView) => void): () => void;

  /** Checks only (scripts/check-*.mjs): report a result to the main process, which prints it and quits. */
  reportCheck(name: string, report: unknown): void;
}
