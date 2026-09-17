import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { iconFilePath } from './builtin-icons.js';

/**
 * Keeps the editor's view of the icon files a page uses current.
 *
 * Chromium never re-requests an image whose URL has not changed, so a key's
 * icon in the grid would keep showing whatever it loaded first — even after
 * the file is renamed away or put back (found by the maintainer on the real decks,
 * 2026-09-15). Each file gets a stamp (its modification time and size, or
 * "missing"); the renderer puts the stamp in the icon URL, so a changed file
 * is a new URL and is fetched again.
 *
 * The folders holding those files are watched — not recursively, one watch
 * per folder however many icons it holds — and a burst of changes is reported
 * once, 150 ms after the last event. Watches follow what is on screen: only
 * the icons of the page being edited.
 */
export class IconFiles {
  private watchers = new Map<string, FSWatcher>();
  /** The config paths ("~/…" as stored) currently watched, to their stamps. */
  private current = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: (stamps: Record<string, string>) => void) {}

  /** Watch exactly these icon paths (as the config stores them), and return their stamps now. */
  async watchFiles(configPaths: string[]): Promise<Record<string, string>> {
    const wanted = [...new Set(configPaths)];
    // A built-in name the checkout does not ship has no file and no folder to
    // watch: it stamps as missing. (path.dirname of "builtin:x" would be ".",
    // the editor's working directory.)
    const files = wanted.map((p) => iconFilePath(p)).filter((f): f is string => f !== null);
    const folders = new Set(files.map((f) => path.dirname(f)));

    for (const [folder, watcher] of this.watchers) {
      if (folders.has(folder)) continue;
      watcher.close();
      this.watchers.delete(folder);
    }
    for (const folder of folders) {
      if (this.watchers.has(folder)) continue;
      try {
        const watcher = watch(folder, { persistent: false }, () => this.changed());
        // A folder that goes away stops reporting; the stamps already say "missing".
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(folder);
        });
        this.watchers.set(folder, watcher);
      } catch {
        // Unreadable or gone: its files stamp as missing.
      }
    }

    this.current = new Map(await Promise.all(wanted.map(async (p) => [p, await stamp(p)] as const)));
    return Object.fromEntries(this.current);
  }

  private changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.restamp();
    }, 150);
  }

  private async restamp(): Promise<void> {
    const paths = [...this.current.keys()];
    const next = new Map(await Promise.all(paths.map(async (p) => [p, await stamp(p)] as const)));
    // Only tell the renderer when a stamp really changed: every write in the
    // folder wakes the watcher, including files no key uses.
    const changed = paths.some((p) => next.get(p) !== this.current.get(p));
    this.current = next;
    if (changed) this.onChange(Object.fromEntries(next));
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.current.clear();
  }
}

/** A file's modification time and size, or "missing" — enough to tell one version of an icon from another. Takes builtin:<name> too. */
export async function stamp(configPath: string): Promise<string> {
  const file = iconFilePath(configPath);
  if (file === null) return 'missing';
  try {
    const st = await fs.stat(file);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return 'missing';
  }
}
