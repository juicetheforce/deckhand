import { promises as fs, watch, type Dirent, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { IconFolderEntry, IconFolderListing, IconSearchMatch } from '../shared/bridge.js';
import { isShownIcon } from '../shared/icons.js';
import { toConfigPath } from './config-document.js';
import { stamp } from './icon-files.js';

/**
 * The file side of the icon picker (docs/scope.md §10): list a folder with a
 * count on each subfolder, search the tree below it, watch the open folder.
 * Plain Node, no Electron, so test/icon-picker.test.ts runs it directly.
 * Bookmarked folders are the editor's own preference (src/main/preferences.ts).
 *
 * Icons are plain paths (scope §3). Nothing here copies, imports or indexes
 * anything: every listing and search reads the file system as it is now.
 */

/** A search walks at most this many directory entries (files and folders)... */
export const MAX_SEARCH_ENTRIES = 20_000;
/** ...and returns at most this many matches. Both are reported as `truncated`. */
export const MAX_SEARCH_MATCHES = 500;

/** Sort as a person expects: case-insensitive, with numbers in number order (Job 2 before Job 10). */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

function entry(folder: string, name: string, homeDir: string): IconFolderEntry {
  const full = path.join(folder, name);
  return { name, path: full, configPath: toConfigPath(full, homeDir) };
}

/**
 * How many folders and images a subfolder holds, for the count on its tile
 * (mockup 5a). Hidden entries and files the editor does not show are left out,
 * so the number matches what opening it would list. An unreadable folder
 * counts as nothing rather than failing the listing around it.
 */
async function countItems(folder: string): Promise<number> {
  try {
    const dirents = await fs.readdir(folder, { withFileTypes: true });
    return dirents.filter((d) => !d.name.startsWith('.') && (d.isDirectory() || isShownIcon(d.name))).length;
  } catch {
    return 0;
  }
}

/**
 * Folders and images directly in `folder`. Hidden entries (a leading dot) are
 * left out, and so are files that are not an image the editor shows
 * (ICON_CONTENT_TYPES). A symlink is listed as what it points to; a broken one
 * is left out.
 */
export async function listFolder(folder: string, homeDir: string): Promise<IconFolderListing> {
  if (!path.isAbsolute(folder)) throw new Error(`not an absolute path: ${folder}`);
  const dirents = await fs.readdir(folder, { withFileTypes: true });
  const folders: IconFolderEntry[] = [];
  const images: IconFolderEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    let isDirectory = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const target = await fs.stat(path.join(folder, d.name));
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    if (isDirectory) folders.push({ ...entry(folder, d.name, homeDir), items: await countItems(path.join(folder, d.name)) });
    else if (isFile && isShownIcon(d.name)) images.push({ ...entry(folder, d.name, homeDir), stamp: await stamp(path.join(folder, d.name)) });
  }
  folders.sort((a, b) => compareNames(a.name, b.name));
  images.sort((a, b) => compareNames(a.name, b.name));
  const parent = path.dirname(folder);
  return { path: folder, configPath: toConfigPath(folder, homeDir), parent: parent === folder ? null : parent, folders, images };
}

export interface SearchOutcome {
  matches: IconSearchMatch[];
  /** The walk stopped at MAX_SEARCH_ENTRIES, or matches reached MAX_SEARCH_MATCHES. */
  truncated: boolean;
  /** `stillWanted` returned false: a newer search replaced this one. */
  cancelled: boolean;
}

export interface SearchLimits {
  maxEntries?: number;
  maxMatches?: number;
}

/**
 * Images anywhere below `root` whose file name contains `query`,
 * case-insensitively (scope §10: the filter searches the whole subtree, and
 * each match says where it lives). Hidden entries are skipped. Symlinked
 * folders are not followed, so a link back up the tree cannot loop.
 * Unreadable folders are skipped silently. `stillWanted` is asked between
 * folders, so a search replaced by a newer one stops early.
 */
export async function searchFolder(
  root: string,
  query: string,
  homeDir: string,
  stillWanted: () => boolean = () => true,
  limits: SearchLimits = {},
): Promise<SearchOutcome> {
  if (!path.isAbsolute(root)) throw new Error(`not an absolute path: ${root}`);
  const maxEntries = limits.maxEntries ?? MAX_SEARCH_ENTRIES;
  const maxMatches = limits.maxMatches ?? MAX_SEARCH_MATCHES;
  const needle = query.trim().toLowerCase();
  const matches: IconSearchMatch[] = [];
  if (needle === '') return { matches, truncated: false, cancelled: false };

  const pending = [root];
  let walked = 0;
  while (pending.length > 0) {
    if (!stillWanted()) return { matches, truncated: false, cancelled: true };
    const folder = pending.shift()!;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => compareNames(a.name, b.name));
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (++walked > maxEntries) return { matches: sortMatches(matches), truncated: true, cancelled: false };
      if (d.isDirectory()) {
        pending.push(path.join(folder, d.name));
      } else if ((d.isFile() || d.isSymbolicLink()) && isShownIcon(d.name) && d.name.toLowerCase().includes(needle)) {
        const relative = path.relative(root, folder);
        matches.push({ ...entry(folder, d.name, homeDir), folder: relative });
        if (matches.length >= maxMatches) return { matches: sortMatches(matches), truncated: true, cancelled: false };
      }
    }
  }
  return { matches: sortMatches(matches), truncated: false, cancelled: false };
}

function sortMatches(matches: IconSearchMatch[]): IconSearchMatch[] {
  return matches.sort((a, b) => compareNames(a.folder, b.folder) || compareNames(a.name, b.name));
}

/**
 * The folder the picker opens on: the folder of the key's current icon if it
 * still exists, else the most recent folder that exists, else the first
 * fallback that exists (the caller passes Pictures, then home). Nothing is
 * hardcoded about any particular icon tree (scope §0).
 */
export async function startFolder(currentIconPath: string | null, recent: string[], fallbacks: string[]): Promise<string> {
  const candidates = [...(currentIconPath ? [path.dirname(currentIconPath)] : []), ...recent, ...fallbacks];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // gone; try the next
    }
  }
  return fallbacks[fallbacks.length - 1] ?? '/';
}

/**
 * Folders as picker entries (name, path, ~/ form). With `keepMissing`, a folder
 * that is gone is kept and marked — a bookmark the user saved should say it is
 * missing rather than quietly disappear.
 */
export async function existingFolders(folders: string[], homeDir: string, keepMissing = false): Promise<IconFolderEntry[]> {
  const found: IconFolderEntry[] = [];
  for (const folder of folders) {
    let exists = false;
    try {
      exists = (await fs.stat(folder)).isDirectory();
    } catch {
      exists = false;
    }
    if (exists) found.push(entry(path.dirname(folder), path.basename(folder), homeDir));
    else if (keepMissing) found.push({ ...entry(path.dirname(folder), path.basename(folder), homeDir), missing: true });
  }
  return found;
}

/**
 * Watches the one folder the picker has open (scope §10: the editor watches
 * the open folder instead of a refresh button). Not recursive. A burst of
 * changes (a file copied in, a folder unpacked) is reported once, 150 ms after
 * the last event: an event-started timer, nothing at rest.
 */
export class FolderWatcher {
  private watcher: FSWatcher | null = null;
  private folder: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: (folder: string) => void) {}

  watch(folder: string): void {
    if (folder === this.folder && this.watcher) return;
    this.close();
    this.folder = folder;
    try {
      this.watcher = watch(folder, { persistent: false }, () => this.changed(folder));
      // The folder itself was removed or became unreadable: report it once, stop watching.
      this.watcher.on('error', () => {
        this.close();
        this.onChange(folder);
      });
    } catch {
      this.watcher = null;
    }
  }

  private changed(folder: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.folder === folder) this.onChange(folder);
    }, 150);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    this.folder = null;
  }
}
