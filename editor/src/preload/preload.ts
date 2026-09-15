import { contextBridge, ipcRenderer } from 'electron';
import type { DeckhandBridge, SharedImportReport } from '../shared/bridge.js';

// Sandboxed preload: bundled to CommonJS by scripts/build-main.mjs, because a
// sandboxed preload cannot be an ES module.
const bridge: DeckhandBridge = {
  reportSharedImports(report: SharedImportReport) {
    ipcRenderer.send('shared-import-report', report);
  },
};

contextBridge.exposeInMainWorld('deckhand', bridge);
