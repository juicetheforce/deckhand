/**
 * Export and import of the whole configuration (M5, docs/scope.md §5 "Backup
 * has two halves", §7). No Node imports: the renderer uses these types.
 *
 * An export is a .zip holding `config.json` byte for byte, a manifest
 * (`deckhand-export.json`), and — unless it is config only — every icon file
 * the config names, under `icons/`. Built-ins (`builtin:<name>`) ship with the
 * app, so they are listed but never bundled.
 */

export const BUNDLE_FORMAT = 'deckhand-export';
/** Raised when a bundle changes in a way an older import could misread. */
export const BUNDLE_VERSION = 1;
export const MANIFEST_ENTRY = 'deckhand-export.json';
export const CONFIG_ENTRY = 'config.json';

/**
 * Every config field that holds an icon: a key's own `icon`, and the state
 * pairs actions keep (src/shared/icons.ts, PairIconField). An export collects
 * these wherever they appear, not only where the editor shows them.
 */
export const ICON_FIELDS = ['icon', 'iconMuted', 'iconUnmuted', 'iconPlaying', 'iconPaused'] as const;

/** One icon path, exactly as the config writes it. */
export interface BundledIcon {
  path: string;
  /** Its file in the zip, or null for a config-only export. Two paths naming one file share an entry. */
  entry: string | null;
  sha256: string;
  size: number;
}

export interface ExportManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  /** The exporting user's home: import rewrites paths under it to `~/`. */
  home: string;
  includesIcons: boolean;
  icons: BundledIcon[];
  /** Icon paths the config names that could not be read at export, with why. */
  missing: Array<{ path: string; reason: string }>;
  /** Built-in names the config uses (without `builtin:`). */
  builtins: string[];
}

export type ExportResult =
  | {
      ok: true;
      /** Where it was written, `~/` for the home directory. */
      path: string;
      includesIcons: boolean;
      /** Distinct icon files in the zip. */
      iconFiles: number;
      bytes: number;
      missing: Array<{ path: string; reason: string }>;
      /** The editor had edits it could not save (a conflict, or a reformat not yet allowed); they are not in the export. */
      unsavedLeftOut: boolean;
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string };
