import { promises as fs } from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, type IpcMainInvokeEvent } from 'electron';
// The daemon's own modules, imported rather than copied (docs/scope.md §7, M4
// phase A proof 0a). Only modules with no dependencies beyond Node built-ins
// may be imported for their values; anything else is `import type` only.
import { STATE_DIR } from '../../../src/backups.js';
import { CONFIG_PATH, expandPath, loadConfig } from '../../../src/config.js';
import { socketPath } from '../../../src/control/server.js';
import { parseCombo } from '../../../src/keymap.js';
import type { ActionDef, ButtonDef } from '../../../src/types.js';
import type { DaemonResult, EditorSnapshot, IconFolderResult, IconSearchResult, StoreView } from '../shared/bridge.js';
import type { ApplyResult, ButtonLocation, Edit, IconChoice } from '../shared/edits.js';
import { BUILTIN_FOLDER, BUILTIN_PREFIX, iconUrl, type PairIconField } from '../shared/icons.js';
import { cleanSettingsPatch, deckOptions, DEFAULT_SETTINGS, readSettings, type AppSettings, type DeckOption } from '../shared/settings.js';
import { ConfigStore } from './config-store.js';
import { DaemonClient, DaemonError } from './daemon-client.js';
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
  settingsWindow = new BrowserWindow({
    parent: window,
    // The content's size, not the frame's: 6a's layout, with nothing below the footer.
    useContentSize: true,
    width: 640,
    height: 384,
    resizable: false,
    minimizable: false,
    maximizable: false,
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
  settingsWindow.on('closed', () => (settingsWindow = null));
  void settingsWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), { query: { view: 'settings' } });
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
  ipcMain.handle('openSettings', (event) => {
    if (fromOurWindow(event)) openSettings();
  });
  ipcMain.handle('closeSettings', (event) => {
    if (fromSettingsWindow(event)) settingsWindow?.close();
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
    height: settingsShot ? 384 : 900,
    show: CHECK === null,
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
  window.on('closed', () => (window = null));
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
