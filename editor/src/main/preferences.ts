import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_BOOKMARKS } from '../shared/bridge.js';

/**
 * The editor's own preferences — the first thing it persists that is not
 * config. Bookmarked icon folders today.
 *
 * **Never `config.json`.** That file is the daemon's, and these are the
 * editor's own preferences; it lives in Electron's `userData`, which is set
 * to `$XDG_STATE_HOME/deckhand/editor/`, so uninstall takes it
 * with the app and nothing the editor writes lands beside the config.
 *
 * Writes are debounced and `flush()` writes before the editor quits, because
 * a burst (a drag, a row of edits) would otherwise write once per change.
 */
export class Preferences {
  private value: Record<string, unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly debounceMs = 400,
  ) {}

  async read(): Promise<Record<string, unknown>> {
    if (this.value) return this.value;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.value = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      this.value = {};
    }
    return this.value;
  }

  /** Merge these keys in and save. */
  async set(patch: Record<string, unknown>): Promise<void> {
    this.value = { ...(await this.read()), ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.write(), this.debounceMs);
  }

  /** Write now, if anything is waiting. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.write();
    }
    await this.writing;
  }

  private async write(): Promise<void> {
    this.timer = null;
    const value = this.value ?? {};
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
        await fs.rename(temp, this.file);
      } catch {
        // Losing a pane width is not worth troubling anyone with.
      }
    });
    await this.writing;
  }
}

/**
 * Bookmarked icon folders: the picker's one row of saved places, in the order
 * they were added. Chosen over a list of recent folders, which drifted.
 */
export class Bookmarks {
  constructor(private readonly preferences: Preferences) {}

  async list(): Promise<string[]> {
    const stored = (await this.preferences.read()).bookmarks;
    if (!Array.isArray(stored)) return [];
    return stored.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f)).slice(0, MAX_BOOKMARKS);
  }

  /** Add a folder, keeping the oldest if the list is full. Returns the list as it now stands. */
  async add(folder: string): Promise<string[]> {
    const current = await this.list();
    if (current.includes(folder)) return current;
    if (current.length >= MAX_BOOKMARKS) return current;
    const next = [...current, folder];
    await this.preferences.set({ bookmarks: next });
    return next;
  }

  async remove(folder: string): Promise<string[]> {
    const next = (await this.list()).filter((f) => f !== folder);
    await this.preferences.set({ bookmarks: next });
    return next;
  }
}
