/**
 * The API the preload script exposes to the renderer as `window.deckhand`.
 * Types only: shared by the preload (which implements it) and the renderer
 * (which calls it). The renderer has no Node and no direct access to Electron.
 */

/** What the renderer reports back in the shared-import check (proof 0a). */
export interface SharedImportReport {
  parseCombo: number[];
  /** A value typed with StateSnapshot from the daemon's src/control/commands.ts. */
  protocolTypeUsed: string;
  error?: string;
}

export interface DeckhandBridge {
  reportSharedImports(report: SharedImportReport): void;
}
