import { randomBytes } from 'node:crypto';
import { promises as fs, appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, type IpcMainInvokeEvent } from 'electron';
// The daemon's own modules, imported rather than copied (docs/scope.md §7, M4
// phase A proof 0a). Only modules with no dependencies beyond Node built-ins
// may be imported for their values; anything else is `import type` only.
import { BACKUP_DIR, STATE_DIR } from '../../../src/backups.js';
import { CONFIG_PATH, expandPath, loadConfig } from '../../../src/config.js';
import { socketPath } from '../../../src/control/server.js';
import { parseCombo } from '../../../src/keymap.js';
import type { ActionDef, ButtonDef } from '../../../src/types.js';
import type { DaemonResult, DeleteProfileResult, EditorSnapshot, IconFolderResult, IconSearchResult, StoreView, WindowState } from '../shared/bridge.js';
import { IMPORT_LIMITS, MAX_KEPT_CONFIGS, type ExportResult, type ImportChoice, type ImportResult, type KeptConfigList } from '../shared/backup.js';
import { deleteProfileKeepingACopy } from './profile-delete.js';
import { deleteKeptConfig, keepConfigCopy, keptConfigPath, listKeptConfigs } from './kept-configs.js';
import type { ApplyResult, ButtonLocation, Edit, IconChoice } from '../shared/edits.js';
import { BUILTIN_FOLDER, BUILTIN_PREFIX, iconUrl, type PairIconField } from '../shared/icons.js';
import { cleanSettingsPatch, deckOptions, DEFAULT_SETTINGS, readSettings, type AppSettings, type DeckOption } from '../shared/settings.js';
import { ConfigStore } from './config-store.js';
import { DaemonClient, DaemonError } from './daemon-client.js';
import { buildExport, suggestedExportName, writeExport } from './export-bundle.js';
import { planImport, readImport, writePlannedIcons, type ImportPlan } from './import-bundle.js';
import { existingFolders, FolderWatcher, listBuiltinFolder, listFolder, searchBuiltins, searchFolder, startFolder } from './icon-browser.js';
import { IconFiles } from './icon-files.js';
import { Launcher } from './launcher.js';
import { createTray, deadTray, type LauncherTray } from './tray.js';
import { Bookmarks, Preferences } from './preferences.js';
import { handleIconScheme, registerIconScheme } from './icon-protocol.js';
import { findSystemShortcut } from './system-shortcuts.js';

// Electron's state (cache, local storage, lock files) goes in the state
// directory, never the default ~/.config/<app name>: that would sit next to
// config.json, in a directory that may be synced. Uninstall already removes
// the state directory. Must be set before the app is ready. (docs/scope.md §0)
app.setPath('userData', path.join(STATE_DIR, 'editor'));

registerIconScheme(); // before the app is ready

/**
 * Check modes, used only by scripts/check-*.mjs and scripts/screenshot.mjs:
 * "shared" (proof 0a), "bridge" (step 2), "screenshot" (step 3). The renderer
 * runs the check and reports with reportCheck(); main prints one line and
 * quits.
 */
const CHECK = process.env.DECKHAND_EDITOR_CHECK ?? null;
// Offscreen frames came back 0×0 with GPU rendering (2026-09-15).
if (CHECK === 'screenshot') app.disableHardwareAcceleration();

/**
 * One editor at a time (Ship piece 2): launching it again while it is open or
 * in the tray brings that one forward ('second-instance', below) rather than
 * starting another. The lock is per userData directory, so the checks — each
 * with its own scratch state directory — never meet the maintainer's editor. The other
 * check modes run without it, as they always have.
 */
const USES_LAUNCHER = CHECK === null || CHECK === 'tray';
const IS_PRIMARY = !USES_LAUNCHER || app.requestSingleInstanceLock();
if (!IS_PRIMARY) app.quit();

// No application menu: Electron's default one binds Ctrl+W, Ctrl+R, Ctrl+Q
// and more, which would fire while the hotkey inspector is listening. With
// it removed those combos reach the page and can be captured (scope §10, 0b).
Menu.setApplicationMenu(null);

/**
 * Which build of the editor this process started from (M5, the maintainer 2026-09-19).
 * `scripts/install.sh update` swaps the app directory while an editor can sit
 * in the tray, so a page loaded later comes from the new build and talks to
 * this old main process — which once made profile rename silently do nothing.
 * The renderer's index.html names its bundles by content hash, so its text
 * changes whenever the page does. Read once now, and again before any page is
 * loaded; if it differs, the editor restarts from what is on disk.
 *
 * Checks may point this at a file of their own (DECKHAND_CHECK_INSTALL_STAMP),
 * to stand in for an install without touching the build.
 */
const INSTALL_STAMP =
  CHECK !== null && process.env.DECKHAND_CHECK_INSTALL_STAMP
    ? process.env.DECKHAND_CHECK_INSTALL_STAMP
    : path.join(import.meta.dirname, '../renderer/index.html');

function readInstallStamp(): string | null {
  try {
    return readFileSync(INSTALL_STAMP, 'utf8');
  } catch {
    return null;
  }
}

const startedFrom = readInstallStamp();

/**
 * Whether the editor on disk has changed since this process started. Unreadable
 * (mid-install, say) is not "changed": restarting then would start nothing.
 */
function installChanged(): boolean {
  if (startedFrom === null) return false;
  const now = readInstallStamp();
  return now !== null && now !== startedFrom;
}

/** Quit, writing unsaved edits (before-quit), and start again from what is on disk. */
function restartForNewInstall(): void {
  console.log('[editor] the installed editor changed since it started; restarting');
  app.relaunch();
  app.quit();
}

let window: BrowserWindow | null = null;
/** The settings window (Ship piece 3): a child of `window`, one at a time, closed with it. */
let settingsWindow: BrowserWindow | null = null;
/** Screenshot check only: the most recent offscreen frame. */
let lastFrame: Electron.NativeImage | null = null;
let store: ConfigStore | null = null;
let storeError: string | null = null;

const daemon = new DaemonClient({
  socketPath: socketPath(),
  onChange: (view) => window?.webContents.send('daemon', view),
});

function storeView(): StoreView {
  return store ? { open: true, state: store.state() } : { open: false, error: storeError ?? 'config.json is not open' };
}

async function openStore(): Promise<StoreView> {
  store?.close();
  store = null;
  try {
    store = await ConfigStore.open({
      configPath: CONFIG_PATH,
      onChange: () => window?.webContents.send('store', storeView()),
    });
    storeError = null;
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
  }
  return storeView();
}

async function daemonCall(call: () => Promise<void>): Promise<DaemonResult> {
  try {
    await call();
    return { ok: true };
  } catch (err) {
    if (err instanceof DaemonError) return { ok: false, code: err.code, error: err.message };
    return { ok: false, code: 'internal', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Show a page on a deck (scope §10, live switching). The page may exist only
 * in edits not yet saved — a page just added — so save first, and if that
 * wrote the file, wait for the daemon to report the reload.
 *
 * Success is read from the deck's state, not from the reply: a page action
 * for a page the deck does not have yet logs and returns without an error
 * (`DeckSession.goToPage`), so action.run answers ok while nothing moved.
 * Until Ship (2026-09-18) the daemon reported a reload before applying it to
 * the decks, so a page just saved could be missing; it now reports after
 * (src/index.ts reload()). The retry is kept for a daemon from before that,
 * and costs nothing when the page is there: after a save, a page that has not
 * appeared is asked for again, for about a second.
 */
async function showPage(serial: string, page: string): Promise<DaemonResult> {
  const before = daemon.lastReloadAt();
  const wrote = (await store?.flush()) ?? false;
  if (wrote) {
    const reload = await daemon.waitForReloadAfter(before, 5000);
    if (reload === null) return { ok: false, code: 'timeout', error: 'the daemon did not pick up the saved config within 5 s' };
    if (!reload.ok) return { ok: false, code: 'config_refused', error: `the daemon refused the saved config: ${reload.error}` };
  }
  const shows = () => daemon.view().status?.decks.some((d) => d.serial === serial && d.page === page) ?? false;
  const ATTEMPTS = wrote ? 10 : 1;
  for (let attempt = 1; ; attempt++) {
    const result = await daemonCall(() => daemon.showPage(serial, page));
    if (!result.ok) return result;
    const started = Date.now();
    while (!shows() && Date.now() - started < 500) await new Promise((resolve) => setTimeout(resolve, 20));
    if (shows()) return result;
    if (attempt >= ATTEMPTS) return { ok: false, code: 'not_shown', error: `the deck did not switch to page "${page}"` };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Make a profile active (scope §10, live switching). Mirrors showPage, and for
 * the same reason: the profile may exist only in edits not yet saved — one
 * just created — so save first, and wait for the daemon to report the reload.
 *
 * Retried like showPage, because announcing a reload is not the same as having
 * applied it: src/index.ts reload() fires its config event *before*
 * profiles.applyReload(), and Profiles keeps its own copy of the config, so a
 * switch sent on the announcement can still be answered "not_found".
 */
async function switchProfile(to: string): Promise<DaemonResult> {
  const before = daemon.lastReloadAt();
  const wrote = (await store?.flush()) ?? false;
  if (wrote) {
    const reload = await daemon.waitForReloadAfter(before, 5000);
    if (reload === null) return { ok: false, code: 'timeout', error: 'the daemon did not pick up the saved config within 5 s' };
    if (!reload.ok) return { ok: false, code: 'config_refused', error: `the daemon refused the saved config: ${reload.error}` };
  }
  const ATTEMPTS = wrote ? 10 : 1;
  for (let attempt = 1; ; attempt++) {
    const result = await daemonCall(() => daemon.switchProfile(to).then(() => undefined));
    if (result.ok || attempt >= ATTEMPTS || result.code !== 'not_found') return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Multi action's Test Run (scope §10: it arms rather than fires). The renderer
 * counts down while the user clicks into the window the keys should reach;
 * this refuses if the editor still has focus when the count ends, so a test
 * never types into the editor. Electron knows its own focus — nothing
 * compositor-specific.
 */
async function testRun(serial: string, action: ActionDef): Promise<DaemonResult> {
  if (window?.isFocused()) {
    return { ok: false, code: 'focused', error: 'the editor still had focus, so nothing was sent' };
  }
  return daemonCall(() => daemon.runAction(serial, action));
}

// --- Icon picker (scope §10) -------------------------------------------------

// The editor's own preferences (scope §10), in Electron's userData — never
// beside config.json, which belongs to the daemon.
const preferences = new Preferences(path.join(app.getPath('userData'), 'preferences.json'));
const bookmarks = new Bookmarks(preferences, path.join(app.getPath('userData'), 'icon-picker.json'));
const folderWatcher = new FolderWatcher((folder) => window?.webContents.send('iconFolderChanged', folder));
const iconFiles = new IconFiles((stamps) => window?.webContents.send('iconStamps', stamps));
/** Bumped by every search; a walk still running for an older number stops. */
let searchGeneration = 0;

async function listIconFolder(folder: string): Promise<IconFolderResult> {
  // The pinned Built-in section: listed from the checkout, nothing to watch.
  if (folder === BUILTIN_FOLDER) {
    folderWatcher.close();
    return { ok: true, listing: await listBuiltinFolder() };
  }
  try {
    const listing = await listFolder(folder, os.homedir());
    folderWatcher.watch(folder);
    return { ok: true, listing };
  } catch (err) {
    folderWatcher.close();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchIcons(folder: string, query: string): Promise<IconSearchResult> {
  const mine = ++searchGeneration;
  if (folder === BUILTIN_FOLDER) return { ok: true, matches: await searchBuiltins(query), truncated: false };
  try {
    const outcome = await searchFolder(folder, query, os.homedir(), () => mine === searchGeneration);
    if (outcome.cancelled || mine !== searchGeneration) return { ok: false, superseded: true };
    return { ok: true, matches: outcome.matches, truncated: outcome.truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Choosing (or removing) an icon. The preview on the key is cleared only
 * after the daemon has reloaded the saved file, so the key goes straight from
 * the preview to the saved icon — and presses work again, since a previewed
 * key is inert (scope §7, M3 decision 3). `[confirmed]` 2026-09-15 by reading
 * src/index.ts, src/profiles.ts and src/deck.ts: reload() fires its config
 * event before applyReload() runs, and applyReload awaits each deck in turn,
 * so a key on a second deck can show its old icon until the first deck's full
 * repaint has finished. Ordering confirmed; duration not measured.
 */
async function commitIcon(
  at: ButtonLocation,
  icon: IconChoice,
  preview: { serial: string; key: number } | null,
  slot: PairIconField | null,
): Promise<ApplyResult> {
  if (!store) return { ok: false, error: storeError ?? 'config.json is not open' };
  const result = store.apply(slot === null ? { kind: 'setIcon', at, icon } : { kind: 'setActionIcon', at, field: slot, icon });
  if (!result.ok) return result;
  const before = daemon.lastReloadAt();
  const wrote = await store.flush();
  if (wrote && daemon.view().connected) await daemon.waitForReloadAfter(before, 5000);
  if (preview) await daemonCall(() => daemon.previewClear(preview.serial, preview.key));
  return result;
}

/** Every pair icon field (src/shared/icons.ts), for checking what the renderer sends. */
const PAIR_ICON_FIELDS: readonly unknown[] = ['iconMuted', 'iconUnmuted', 'iconPlaying', 'iconPaused'] satisfies PairIconField[];

function isIconChoice(value: unknown): value is IconChoice {
  const v = value as IconChoice;
  if (typeof v !== 'object' || v === null) return false;
  if (v.kind === 'none' || v.kind === 'default') return true;
  return v.kind === 'file' && typeof v.path === 'string' && v.path !== '';
}

function isLocation(value: unknown): value is ButtonLocation {
  const v = value as ButtonLocation;
  return typeof v === 'object' && v !== null && typeof v.profile === 'string' && typeof v.serial === 'string' && typeof v.page === 'string' && Number.isInteger(v.index);
}

/** Only this window's own page may call in. */
function fromOurWindow(event: IpcMainInvokeEvent): boolean {
  return window !== null && event.sender === window.webContents;
}

/**
 * The settings window loads the same preload, so it could call anything the
 * editor can; every editor call answers only the editor's window
 * (fromOurWindow), and the settings window gets the few below that it needs.
 */
function fromSettingsWindow(event: IpcMainInvokeEvent): boolean {
  return settingsWindow !== null && event.sender === settingsWindow.webContents;
}

/** The window a title bar call came from: the editor's or the settings window, nothing else. */
function callingWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (fromOurWindow(event)) return window;
  if (fromSettingsWindow(event)) return settingsWindow;
  return null;
}

function windowState(w: BrowserWindow): WindowState {
  // A screenshot window is hidden and so never focused: it is drawn focused
  // unless the screenshot asks for the other look (screenshot.mjs --unfocused).
  const screenshotFocus = CHECK === 'screenshot' && !process.env.DECKHAND_EDITOR_UNFOCUSED;
  return { maximised: w.isMaximized(), focused: w.isFocused() || screenshotFocus };
}

/**
 * Keep a frameless window's title bar in step with it (Ship piece 4). The page
 * cannot see whether its window is maximised, so it is told, to draw restore
 * rather than maximise; and it is told about focus because nothing outside the
 * application dims an inactive window — KDE's own applications do it
 * themselves, through Qt's inactive palette, and a window drawing its own bar
 * takes that on (Fleuron, reportFocus). The page also reads the state once when
 * it mounts (windowState), because a reload is none of these events.
 */
function reportWindowState(w: BrowserWindow): void {
  const send = () => {
    if (!w.isDestroyed()) w.webContents.send('windowState', windowState(w));
  };
  w.on('maximize', send);
  w.on('unmaximize', send);
  w.on('focus', send);
  w.on('blur', send);
}

async function appSettings(): Promise<AppSettings> {
  return readSettings(await preferences.read());
}

/** Tell both windows the settings changed, so each applies them at once ("Settings apply immediately", 6a). */
async function broadcastSettings(): Promise<void> {
  const settings = await appSettings();
  for (const w of [window, settingsWindow]) if (w && !w.isDestroyed()) w.webContents.send('appSettings', settings);
}

function openSettings(): void {
  if (!window) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  // A new page, so the same rule as a new editor window (installChanged):
  // an editor left open across an install restarts rather than load the new
  // settings page against this main process.
  if (installChanged()) {
    restartForNewInstall();
    return;
  }
  settingsWindow = new BrowserWindow({
    // A child of the editor's window, but on Wayland that does not keep it
    // above: KWin puts it behind the editor like any other window (measured
    // 2026-09-18, framed or not), and alwaysOnTop is unsupported on Wayland.
    // So clicking into the editor closes it instead (closeSettingsOnFocus).
    parent: window,
    // 6a's layout, with nothing below the footer: its 32 px title bar
    // (TitleBar.tsx) and 384 px of settings — plus 224 px for BACKUP (M5),
    // which 6a does not have: export and import, with room for two lines of
    // result. An import's review is longer than that; the window scrolls.
    // Frameless, so the content is the window.
    width: 640,
    height: SETTINGS_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // Its own bar, with a close button only (Ship piece 4; createWindow says why frameless).
    frame: false,
    title: 'Deckhand Settings',
    backgroundColor: '#0e1020',
    show: CHECK === null,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The window's own title, not the page's, which would otherwise replace it.
  settingsWindow.on('page-title-updated', (event) => event.preventDefault());
  // Only if it is still the one: closeSettingsOnFocus lets go of a window
  // before it has finished closing, and a new one may be open by then.
  const created = settingsWindow;
  settingsLeft = false;
  created.on('focus', () => (settingsLeft = false));
  created.on('blur', () => (settingsLeft = true));
  created.on('closed', () => {
    if (settingsWindow === created) settingsWindow = null;
  });
  reportWindowState(created);
  void settingsWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), { query: { view: 'settings' } });
}

/**
 * Whether the settings window has lost focus since it last had it. Clicking
 * into the editor blurs the settings window and then focuses the editor, 1 ms
 * apart (measured 2026-09-18); a focus on the editor without that blur first is
 * not a click away from Settings, and is ignored. Such focus events do arrive:
 * one closed a settings window moments after it opened, in the title bar check.
 */
let settingsLeft = false;

/**
 * Going back to the editor closes the settings window (the maintainer, 2026-09-18). It
 * cannot stay above the editor on Wayland (openSettings), and left to go
 * behind it, it looked closed anyway. Nothing is lost: every setting is saved
 * the moment it changes.
 *
 * The reference is dropped before the window has closed, so a click on the
 * gear — which focuses the editor first — opens a new one rather than
 * bringing forward the one that is closing.
 */
function closeSettingsOnFocus(): void {
  const closing = settingsWindow;
  if (!closing || closing.isDestroyed() || closing === window || !settingsLeft) return;
  settingsWindow = null;
  closing.close();
}

/** The settings window's height (openSettings). */
const SETTINGS_HEIGHT = 780;

/** The home directory as `~`, for showing a path. */
function tildePath(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

/**
 * Export the configuration as it is on disk (M5 piece 1, docs/scope.md §5):
 * unsaved edits are saved first; any that cannot be (a conflict, a reformat
 * not yet allowed) are left out, and the result says so. The destination is
 * the system save dialog's — or, for checks only, DECKHAND_CHECK_EXPORT_PATH.
 */
async function exportConfig(includeIcons: boolean): Promise<ExportResult> {
  await store?.flush();
  const unsavedLeftOut = store?.state().dirty ?? false;
  let text: string;
  try {
    text = await fs.readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read config.json: ${(err as Error).message}` };
  }

  let destination: string;
  const checkPath = CHECK === null ? undefined : process.env.DECKHAND_CHECK_EXPORT_PATH;
  if (checkPath) {
    destination = checkPath;
  } else {
    const parent = settingsWindow ?? window;
    const options = {
      title: 'Export Deckhand configuration',
      defaultPath: path.join(os.homedir(), suggestedExportName(includeIcons)),
      filters: [{ name: 'Deckhand export', extensions: ['zip'] }],
    };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    // A name typed without an extension gets one; any other extension is kept as typed.
    destination = path.extname(picked.filePath) === '' ? `${picked.filePath}.zip` : picked.filePath;
  }

  try {
    const { zip, manifest, iconFiles } = await buildExport(text, includeIcons);
    await writeExport(destination, zip);
    return { ok: true, path: tildePath(destination), includesIcons: includeIcons, iconFiles, bytes: zip.length, missing: manifest.missing, unsavedLeftOut };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * The import waiting for confirmation (M5 piece 2): chosen and planned, not
 * yet written. The plan stays here; the settings window sees only its review
 * and id, so a page can never hand main a list of places to write.
 */
let pendingImport: { id: string; plan: ImportPlan } | null = null;

/**
 * Choose a file and plan its import, writing nothing (docs/scope.md §5). The
 * file is the system open dialog's — or, for checks only,
 * DECKHAND_CHECK_IMPORT_PATH.
 */
async function chooseImport(): Promise<ImportChoice> {
  pendingImport = null;
  let source: string;
  const checkPath = CHECK === null ? undefined : process.env.DECKHAND_CHECK_IMPORT_PATH;
  if (checkPath) {
    source = checkPath;
  } else {
    const parent = settingsWindow ?? window;
    const options = {
      title: 'Import Deckhand configuration',
      defaultPath: os.homedir(),
      properties: ['openFile' as const],
      filters: [{ name: 'Deckhand export or config file', extensions: ['zip', 'json'] }],
    };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    source = picked.filePaths[0];
  }

  return planImportOf(source);
}

/** Read and plan one file, and hold the plan for confirmImport: the review writes nothing. */
async function planImportOf(source: string): Promise<ImportChoice> {
  pendingImport = null;
  let plan: ImportPlan;
  try {
    const { size } = await fs.stat(source);
    if (size > IMPORT_LIMITS.totalBytes) throw new Error(`it is larger than ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB`);
    plan = await planImport(readImport(new Uint8Array(await fs.readFile(source))));
  } catch (err) {
    return { ok: false, error: `${path.basename(source)} cannot be imported: ${(err as Error).message}` };
  }
  const id = randomBytes(8).toString('hex');
  pendingImport = { id, plan };
  const connected = new Set((daemon.view().decks ?? []).map((d) => d.serial));
  const state = store?.state();
  return {
    ok: true,
    review: {
      id,
      kind: plan.kind,
      source: tildePath(source),
      exportedAt: plan.exportedAt,
      exportedHome: plan.exportedHome,
      includesIcons: plan.includesIcons,
      profiles: plan.profiles,
      decks: plan.decks.map((d) => ({ ...d, connected: connected.has(d.serial) })),
      icons: plan.icons,
      builtinsMissing: plan.builtinsMissing,
      oldHomeElsewhere: plan.oldHomeElsewhere,
      unsavedDiscarded: Boolean(state && (state.dirty || state.conflict)),
      backupFolder: tildePath(BACKUP_DIR),
    },
  };
}

/**
 * The configurations kept before an import or a profile delete (M5 piece 2d).
 * Read for the list in Settings, so choosing one never means opening files.
 */
async function keptConfigs(): Promise<KeptConfigList> {
  return { entries: await listKeptConfigs(BACKUP_DIR), max: MAX_KEPT_CONFIGS, folder: tildePath(BACKUP_DIR) };
}

/**
 * Restore a kept configuration: planned as any other import, so it goes
 * through the same review and keeps the configuration it replaces. Restoring
 * is destructive too, and its undo is the copy that restoring makes (the maintainer,
 * 2026-09-19).
 */
async function planKeptRestore(file: string): Promise<ImportChoice> {
  try {
    return await planImportOf(keptConfigPath(BACKUP_DIR, file));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Carry out the reviewed import: icons first, into empty places only; then
 * the store keeps the replaced config.json as backups/before-import-<time>.json
 * — a name the rolling backups never delete — and writes the new one. If
 * keeping it fails, config.json is not touched.
 */
async function confirmImport(id: string): Promise<ImportResult> {
  const pending = pendingImport;
  if (!pending || pending.id !== id) return { ok: false, error: 'this import is no longer waiting; choose the file again' };
  pendingImport = null;
  if (!store) return { ok: false, error: storeError ?? 'config.json is not open' };
  try {
    const { written, appeared } = await writePlannedIcons(pending.plan.writes);
    let backup: string | null = null;
    const before = daemon.lastReloadAt();
    await store.replace(pending.plan.config, async (replacedText) => {
      if (replacedText === null) return;
      // Throws at the cap, and store.replace then leaves config.json alone.
      const kept = await keepConfigCopy(BACKUP_DIR, replacedText, 'import');
      backup = tildePath(keptConfigPath(BACKUP_DIR, kept.file));
    });
    if (daemon.view().connected) await daemon.waitForReloadAfter(before, 5000);
    return { ok: true, written: written.length, appeared: appeared.map(tildePath), backup };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function registerIpc(): void {
  // --- App settings (Ship piece 3) ---
  ipcMain.handle('appSettings', (event) => (fromOurWindow(event) || fromSettingsWindow(event) ? appSettings() : DEFAULT_SETTINGS));
  ipcMain.handle('setAppSettings', async (event, patch: unknown) => {
    if (!fromSettingsWindow(event)) return appSettings();
    await preferences.set(cleanSettingsPatch(patch));
    await broadcastSettings();
    return appSettings();
  });
  ipcMain.handle('resetAppSettings', async (event) => {
    if (!fromSettingsWindow(event)) return appSettings();
    await preferences.set({ ...DEFAULT_SETTINGS });
    await broadcastSettings();
    return appSettings();
  });
  ipcMain.handle('settingsDecks', async (event): Promise<DeckOption[]> => {
    if (!fromSettingsWindow(event)) return [];
    return deckOptions(store?.state().config ?? null, daemon.view().decks, (await appSettings()).defaultDeck);
  });
  // --- Export (M5 piece 1) ---
  ipcMain.handle('exportConfig', async (event, includeIcons: unknown): Promise<ExportResult> => {
    if (!fromSettingsWindow(event) || typeof includeIcons !== 'boolean') return { ok: false, error: 'not allowed' };
    return exportConfig(includeIcons);
  });
  // --- Import (M5 piece 2) ---
  ipcMain.handle('deleteProfile', async (event, profile: string, pageName: string): Promise<DeleteProfileResult> =>
    fromOurWindow(event)
      ? deleteProfileKeepingACopy(
          { store, storeError, backupDir: BACKUP_DIR, configPath: CONFIG_PATH, keptPath: (file) => keptConfigPath(BACKUP_DIR, file), tildePath },
          profile,
          pageName,
        )
      : { ok: false, error: 'not allowed' },
  );
  ipcMain.handle('keptConfigs', async (event): Promise<KeptConfigList> =>
    fromSettingsWindow(event) ? keptConfigs() : { entries: [], max: MAX_KEPT_CONFIGS, folder: '' },
  );
  ipcMain.handle('restoreKeptConfig', async (event, file: string): Promise<ImportChoice> =>
    fromSettingsWindow(event) ? planKeptRestore(file) : { ok: false, error: 'not allowed' },
  );
  ipcMain.handle('deleteKeptConfig', async (event, file: string): Promise<{ ok: boolean; error?: string }> => {
    if (!fromSettingsWindow(event)) return { ok: false, error: 'not allowed' };
    try {
      await deleteKeptConfig(BACKUP_DIR, file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('chooseImport', async (event): Promise<ImportChoice> => (fromSettingsWindow(event) ? chooseImport() : { ok: false, error: 'not allowed' }));
  ipcMain.handle('confirmImport', async (event, id: unknown): Promise<ImportResult> =>
    fromSettingsWindow(event) && typeof id === 'string' ? confirmImport(id) : { ok: false, error: 'not allowed' },
  );
  ipcMain.handle('cancelImport', (event, id: unknown) => {
    if (fromSettingsWindow(event) && pendingImport?.id === id) pendingImport = null;
  });
  ipcMain.handle('openSettings', (event) => {
    if (fromOurWindow(event)) openSettings();
  });
  ipcMain.handle('closeSettings', (event) => {
    if (fromSettingsWindow(event)) settingsWindow?.close();
  });
  // --- The title bar (Ship piece 4) ---
  ipcMain.handle('windowControl', (event, action: unknown) => {
    const w = callingWindow(event);
    if (!w) return;
    const from = w === window ? 'editor' : 'settings';
    // close(), not destroy(): destroy() skips the 'close' event, which is where
    // the settings window is closed with the editor's (createWindow). The
    // launcher then takes it to the tray, or quits, from 'closed'.
    if (action === 'close') w.close();
    // The settings window has a close button only (Ship piece 3).
    else if (w !== window) return trayCheckReport('windowControl', { action, from, obeyed: false });
    else if (action === 'minimise') w.minimize();
    // A toggle, like double-clicking the bar, which Chromium does by itself.
    else if (action === 'maximise') {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
    } else return trayCheckReport('windowControl', { action, from, obeyed: false });
    // The title bar check reads this rather than isMinimized(): a check window is
    // never shown, and minimising one that was never mapped only sometimes takes
    // (1 run in 6, 2026-09-18).
    trayCheckReport('windowControl', { action, from, obeyed: true });
  });
  ipcMain.handle('windowState', (event): WindowState => {
    const w = callingWindow(event);
    return w ? windowState(w) : { maximised: false, focused: true };
  });
  ipcMain.handle('snapshot', (event): EditorSnapshot | null =>
    fromOurWindow(event) ? { store: storeView(), daemon: daemon.view() } : null,
  );
  ipcMain.handle('apply', (event, edit: Edit) => {
    if (!fromOurWindow(event)) return { ok: false, error: 'not allowed' };
    if (!store) return { ok: false, error: storeError ?? 'config.json is not open' };
    return store.apply(edit);
  });
  ipcMain.handle('acknowledgeReformat', (event) => {
    if (fromOurWindow(event)) store?.acknowledgeReformat();
  });
  ipcMain.handle('resolveConflict', async (event, choice: 'file' | 'mine') => {
    if (fromOurWindow(event) && (choice === 'file' || choice === 'mine')) await store?.resolveConflict(choice);
  });
  ipcMain.handle('reopenConfig', async (event) => (fromOurWindow(event) ? openStore() : storeView()));
  ipcMain.handle('previewSet', (event, serial: string, key: number, button: ButtonDef) =>
    fromOurWindow(event) ? daemonCall(() => daemon.previewSet(serial, key, button)) : { ok: false, code: 'not_allowed', error: 'not allowed' },
  );
  ipcMain.handle('previewClear', (event, serial: string, key?: number) =>
    fromOurWindow(event) ? daemonCall(() => daemon.previewClear(serial, key)) : { ok: false, code: 'not_allowed', error: 'not allowed' },
  );
  ipcMain.handle('testRun', (event, serial: unknown, action: unknown) => {
    const a = action as { type?: unknown } | null;
    if (!fromOurWindow(event) || typeof serial !== 'string' || typeof a !== 'object' || a === null || typeof a.type !== 'string') {
      return { ok: false, code: 'not_allowed', error: 'not allowed' };
    }
    return testRun(serial, a as ActionDef);
  });
  ipcMain.handle('findSystemShortcut', (event, combo: unknown) =>
    fromOurWindow(event) && typeof combo === 'string' && combo.length < 200 ? findSystemShortcut(combo) : null,
  );
  ipcMain.handle('switchProfile', (event, to: string) =>
    fromOurWindow(event) ? switchProfile(to) : { ok: false, code: 'not_allowed', error: 'not allowed' },
  );
  ipcMain.handle('showPage', (event, serial: string, page: string) =>
    fromOurWindow(event) ? showPage(serial, page) : { ok: false, code: 'not_allowed', error: 'not allowed' },
  );
  ipcMain.handle('watchIconFiles', (event, configPaths: unknown) => {
    if (!fromOurWindow(event) || !Array.isArray(configPaths) || configPaths.some((p) => typeof p !== 'string')) return {};
    return iconFiles.watchFiles(configPaths as string[]);
  });
  ipcMain.handle('iconStartFolder', async (event, currentIcon: unknown) => {
    if (!fromOurWindow(event)) return os.homedir();
    // A key showing a built-in opens on the Built-in section, as a file opens on its folder.
    if (typeof currentIcon === 'string' && currentIcon.startsWith(BUILTIN_PREFIX)) return BUILTIN_FOLDER;
    const icon = typeof currentIcon === 'string' && currentIcon !== '' ? expandPath(currentIcon) : null;
    // Newest bookmark first: the list is kept oldest-first for the row's order.
    const saved = [...(await bookmarks.list())].reverse();
    return startFolder(icon, saved, [app.getPath('pictures'), os.homedir()]);
  });
  ipcMain.handle('listIconFolder', (event, folder: unknown) =>
    fromOurWindow(event) && typeof folder === 'string' ? listIconFolder(folder) : { ok: false, error: 'not allowed' },
  );
  ipcMain.handle('stopIconWatch', (event) => {
    if (fromOurWindow(event)) folderWatcher.close();
  });
  ipcMain.handle('searchIcons', (event, folder: unknown, query: unknown) =>
    fromOurWindow(event) && typeof folder === 'string' && typeof query === 'string' && query.length < 200
      ? searchIcons(folder, query)
      : { ok: false, error: 'not allowed' },
  );
  ipcMain.handle('chooseIconFolder', async (event, current: unknown) => {
    if (!fromOurWindow(event) || !window) return null;
    const picked = await dialog.showOpenDialog(window, {
      title: 'Choose an icon folder',
      properties: ['openDirectory'],
      defaultPath: typeof current === 'string' ? current : undefined,
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });
  ipcMain.handle('collapsedLibrary', async (event) => {
    if (!fromOurWindow(event)) return [];
    const saved = (await preferences.read()).collapsedLibrary;
    return Array.isArray(saved) ? saved.filter((g): g is string => typeof g === 'string') : [];
  });
  ipcMain.handle('setCollapsedLibrary', async (event, groups: unknown) => {
    if (!fromOurWindow(event) || !Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) return;
    await preferences.set({ collapsedLibrary: groups });
  });
  ipcMain.handle('bookmarks', async (event) => (fromOurWindow(event) ? existingFolders(await bookmarks.list(), os.homedir(), true) : []));
  ipcMain.handle('addBookmark', async (event, folder: unknown) => {
    if (!fromOurWindow(event) || typeof folder !== 'string' || !path.isAbsolute(folder)) return [];
    return existingFolders(await bookmarks.add(folder), os.homedir(), true);
  });
  ipcMain.handle('removeBookmark', async (event, folder: unknown) => {
    if (!fromOurWindow(event) || typeof folder !== 'string') return [];
    return existingFolders(await bookmarks.remove(folder), os.homedir(), true);
  });
  ipcMain.handle('commitIcon', (event, at: unknown, icon: unknown, preview: unknown, slot: unknown) => {
    if (!fromOurWindow(event) || !isLocation(at) || !isIconChoice(icon)) return { ok: false, error: 'not allowed' };
    if (slot !== null && !PAIR_ICON_FIELDS.includes(slot as PairIconField)) return { ok: false, error: 'not allowed' };
    const p = preview as { serial?: unknown; key?: unknown } | null;
    const target = p && typeof p.serial === 'string' && Number.isInteger(p.key) ? { serial: p.serial, key: p.key as number } : null;
    return commitIcon(at, icon, target, slot as PairIconField | null);
  });
  ipcMain.on('reportCheck', (event, name: string, report: unknown) => {
    if (!CHECK || event.sender !== window?.webContents || name !== CHECK) return;
    finishCheck(report).catch((err) => {
      // A check that cannot finish must fail, not hang until the script's timeout.
      console.error(`DECKHAND_EDITOR_CHECK failed in main: ${(err as Error).stack ?? err}`);
      app.exit(1);
    });
  });
}

async function finishCheck(rendererReport: unknown): Promise<void> {
  const report: Record<string, unknown> = {
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    configPath: CONFIG_PATH,
    renderer: rendererReport,
  };
  if (CHECK === 'shared') {
    try {
      const { config } = await loadConfig();
      report.mainValidateConfig = { ok: true, profiles: Object.keys(config.profiles) };
    } catch (err) {
      report.mainValidateConfig = { ok: false, error: (err as Error).message };
    }
    report.mainParseCombo = parseCombo('ctrl+1');
  }
  if (CHECK === 'bridge' && store) {
    // The protocol's refusals, seen as HTTP statuses: an <img> fails the same
    // way whether a text file is refused or served, so the page alone cannot tell.
    const icon = Object.values(store.state().config.profiles)
      .flatMap((p) => Object.values(p.layouts))
      .flatMap((l) => Object.values(l.pages))
      .map((page) => page.buttons['0']?.icon)
      .find((p) => p !== undefined);
    if (icon) {
      const status = async (p: string) => (await net.fetch(iconUrl(p))).status;
      report.iconStatuses = {
        image: await status(icon),
        textFile: await status(icon.replace(/dot\.png$/, 'secret.txt')),
        missing: await status(icon.replace(/dot\.png$/, 'absent.png')),
        builtin: await status('builtin:speaker'),
        builtinUnknown: await status('builtin:nope'),
        builtinClimbing: await status('builtin:../missing'),
      };
    }
  }
  if (CHECK === 'screenshot' && window && process.env.DECKHAND_EDITOR_SCREENSHOT) {
    // A single paint is not reliable: the first run captured a frame from before
    // the check's click, the next the blank first paint after invalidate(). So
    // repaint a few times, let frames settle, and keep the latest.
    for (let i = 0; i < 3; i++) {
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const image = lastFrame;
    if (!image) throw new Error('no frame was painted');
    await fs.writeFile(process.env.DECKHAND_EDITOR_SCREENSHOT, image.toPNG());
    report.screenshot = { path: process.env.DECKHAND_EDITOR_SCREENSHOT, ...image.getSize() };
  }
  console.log(`DECKHAND_EDITOR_CHECK ${JSON.stringify(report)}`);
  app.quit(); // goes through before-quit, so unsaved edits are flushed
}

function createWindow(): void {
  // Screenshots only: render the settings window's page in this window, at its size.
  const settingsShot = CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_VIEW === 'settings';
  window = new BrowserWindow({
    width: settingsShot ? 640 : 1400,
    height: settingsShot ? SETTINGS_HEIGHT : 900,
    show: CHECK === null,
    /*
     * The editor draws its own title bar (Ship piece 4, scope §10): frame:
     * false, or KWin draws its own above it and there are two. Kept opaque,
     * with the drop shadow left on — measured on this machine 2026-09-18,
     * Electron 44.3.0 on Wayland: opaque, transparent and shadowless frameless
     * windows all resized from every edge and corner, dragged, and opened
     * KWin's window menu on a right-click of the bar; opaque with the shadow
     * is the one that looked right.
     */
    frame: false,
    // What shows before the page paints: the body's darkest colour, not
    // Electron's white, which a frameless window would flash edge to edge.
    backgroundColor: '#0d0e18',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // capturePage() fails here with "UnknownVizError", shown or offscreen
      // (seen 2026-09-15); offscreen rendering hands over frames through the
      // 'paint' event instead, which the screenshot check keeps.
      offscreen: CHECK === 'screenshot',
    },
  });
  if (CHECK === 'screenshot') window.webContents.on('paint', (_e, _dirty, image) => (lastFrame = image));
  // The settings window goes with it — to the tray or on quitting. Electron 44
  // already closes a child with its parent here (check:settings passes without
  // this line); it stays so that does not have to hold on every platform.
  window.on('close', () => settingsWindow?.close());
  window.on('focus', closeSettingsOnFocus);
  window.on('closed', () => (window = null));
  reportWindowState(window);
  const query: Record<string, string> = {};
  // The tray check drives the lifecycle from main; its renderer is the ordinary editor.
  if (CHECK && CHECK !== 'tray') query.check = CHECK;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_SELECT_KEY) query.selectKey = process.env.DECKHAND_EDITOR_SELECT_KEY;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_SELECT_DECK) query.selectDeck = process.env.DECKHAND_EDITOR_SELECT_DECK;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_SELECT_TAB) query.selectTab = process.env.DECKHAND_EDITOR_SELECT_TAB;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_OPEN) query.open = process.env.DECKHAND_EDITOR_OPEN;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_PAGE) query.page = process.env.DECKHAND_EDITOR_PAGE;
  if (CHECK === 'screenshot' && process.env.DECKHAND_EDITOR_SEARCH) query.search = process.env.DECKHAND_EDITOR_SEARCH;
  if (settingsShot) {
    query.view = 'settings';
    settingsWindow = window; // so the settings calls answer it
  }
  void window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), { query });
}

// Write unsaved edits before quitting. Autosave waits 400 ms after the last
// edit, so an edit made just before closing would otherwise be lost.
let flushedBeforeQuit = false;
app.on('before-quit', (event) => {
  if (flushedBeforeQuit || !store) return;
  event.preventDefault();
  flushedBeforeQuit = true;
  const current = store;
  void Promise.allSettled([current.flush(), preferences.flush()]).finally(() => {
    current.close();
    daemon.stop();
    app.quit();
  });
});

/**
 * What closing to the tray hands back (Ship piece 2): unsaved edits and
 * preferences are written, then config.json's watcher, the daemon socket and
 * the icon watchers are closed. A closed window runs no React cleanup, so the
 * icon watchers are closed here rather than left to the renderer.
 */
async function release(): Promise<void> {
  const current = store;
  store = null;
  await Promise.allSettled([current?.flush(), preferences.flush()]);
  current?.close();
  daemon.stop();
  folderWatcher.close();
  iconFiles.close();
}

let tray: LauncherTray = deadTray();

const launcher = new Launcher({
  acquire: async () => {
    await openStore();
    daemon.start();
  },
  release,
  createWindow: () => {
    createWindow();
    const created = window!;
    return {
      isDestroyed: () => created.isDestroyed(),
      isMinimized: () => created.isMinimized(),
      restore: () => created.restore(),
      show: () => created.show(),
      focus: () => created.focus(),
      onClosed: (listener) => created.on('closed', listener),
    };
  },
  closeToTray: async () => (await appSettings()).closeToTray,
  trayAlive: () => tray.alive(),
  quit: () => app.quit(),
  installChanged,
  restart: restartForNewInstall,
});

if (IS_PRIMARY && USES_LAUNCHER) app.on('second-instance', () => void launcher.open().then(() => trayCheckReport('second-instance')));

app.whenReady().then(async () => {
  if (!IS_PRIMARY) return;
  handleIconScheme();
  registerIpc();
  if (USES_LAUNCHER) {
    tray = createTray({
      iconPath: path.join(import.meta.dirname, '../icons/tray.png'),
      open: () => void launcher.open(),
      quit: () => launcher.quit(),
    });
  }
  // The tray check counts the editors that start, to see a restart happen:
  // a relaunched editor is a new process the check did not spawn.
  if (CHECK === 'tray' && process.env.DECKHAND_CHECK_PID_FILE) appendFileSync(process.env.DECKHAND_CHECK_PID_FILE, `${process.pid}\n`);
  await launcher.open();
  if (CHECK === 'tray') startTrayCheck();
});

// The window closing is the launcher's to handle (to the tray, or quit), and
// the check modes quit through it too: with no tray, a closed window quits.
app.on('window-all-closed', () => undefined);

/**
 * The tray check (scripts/check-tray.mjs), driven over stdin one command per
 * line, reporting state on stdout as `DECKHAND_TRAY {json}`. The tray and its
 * menu are driven through their real handlers; the window is closed as a user
 * closing it would, so the same 'closed' path runs.
 */
function trayCheckReport(event: string, extra: Record<string, unknown> = {}): void {
  if (CHECK !== 'tray') return;
  const state = {
    ...launcher.state(),
    storeOpen: store !== null,
    daemonConnected: daemon.view().connected,
    trayAlive: tray.alive(),
    settingsOpen: settingsWindow !== null && !settingsWindow.isDestroyed(),
    windows: BrowserWindow.getAllWindows().length,
    // The editor window as main sees it, for the title bar check.
    maximised: window && !window.isDestroyed() ? window.isMaximized() : null,
  };
  console.log(`DECKHAND_TRAY ${JSON.stringify({ event, ...state, ...extra })}`);
}

function startTrayCheck(): void {
  trayCheckReport('ready', { menu: tray.handlers().menu.map((item) => item.label) });
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const [command, ...rest] = line.trim().split(' ');
    const handlers = tray.handlers();
    if (command === 'state') trayCheckReport('state');
    else if (command === 'close') window?.close();
    else if (command === 'click') handlers.click();
    else if (command === 'menu') handlers.menu.find((item) => item.label === rest.join(' '))?.click();
    else if (command === 'edit') trayCheckReport('edited', { result: store?.apply(JSON.parse(rest.join(' ')) as Edit) ?? null });
    else if (command === 'settings') openSettings();
    // Check windows are never shown, so never focused: these emit the events
    // the compositor would, to run what listens for them. A click from Settings
    // into the editor is 'click-editor'; 'focus-editor' is the editor's focus
    // alone, as the stray one seen in this check.
    else if (command === 'click-editor') {
      if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow !== window) settingsWindow.emit('blur');
      window?.emit('focus');
    } else if (command === 'focus-editor') window?.emit('focus');
    // Run script in a window's page, as a person clicking there would, and report what it returns.
    else if (command === 'editor-js' || command === 'settings-js') {
      const target = command === 'editor-js' ? window : settingsWindow;
      const script = rest.join(' ');
      if (!target || target.isDestroyed()) trayCheckReport(command, { error: 'no such window' });
      else
        void target.webContents
          .executeJavaScript(script)
          .then((result: unknown) => trayCheckReport(command, { result }))
          .catch((err: unknown) => trayCheckReport(command, { error: err instanceof Error ? err.message : String(err) }));
    }
  });
}
