import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DaemonView, DeckhandBridge, SettingsSection, StoreView, WindowState } from '../shared/bridge.js';
import type { ObsStatus, VtsStatus } from '../../../src/control/protocol.js';
import type { AppSettings } from '../shared/settings.js';

// Sandboxed preload: bundled to CommonJS by scripts/build-main.mjs, because a
// sandboxed preload cannot be an ES module. It only forwards calls; every
// decision is made in the main process.

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: DeckhandBridge = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  apply: (edit) => ipcRenderer.invoke('apply', edit),
  acknowledgeReformat: () => ipcRenderer.invoke('acknowledgeReformat'),
  resolveConflict: (choice) => ipcRenderer.invoke('resolveConflict', choice),
  reopenConfig: () => ipcRenderer.invoke('reopenConfig'),
  switchProfile: (to) => ipcRenderer.invoke('switchProfile', to),
  showPage: (serial, page) => ipcRenderer.invoke('showPage', serial, page),
  clearFailure: (at) => ipcRenderer.invoke('clearFailure', at),
  findSystemShortcut: (combo) => ipcRenderer.invoke('findSystemShortcut', combo),
  previewSet: (serial, key, button) => ipcRenderer.invoke('previewSet', serial, key, button),
  previewClear: (serial, key) => ipcRenderer.invoke('previewClear', serial, key),
  testRun: (serial, action) => ipcRenderer.invoke('testRun', serial, action),
  refreshApps: () => ipcRenderer.invoke('refreshApps'),
  obsList: (kind, scene) => ipcRenderer.invoke('obsList', kind, scene),
  vtsList: (kind, model) => ipcRenderer.invoke('vtsList', kind, model),
  collapsedLibrary: () => ipcRenderer.invoke('collapsedLibrary'),
  setCollapsedLibrary: (groups) => ipcRenderer.invoke('setCollapsedLibrary', groups),
  shownDecks: () => ipcRenderer.invoke('shownDecks'),
  setShownDecks: (serials) => ipcRenderer.invoke('setShownDecks', serials),
  deckPositions: () => ipcRenderer.invoke('deckPositions'),
  setDeckPositions: (positions) => ipcRenderer.invoke('setDeckPositions', positions),
  lockedDecks: () => ipcRenderer.invoke('lockedDecks'),
  setLockedDecks: (serials) => ipcRenderer.invoke('setLockedDecks', serials),
  bookmarks: () => ipcRenderer.invoke('bookmarks'),
  addBookmark: (folder) => ipcRenderer.invoke('addBookmark', folder),
  removeBookmark: (folder) => ipcRenderer.invoke('removeBookmark', folder),
  watchIconFiles: (configPaths) => ipcRenderer.invoke('watchIconFiles', configPaths),
  onIconStamps: (callback) => subscribe<Record<string, string>>('iconStamps', callback),
  iconStartFolder: (currentIcon) => ipcRenderer.invoke('iconStartFolder', currentIcon),
  listIconFolder: (folder) => ipcRenderer.invoke('listIconFolder', folder),
  stopIconWatch: () => ipcRenderer.invoke('stopIconWatch'),
  searchIcons: (folder, query) => ipcRenderer.invoke('searchIcons', folder, query),
  commitIcon: (at, icon, preview, slot) => ipcRenderer.invoke('commitIcon', at, icon, preview, slot),
  onIconFolderChanged: (callback) => subscribe<string>('iconFolderChanged', callback),
  appSettings: () => ipcRenderer.invoke('appSettings'),
  setAppSettings: (patch) => ipcRenderer.invoke('setAppSettings', patch),
  resetAppSettings: () => ipcRenderer.invoke('resetAppSettings'),
  settingsDecks: () => ipcRenderer.invoke('settingsDecks'),
  notifications: () => ipcRenderer.invoke('notifications'),
  appVersion: () => ipcRenderer.invoke('appVersion'),
  openReleases: () => ipcRenderer.invoke('openReleases'),
  setNotifications: (on) => ipcRenderer.invoke('setNotifications', on),
  exportConfig: (includeIcons) => ipcRenderer.invoke('exportConfig', includeIcons),
  deleteProfile: (profile, pageName) => ipcRenderer.invoke('deleteProfile', profile, pageName),
  keptConfigs: () => ipcRenderer.invoke('keptConfigs'),
  restoreKeptConfig: (file) => ipcRenderer.invoke('restoreKeptConfig', file),
  deleteKeptConfig: (file) => ipcRenderer.invoke('deleteKeptConfig', file),
  chooseImport: () => ipcRenderer.invoke('chooseImport'),
  confirmImport: (id) => ipcRenderer.invoke('confirmImport', id),
  cancelImport: (id) => ipcRenderer.invoke('cancelImport', id),
  openSettings: (section) => ipcRenderer.invoke('openSettings', section),
  onSettingsSection: (callback) => subscribe<SettingsSection>('settingsSection', callback),
  obsStatus: () => ipcRenderer.invoke('obsStatus'),
  onObsStatus: (callback) => subscribe<ObsStatus | null>('obsStatus', callback),
  obsTest: (values) => ipcRenderer.invoke('obsTest', values),
  obsSave: (values) => ipcRenderer.invoke('obsSave', values),
  obsRemove: () => ipcRenderer.invoke('obsRemove'),
  vtsStatus: () => ipcRenderer.invoke('vtsStatus'),
  onVtsStatus: (callback) => subscribe<VtsStatus | null>('vtsStatus', callback),
  vtsConnect: (port) => ipcRenderer.invoke('vtsConnect', port),
  vtsRemove: () => ipcRenderer.invoke('vtsRemove'),
  closeSettings: () => ipcRenderer.invoke('closeSettings'),
  onAppSettings: (callback) => subscribe<AppSettings>('appSettings', callback),
  windowControl: (action) => ipcRenderer.invoke('windowControl', action),
  windowState: () => ipcRenderer.invoke('windowState'),
  onWindowState: (callback) => subscribe<WindowState>('windowState', callback),
  onStore: (callback) => subscribe<StoreView>('store', callback),
  onDaemon: (callback) => subscribe<DaemonView>('daemon', callback),
  reportCheck: (name, report) => ipcRenderer.send('reportCheck', name, report),
};

contextBridge.exposeInMainWorld('deckhand', bridge);
