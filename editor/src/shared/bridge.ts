/**
 * The API the preload script exposes to the renderer as `window.deckhand`,
 * and the state it carries. Types only, importing nothing that touches Node:
 * shared by main (which produces the state), the preload (which implements
 * the API) and the renderer (which calls it). The renderer has no Node and no
 * direct access to Electron.
 */
import type { ExportResult, ImportChoice, ImportResult, KeptConfigList } from './backup.js';
import type { AppSettings, DeckOption } from './settings.js';
import type { AppListing, AudioList, DecksResult, ObsAttempt, ObsList, ObsStatus, StatusResult, VtsList, VtsStatus } from '../../../src/control/protocol.js';
import type { ActionDef, ButtonDef, Config } from '../../../src/types.js';
import type { ApplyResult, ButtonLocation, Edit, IconChoice } from './edits.js';
import type { PairIconField } from './icons.js';
import type { DeckPositions } from './deck-positions.js';

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
  /**
   * The daemon's live device lists (`audio.sinks` / `audio.sources`, kept
   * current by the "audio" event), which the audio forms pick from — the
   * editor writes a node from here, never a match string, so the key keeps
   * pointing at the device the user chose. Absent
   * or null until the daemon has read its audio state.
   */
  audio?: { sinks: AudioList; sources: AudioList } | null;
  /**
   * The installed applications an app key can open (the daemon's `apps`),
   * each with its icon resolved — what the App form picks from and what the
   * grid draws on an app key with no icon. Read once per connection, and again
   * whenever the App form opens (refreshApps). Absent or null until read.
   */
  apps?: AppListing[] | null;
  /**
   * OBS: whether it is set up, and its connection (obs.status, kept current
   * by the "obs" event). Never a secret. What gates the library's OBS actions
   * and the not-set-up faces. Absent or null from a daemon without OBS.
   */
  obs?: ObsStatus | null;
  /**
   * VTube Studio: whether it is set up, its connection and model (vts.status,
   * kept current by the "vts" event). Never the token. Gates the library's
   * VTS actions and the not-set-up faces. Absent or null from a daemon
   * without VTube Studio.
   */
  vts?: VtsStatus | null;
}

/**
 * Settings' OBS form, as sent to the daemon: a field left out is the saved
 * one (Test) or unchanged (Save); a password of null or "" removes it.
 */
export interface ObsForm {
  host?: string;
  port?: number;
  password?: string | null;
}

/** Save's answer: the status, and how its one attempt to connect went. */
export type ObsSaveResult = { ok: true; status: ObsStatus; attempt: ObsAttempt } | { ok: false; error: string };

/** Where to open the settings window: its top, or one section. */
export type SettingsSection = 'obs';

export type DaemonResult = { ok: true } | { ok: false; code: string; error: string };

/** A KDE global shortcut a combo is bound to. `component` is the display name ("KWin"). */
export interface SystemShortcut {
  component: string;
  componentId: string;
}

/**
 * At most this many bookmarked folders. The row scrolls, so the cap is a
 * guard, not a limit anyone should meet.
 */
export const MAX_BOOKMARKS = 12;

/** At most this many remembered shown decks: a guard against a corrupt preferences file, not a limit. */
export const MAX_SHOWN_DECKS = 32;

/** A folder or image in the icon picker (src/main/icon-browser.ts). */
export interface IconFolderEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** As the config would store it: ~/... under the home directory. */
  configPath: string;
  /** Images only: the file's stamp, for the icon URL (src/main/icon-files.ts). */
  stamp?: string;
  /** Folders in a listing: how many folders and images it holds, for its tile. */
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

/** What the renderer reports back in the shared-import check. */
export interface SharedImportReport {
  parseCombo: number[];
  /** A value typed with StateSnapshot from the daemon's src/control/protocol.ts. */
  protocolTypeUsed: string;
  error?: string;
}

/** What a title bar button asks of its window. Maximise is a toggle: it restores a maximised window. */
export type WindowAction = 'minimise' | 'maximise' | 'close';

/** What the title bar draws from: restore or maximise, and dimmed while another window is active. */
export interface WindowState {
  maximised: boolean;
  focused: boolean;
}

/** The config is kept as `backup` (a ~/ path) before the profile goes. */
export type DeleteProfileResult = { ok: true; backup: string | null } | { ok: false; error: string };

export interface DeckhandBridge {
  snapshot(): Promise<EditorSnapshot>;
  apply(edit: Edit): Promise<ApplyResult>;
  acknowledgeReformat(): Promise<void>;
  resolveConflict(choice: 'file' | 'mine'): Promise<void>;
  /** Try opening config.json again after it could not be opened. */
  reopenConfig(): Promise<StoreView>;
  /** Make a profile active on the decks. */
  switchProfile(to: string): Promise<DaemonResult>;
  /** Show a page on a deck, saving any unsaved edits first so a new page exists for the daemon. */
  showPage(serial: string, page: string): Promise<DaemonResult>;
  /** Clear a key's failure badge, on the deck and here: the inspector's Clear. */
  clearFailure(at: ButtonLocation): Promise<DaemonResult>;
  /** The KDE global shortcut a combo is bound to, or null — including when KDE's service is not there. */
  findSystemShortcut(combo: string): Promise<SystemShortcut | null>;
  previewSet(serial: string, key: number, button: ButtonDef): Promise<DaemonResult>;
  previewClear(serial: string, key?: number): Promise<DaemonResult>;
  /**
   * Multi action's Test Run: run the action on a deck now — but
   * refused, code "focused", while the editor's window has focus, so a test
   * never types into the editor itself.
   */
  testRun(serial: string, action: ActionDef): Promise<DaemonResult>;
  /**
   * What an OBS key's picker offers, asked of OBS now (editor window only):
   * scenes, audio inputs, or one scene's sources. OBS not reachable is an
   * answer — the picker says "Start OBS to choose".
   */
  obsList(kind: 'scenes' | 'inputs' | 'sources', scene?: string): Promise<ObsList>;
  /**
   * What a VTube Studio key's picker offers, asked of VTS now (editor window
   * only): its models, or one model's hotkeys, by ID. VTS not reachable is an
   * answer — the picker says "Start VTube Studio to choose".
   */
  vtsList(kind: 'models' | 'hotkeys', model?: string): Promise<VtsList>;
  /** Ask the daemon for its app list again; the answer arrives as the daemon view's `apps`. */
  refreshApps(): Promise<void>;

  /**
   * Which action-library sections are collapsed, by group name. Sections
   * default to expanded: collapsed by default would hide capabilities from
   * someone who does not know to look for them, which is the problem the
   * library exists to solve. Collapsing is a choice, never inherited. Editor preferences, never config.json.
   */
  collapsedLibrary(): Promise<string[]>;
  setCollapsedLibrary(groups: string[]): Promise<void>;

  /**
   * The decks shown in the editor, by serial, as last chosen in SHOW IN
   * EDITOR. Global, not per profile; editor preferences, never config.json.
   */
  shownDecks(): Promise<string[]>;
  setShownDecks(serials: string[]): Promise<void>;

  /**
   * Where each deck sits on the canvas, by serial, in key units
   * (shared/deck-positions). Global, not per profile; editor preferences,
   * never config.json. Set when a drag ends: every shown deck as drawn,
   * merged over the stored ones, so a deck never dragged stays where it was
   * seen.
   */
  deckPositions(): Promise<DeckPositions>;
  setDeckPositions(positions: DeckPositions): Promise<void>;
  /** The decks locked in place on the canvas, by serial: their headers start no drag. Global; never config.json. */
  lockedDecks(): Promise<string[]>;
  setLockedDecks(serials: string[]): Promise<void>;

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

  /** The icon picker's opening folder: the current icon's folder, a bookmark, Pictures, or home. */
  iconStartFolder(currentIcon: string | null): Promise<string>;
  /** List a folder, and watch it: onIconFolderChanged reports changes until another folder is listed or stopIconWatch. */
  listIconFolder(folder: string): Promise<IconFolderResult>;
  stopIconWatch(): Promise<void>;
  /** Images below a folder whose name contains the query. A newer call supersedes an unfinished one. */
  searchIcons(folder: string, query: string): Promise<IconSearchResult>;
  /**
   * Set a key's icon to one of its three states — or, with `slot`,
   * one icon of its action's state pair — save, and once the daemon has
   * reloaded, clear the preview on that key — so the key shows the saved icon
   * and responds to presses again.
   */
  commitIcon(at: ButtonLocation, icon: IconChoice, preview: { serial: string; key: number } | null, slot: PairIconField | null): Promise<ApplyResult>;
  onIconFolderChanged(callback: (folder: string) => void): () => void;
  /**
   * App settings, in the editor's preferences file. Both
   * windows can read them; only the settings window changes them, and every
   * change reaches both windows through onAppSettings.
   */
  appSettings(): Promise<AppSettings>;
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetAppSettings(): Promise<AppSettings>;
  /** The decks the Default deck setting offers (settings window only). */
  settingsDecks(): Promise<DeckOption[]>;
  /**
   * Whether the daemon shows a desktop notification when a key needs the
   * person to do something — kept in config.json (the daemon reads it), not
   * with the app settings. Null when config.json is not open (settings window
   * only).
   */
  notifications(): Promise<boolean | null>;
  /** The installed version (the app directory's VERSION), or null in a checkout. Settings window only. */
  appVersion(): Promise<string | null>;
  /** Open the GitHub releases page in the browser. Settings window only; the URL is fixed in the main process. */
  openReleases(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Turn them on or off; resolves with the setting as it now is. */
  setNotifications(on: boolean): Promise<boolean | null>;
  /**
   * Export the whole configuration as a .zip (settings window
   * only): with every icon file it names, or config only. Asks where to save.
   */
  exportConfig(includeIcons: boolean): Promise<ExportResult>;
  /**
   * Delete a profile, keeping a copy of config.json first: a delete can take
   * a deck's worth of keys with it, and the rolling backups can be up to 5
   * minutes old. The copy is `before-delete-<time>.json`, which the rolling
   * rotation never deletes; restore it from Settings. What it will change is
   * planProfileDeletion() (src/shared/profile-deletion.ts) — the same code
   * the delete itself runs.
   */
  deleteProfile(profile: string, pageName: string): Promise<DeleteProfileResult>;
  /** The configurations kept before an import or a profile delete, newest first. */
  keptConfigs(): Promise<KeptConfigList>;
  /** Restore one: planned like any import, so the same review shows and the replaced config is kept. */
  restoreKeptConfig(file: string): Promise<ImportChoice>;
  /** Delete one. The only thing that removes a kept configuration. */
  deleteKeptConfig(file: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Choose an export or a config file and plan its import (settings window
   * only). Writes nothing: the review says what would happen.
   */
  chooseImport(): Promise<ImportChoice>;
  /** Carry out the import the review with this id described. */
  confirmImport(id: string): Promise<ImportResult>;
  cancelImport(id: string): Promise<void>;
  /** Open the settings window, or bring it forward (editor window only) — at a section, if given. */
  openSettings(section?: SettingsSection): Promise<void>;
  /** The settings window: called when it is asked to show a section (it is already open). */
  onSettingsSection(callback: (section: SettingsSection) => void): () => void;
  /** OBS's status, for the settings window; null with no daemon, or one without OBS. */
  obsStatus(): Promise<ObsStatus | null>;
  /** Called when OBS's status changes (settings window). */
  onObsStatus(callback: (status: ObsStatus | null) => void): () => void;
  /** Test connection with the form's values; changes nothing (settings window only). */
  obsTest(values: ObsForm): Promise<ObsAttempt | { ok: false; reason: 'daemon'; message: string }>;
  /** Save the form: sets OBS up, and tries once (settings window only). */
  obsSave(values: ObsForm): Promise<ObsSaveResult>;
  /** Remove OBS's saved connection; keys untouched (settings window only). */
  obsRemove(): Promise<{ ok: true; status: ObsStatus } | { ok: false; error: string }>;
  /** Close the settings window: its Done button (settings window only). */
  closeSettings(): Promise<void>;
  onAppSettings(callback: (settings: AppSettings) => void): () => void;

  /**
   * The window's own title bar: both windows are frameless, so
   * the page asks the main process to minimise, maximise or close the window
   * it is in. The settings window may only close.
   */
  windowControl(action: WindowAction): Promise<void>;
  /** Read once when the bar mounts: a reload is not a maximise or focus event. */
  windowState(): Promise<WindowState>;
  /** Called when the window is maximised or restored, focused or left. */
  onWindowState(callback: (state: WindowState) => void): () => void;

  /** Called on every store change; returns a function that stops the calls. */
  onStore(callback: (view: StoreView) => void): () => void;
  /** Called on every daemon view change; returns a function that stops the calls. */
  onDaemon(callback: (view: DaemonView) => void): () => void;

  /** Checks only (scripts/check-*.mjs): report a result to the main process, which prints it and quits. */
  reportCheck(name: string, report: unknown): void;
}
