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

/** The folder, under home, that an icon from outside home is restored into. */
export const RESTORED_FOLDER = '~/Deckhand icons (restored)';

/**
 * Limits on a bundle, checked against what the zip declares before anything
 * is unzipped: fflate allocates each entry at its declared size (docs/
 * code-state.md, M5 piece 2). Generous for real use — the maintainer's export is 31
 * files and 4.6 MB.
 */
export const IMPORT_LIMITS = { entries: 5000, entryBytes: 50 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 } as const;

/**
 * What happens to one icon path in an import. A file already at the path is
 * always the one used; the bundle's copy only ever fills an empty place.
 * - write: the bundle's file is written to `to`, where nothing is now;
 * - same: the file at `to` is already identical;
 * - kept: something different is at `to`; it is kept, never overwritten;
 * - here: a file is at `to`, and there is nothing to compare it with (a bare
 *   .json has no hashes);
 * - absent: nothing in the bundle and nothing at `to` — the key will show
 *   the missing icon;
 * - refused: not an image file the picker shows, so never written;
 * - missing-at-export: the export could not read it either.
 */
export type ImportIconOutcome = 'write' | 'same' | 'kept' | 'here' | 'absent' | 'refused' | 'missing-at-export';

export interface ImportIcon {
  /** The path as the imported config wrote it. */
  from: string;
  /** The path the config will hold: remapped to `~/`, or relocated. */
  to: string;
  /** Moved from outside home into RESTORED_FOLDER; the review lists every one. */
  relocated: boolean;
  outcome: ImportIconOutcome;
  /** Why, for kept and refused. */
  reason?: string;
}

/** Everything the review shows, before anything is written. Held by main with the plan; the renderer only sees this. */
export interface ImportReview {
  id: string;
  /** A Deckhand export, or a bare config file: config only, paths used as they are. */
  kind: 'bundle' | 'json';
  /** The chosen file, `~/` for home. */
  source: string;
  exportedAt: string | null;
  /** The exporting home, when the bundle says (bundles only). */
  exportedHome: string | null;
  includesIcons: boolean;
  profiles: string[];
  decks: Array<{ serial: string; name: string | null; connected: boolean }>;
  icons: ImportIcon[];
  /** Built-in names the config uses that this version of Deckhand does not ship. */
  builtinsMissing: string[];
  /** Strings outside the icon fields that name the exporting home — a command, say. Not rewritten. */
  oldHomeElsewhere: string[];
  /** The editor holds edits the import will replace. */
  unsavedDiscarded: boolean;
  /** Where the replaced config.json will be kept, `~/` for home. */
  backupFolder: string;
}

export type ImportChoice = { ok: true; review: ImportReview } | { ok: false; cancelled: true } | { ok: false; cancelled?: false; error: string };

export type ImportResult =
  | {
      ok: true;
      /** Icon files written. */
      written: number;
      /** Files that appeared at a destination between the review and now: not written, kept. */
      appeared: string[];
      /** The replaced config, `~/` for home; null if there was no config.json to keep. */
      backup: string | null;
    }
  | { ok: false; error: string };
