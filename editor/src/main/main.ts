import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
// The daemon's own modules, imported rather than copied (docs/scope.md §7, M4
// phase A proof 0a). Only modules with no dependencies beyond Node built-ins
// may be imported for their values; anything else is `import type` only.
import { STATE_DIR } from '../../../src/backups.js';
import { CONFIG_PATH, loadConfig } from '../../../src/config.js';
import { parseCombo } from '../../../src/keymap.js';
import type { SharedImportReport } from '../shared/bridge.js';

// Electron's state (cache, local storage, lock files) goes in the state
// directory, never the default ~/.config/<app name>: that would sit next to
// config.json, in a directory that may be synced. Uninstall already removes
// the state directory. Must be set before the app is ready. (docs/scope.md §0)
app.setPath('userData', path.join(STATE_DIR, 'editor'));

const CHECK_MODE = process.env.DECKHAND_EDITOR_CHECK === '1';

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !CHECK_MODE,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return window;
}

/**
 * Proof 0a: run the shared modules in the main process, collect what the
 * renderer ran with them, print one JSON line and quit.
 * Driven by scripts/check-shared-imports.mjs.
 */
async function runSharedImportCheck(): Promise<void> {
  const report: Record<string, unknown> = {
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    configPath: CONFIG_PATH,
  };
  try {
    const { config } = await loadConfig();
    report.mainValidateConfig = { ok: true, profiles: Object.keys(config.profiles) };
  } catch (err) {
    report.mainValidateConfig = { ok: false, error: (err as Error).message };
  }
  report.mainParseCombo = parseCombo('ctrl+1');

  const fromRenderer = new Promise<SharedImportReport>((resolve) => {
    ipcMain.once('shared-import-report', (_event, value: SharedImportReport) => resolve(value));
  });
  createWindow();
  report.renderer = await fromRenderer;

  console.log(`DECKHAND_EDITOR_CHECK ${JSON.stringify(report)}`);
  app.quit();
}

// No application menu: Electron's default one binds Ctrl+W, Ctrl+R, Ctrl+Q
// and more, which would fire while the hotkey inspector is listening.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  if (CHECK_MODE) {
    runSharedImportCheck().catch((err) => {
      console.error(err);
      app.exit(1);
    });
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
