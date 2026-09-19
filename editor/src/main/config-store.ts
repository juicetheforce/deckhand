import { randomBytes } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../../../src/config.js';
import type { Config } from '../../../src/types.js';
import type { Conflict, StoreState } from '../shared/bridge.js';
import type { ApplyResult, Edit, EditResult } from '../shared/edits.js';
import { applyEdit, serializeConfig, type EditEnvironment } from './config-document.js';

export type { Conflict, StoreState };

/**
 * The editor's copy of config.json, and the only code that writes it
 * (docs/scope.md §10, "Autosave").
 *
 * - Every edit is validated with the daemon's own validateConfig before it is
 *   accepted, so the editor never writes a config the daemon would refuse.
 * - Autosave: accepted edits are written after `debounceMs` without another
 *   edit, and on flush() (the editor quitting).
 * - Written as a temporary file beside config.json, then renamed onto it. The
 *   daemon's config watcher filters on the name "config.json", so the
 *   temporary file never causes a reload, and the rename causes exactly one
 *   (both confirmed in scripts/smoke-backups.mjs and this store's test).
 * - Edits made outside the editor: with nothing unsaved, the file is
 *   reloaded silently; with unsaved edits, the store reports a conflict and
 *   does not overwrite the file until told which side to keep. An invalid
 *   file on disk is never overwritten — editing stops until it is fixed.
 * - A file not already in the editor's own format (two-space JSON) would be
 *   reformatted entirely by the first save, so the store does not save until
 *   the reformat is acknowledged.
 */

export interface StoreOptions {
  configPath: string;
  debounceMs?: number;
  onChange?: (state: StoreState) => void;
  env?: Partial<EditEnvironment>;
}

/** How long a burst of file events is given to settle before the file is read. */
const EXTERNAL_SETTLE_MS = 100;

export class ConfigStore {
  private config: Config;
  /** The file text the editor last loaded or wrote. A different text on disk means someone else wrote it. */
  private baseText: string;
  private dirty = false;
  private conflict: Conflict | null = null;
  private fileError: string | null = null;
  private reformatPending: boolean;
  private saveError: string | null = null;

  private saveTimer: NodeJS.Timeout | null = null;
  private externalTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  /** Writes and external reads run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  private readonly configPath: string;
  private readonly debounceMs: number;
  private readonly onChange: (state: StoreState) => void;
  private readonly env: EditEnvironment;

  private constructor(options: StoreOptions, config: Config, text: string) {
    this.configPath = options.configPath;
    this.debounceMs = options.debounceMs ?? 400;
    this.onChange = options.onChange ?? (() => {});
    this.env = {
      homeDir: options.env?.homeDir ?? os.homedir(),
      randomHex: options.env?.randomHex ?? ((length) => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)),
    };
    this.config = config;
    this.baseText = text;
    this.reformatPending = serializeConfig(config) !== text;
  }

  /**
   * Load and validate config.json and start watching it. Throws if the file
   * is missing, not valid, or a symlink — the editor cannot edit any of those.
   */
  static async open(options: StoreOptions): Promise<ConfigStore> {
    const link = await fs.lstat(options.configPath);
    if (link.isSymbolicLink()) {
      // The daemon watches the config directory for writes to the name
      // config.json; a write to a symlink's target elsewhere never reaches it,
      // so the decks would not update (checked in the store's test).
      throw new Error(`${options.configPath} is a symlink. The daemon does not see changes made through it, so the editor does not write it.`);
    }
    const text = await fs.readFile(options.configPath, 'utf8');
    const store = new ConfigStore(options, parseAndValidate(text), text);
    store.startWatching();
    return store;
  }

  state(): StoreState {
    return {
      config: this.config,
      dirty: this.dirty,
      conflict: this.conflict,
      fileError: this.fileError,
      reformatPending: this.reformatPending,
      saveError: this.saveError,
    };
  }

  /** Apply an edit. An edit that fails, or leaves the config invalid, changes nothing. */
  apply(edit: Edit): ApplyResult {
    if (this.conflict) return { ok: false, error: 'config.json was changed outside the editor; resolve that first' };
    if (this.fileError) return { ok: false, error: `config.json on disk is not usable: ${this.fileError}` };

    const candidate = structuredClone(this.config);
    let result: EditResult;
    try {
      result = applyEdit(candidate, edit, this.env);
      validateConfig(candidate);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // An edit that changes nothing (the same label again) writes nothing.
    if (serializeConfig(candidate) === serializeConfig(this.config)) return { ok: true, result };

    this.config = candidate;
    this.dirty = true;
    this.scheduleSave();
    this.emit();
    return { ok: true, result };
  }

  acknowledgeReformat(): void {
    if (!this.reformatPending) return;
    this.reformatPending = false;
    if (this.dirty) this.scheduleSave();
    this.emit();
  }

  /** Keep the file's version ("file") or write the editor's ("mine"). */
  resolveConflict(choice: 'file' | 'mine'): Promise<void> {
    return this.enqueue(async () => {
      const conflict = this.conflict;
      if (!conflict) return;
      this.conflict = null;
      if (choice === 'file') {
        this.dirty = false;
        this.adoptFileText(conflict.fileText);
      } else {
        // Overwrite whatever is on disk now, even if it changed again.
        this.baseText = await this.readFileText();
        this.dirty = true;
        await this.writeNow();
      }
      this.emit();
    });
  }

  /**
   * Write unsaved edits now. Called before the editor quits, and before it asks
   * the daemon to show a page that may exist only in unsaved edits. Resolves
   * true if a write happened.
   */
  flush(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.enqueue(() => this.writeNow());
  }

  /**
   * Replace the whole config (M5 import). In the queue, so no save or
   * external read interleaves: reads the text being replaced and hands it to
   * `keep` first — if that fails, nothing is written — then writes the new
   * config. Unsaved edits, a conflict and a pending reformat all go: the file
   * is being replaced, which the import's review says before confirming.
   * Resolves with the replaced text (null if there was no file); throws if
   * the config is invalid or the write fails.
   */
  replace(config: Config, keep: (replacedText: string | null) => Promise<void>): Promise<string | null> {
    validateConfig(structuredClone(config));
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.enqueue(async () => {
      let replaced: string | null;
      try {
        replaced = await this.readFileText();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        replaced = null;
      }
      await keep(replaced);
      this.config = structuredClone(config);
      this.conflict = null;
      this.fileError = null;
      this.reformatPending = false;
      this.dirty = true;
      // writeNow() compares the file with baseText before writing; it is what
      // was just read and kept.
      this.baseText = replaced ?? '';
      if (!(await this.writeNow())) throw new Error(this.saveError ?? 'config.json was not written');
      return replaced;
    });
  }

  /** Stop watching and cancel pending work. Does not write: flush() first. */
  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.externalTimer) clearTimeout(this.externalTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private emit(): void {
    this.onChange(this.state());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueue(() => this.writeNow());
    }, this.debounceMs);
  }

  private async readFileText(): Promise<string> {
    return fs.readFile(this.configPath, 'utf8');
  }

  /** Resolves true if config.json was written. */
  private async writeNow(): Promise<boolean> {
    if (!this.dirty || this.conflict || this.fileError || this.reformatPending) return false;

    // Last check before overwriting: the file must still be what the editor
    // last saw. The watcher usually reports a change first, but a write can
    // land between its event and this save.
    let onDisk: string;
    try {
      onDisk = await this.readFileText();
    } catch (err) {
      this.saveError = `cannot read config.json before saving: ${(err as Error).message}`;
      this.emit();
      return false;
    }
    if (onDisk !== this.baseText) {
      this.enterConflict(onDisk);
      return false;
    }

    const text = serializeConfig(this.config);
    const dir = path.dirname(this.configPath);
    const temp = path.join(dir, `.${path.basename(this.configPath)}.editor-${process.pid}-${++this.tempCounter}.tmp`);
    try {
      const { mode } = await fs.stat(this.configPath);
      const handle = await fs.open(temp, 'wx', mode & 0o777);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, this.configPath);
    } catch (err) {
      await fs.rm(temp, { force: true });
      this.saveError = `could not save config.json: ${(err as Error).message}`;
      this.emit();
      return false;
    }
    this.baseText = text;
    this.dirty = false;
    this.saveError = null;
    this.emit();
    return true;
  }

  private startWatching(): void {
    const name = path.basename(this.configPath);
    this.watcher = watch(path.dirname(this.configPath), (_event, filename) => {
      if (filename !== null && filename.toString() !== name) return;
      if (this.externalTimer) clearTimeout(this.externalTimer);
      this.externalTimer = setTimeout(() => {
        this.externalTimer = null;
        void this.enqueue(() => this.checkExternalChange());
      }, EXTERNAL_SETTLE_MS);
    });
    this.watcher.on('error', () => {
      // A watcher that stops reporting only loses silent reloads; writeNow()
      // still checks the file before every save.
      this.watcher?.close();
      this.watcher = null;
    });
  }

  private async checkExternalChange(): Promise<void> {
    let text: string;
    try {
      text = await this.readFileText();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Mid-rename by another program, or deleted. Report it; a later event
        // re-checks when the file comes back.
        this.fileError = this.dirty ? this.fileError : 'config.json is missing';
        this.emit();
        return;
      }
      throw err;
    }
    if (text === this.baseText) {
      if (this.fileError === 'config.json is missing') {
        this.fileError = null;
        this.emit();
      }
      return; // the editor's own write, or no real change
    }
    if (this.dirty) {
      this.enterConflict(text);
      return;
    }
    this.adoptFileText(text);
    this.emit();
  }

  private enterConflict(fileText: string): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.conflict = { fileText };
    try {
      parseAndValidate(fileText);
    } catch (err) {
      this.conflict.fileError = (err as Error).message;
    }
    this.emit();
  }

  /** Take the file's text as the new base. An invalid file blocks editing but keeps the last good config on screen. */
  private adoptFileText(text: string): void {
    this.baseText = text;
    try {
      this.config = parseAndValidate(text);
      this.fileError = null;
      this.reformatPending = serializeConfig(this.config) !== text;
    } catch (err) {
      this.fileError = (err as Error).message;
    }
  }
}

function parseAndValidate(text: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  return validateConfig(parsed);
}
