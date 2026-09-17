import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DaemonView, DeckhandBridge, StoreView } from '../shared/bridge.js';

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
  findSystemShortcut: (combo) => ipcRenderer.invoke('findSystemShortcut', combo),
  previewSet: (serial, key, button) => ipcRenderer.invoke('previewSet', serial, key, button),
  previewClear: (serial, key) => ipcRenderer.invoke('previewClear', serial, key),
  testRun: (serial, action) => ipcRenderer.invoke('testRun', serial, action),
  collapsedLibrary: () => ipcRenderer.invoke('collapsedLibrary'),
  setCollapsedLibrary: (groups) => ipcRenderer.invoke('setCollapsedLibrary', groups),
  bookmarks: () => ipcRenderer.invoke('bookmarks'),
  addBookmark: (folder) => ipcRenderer.invoke('addBookmark', folder),
  removeBookmark: (folder) => ipcRenderer.invoke('removeBookmark', folder),
  watchIconFiles: (configPaths) => ipcRenderer.invoke('watchIconFiles', configPaths),
  onIconStamps: (callback) => subscribe<Record<string, string>>('iconStamps', callback),
  iconStartFolder: (currentIcon) => ipcRenderer.invoke('iconStartFolder', currentIcon),
  listIconFolder: (folder) => ipcRenderer.invoke('listIconFolder', folder),
  stopIconWatch: () => ipcRenderer.invoke('stopIconWatch'),
  searchIcons: (folder, query) => ipcRenderer.invoke('searchIcons', folder, query),
  chooseIconFolder: (current) => ipcRenderer.invoke('chooseIconFolder', current),
  commitIcon: (at, icon, preview, slot) => ipcRenderer.invoke('commitIcon', at, icon, preview, slot),
  onIconFolderChanged: (callback) => subscribe<string>('iconFolderChanged', callback),
  onStore: (callback) => subscribe<StoreView>('store', callback),
  onDaemon: (callback) => subscribe<DaemonView>('daemon', callback),
  reportCheck: (name, report) => ipcRenderer.send('reportCheck', name, report),
};

contextBridge.exposeInMainWorld('deckhand', bridge);
