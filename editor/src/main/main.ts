import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron';
// The daemon's own modules, imported rather than copied (docs/scope.md §7, M4
// phase A proof 0a). Only modules with no dependencies beyond Node built-ins
// may be imported for their values; anything else is `import type` only.
import { STATE_DIR } from '../../../src/backups.js';
import { CONFIG_PATH, loadConfig } from '../../../src/config.js';
import { socketPath } from '../../../src/control/server.js';
import { parseCombo } from '../../../src/keymap.js';
import type { ButtonDef } from '../../../src/types.js';
import type { DaemonResult, EditorSnapshot, StoreView } from '../shared/bridge.js';
import type { Edit } from '../shared/edits.js';
import { ConfigStore } from './config-store.js';
import { DaemonClient, DaemonError } from './daemon-client.js';

// Electron's state (cache, local storage, lock files) goes in the state
// directory, never the default ~/.config/<app name>: that would sit next to
// config.json, in a directory that may be synced. Uninstall already removes
// the state directory. Must be set before the app is ready. (docs/scope.md §0)
app.setPath('userData', path.join(STATE_DIR, 'editor'));

/**
 * Check modes, used only by scripts/check-*.mjs: "shared" (proof 0a) and
 * "bridge" (step 2). The renderer runs the check and reports with
 * reportCheck(); main prints one line and quits.
 */
const CHECK = process.env.DECKHAND_EDITOR_CHECK ?? null;

// No application menu: Electron's default one binds Ctrl+W, Ctrl+R, Ctrl+Q
// and more, which would fire while the hotkey inspector is listening. With
// it removed those combos reach the page and can be captured (scope §10, 0b).
Menu.setApplicationMenu(null);

let window: BrowserWindow | null = null;
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

/** Only this window's own page may call in. */
function fromOurWindow(event: IpcMainInvokeEvent): boolean {
  return window !== null && event.sender === window.webContents;
}

function registerIpc(): void {
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
  ipcMain.on('reportCheck', (event, name: string, report: unknown) => {
    if (!CHECK || event.sender !== window?.webContents || name !== CHECK) return;
    void finishCheck(report);
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
  console.log(`DECKHAND_EDITOR_CHECK ${JSON.stringify(report)}`);
  app.quit(); // goes through before-quit, so unsaved edits are flushed
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: CHECK === null,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.on('closed', () => (window = null));
  void window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), CHECK ? { query: { check: CHECK } } : undefined);
}

// Write unsaved edits before quitting. Autosave waits 400 ms after the last
// edit, so an edit made just before closing would otherwise be lost.
let flushedBeforeQuit = false;
app.on('before-quit', (event) => {
  if (flushedBeforeQuit || !store) return;
  event.preventDefault();
  flushedBeforeQuit = true;
  const current = store;
  void current.flush().finally(() => {
    current.close();
    daemon.stop();
    app.quit();
  });
});

app.whenReady().then(async () => {
  registerIpc();
  await openStore();
  daemon.start();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
