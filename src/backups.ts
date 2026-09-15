import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackupStatus } from './control/protocol.js';

/**
 * Rolling config backups (docs/scope.md §5).
 *
 * When a reload succeeds with a changed config, the config it replaces — the
 * previous good one, as file text — is saved here, unless the newest backup is
 * younger than BACKUP_SPACING_MS. A burst of editor autosaves therefore leaves
 * one snapshot from before the burst, instead of pushing every older backup
 * out in seconds. The newest BACKUP_KEEP are kept.
 *
 * Backups live in the state directory, not next to config.json: they are
 * state, and the config directory may be synced or kept in dotfiles. Nothing
 * written here can trigger a config reload — the config watcher is not
 * recursive and filters on the file name (checked in scripts/smoke-backups.mjs).
 *
 * A failed backup is logged and never fails the reload it follows.
 */

export const STATE_DIR =
  process.env.DECKHAND_STATE_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'deckhand');

export const BACKUP_DIR = path.join(STATE_DIR, 'backups');

export const BACKUP_KEEP = 20;
export const BACKUP_SPACING_MS = 5 * 60 * 1000;

/** config-2026-09-14T22-31-02.114Z.json — an ISO time with ":" replaced, so names sort by time. */
const BACKUP_NAME = /^config-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.json$/;

function nameFor(time: number): string {
  return `config-${new Date(time).toISOString().replace(/:/g, '-')}.json`;
}

/** The time in a backup's name, or null if the name is not one Deckhand wrote. */
function timeOf(name: string): number | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  // Put the ":" back in the time part only: 2026-09-14T22-31-02.114Z -> 2026-09-14T22:31:02.114Z
  const [date, time] = match[1].split('T');
  const parsed = Date.parse(`${date}T${time.replace(/-/g, ':')}`);
  return Number.isNaN(parsed) ? null : parsed;
}

export type BackupOutcome = 'saved' | 'unchanged' | 'too-recent' | 'duplicate' | 'failed';

export interface BackupOptions {
  dir?: string;
  keep?: number;
  spacingMs?: number;
  /** Milliseconds since the epoch. Replaced by the smoke test to fake the passage of time. */
  now?: () => number;
}

export class ConfigBackups {
  readonly dir: string;
  private readonly keep: number;
  private readonly spacingMs: number;
  private readonly now: () => number;
  private count = 0;
  private newest: number | null = null;
  private error: string | undefined;
  /** Backups run one at a time, so two reloads in quick succession cannot prune against each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BackupOptions = {}) {
    this.dir = options.dir ?? BACKUP_DIR;
    this.keep = options.keep ?? BACKUP_KEEP;
    this.spacingMs = options.spacingMs ?? BACKUP_SPACING_MS;
    this.now = options.now ?? Date.now;
  }

  status(): BackupStatus {
    const status: BackupStatus = {
      dir: this.dir,
      count: this.count,
      newest: this.newest === null ? null : new Date(this.newest).toISOString(),
    };
    if (this.error !== undefined) status.error = this.error;
    return status;
  }

  /** Read what is already on disk, so status is right before the first reload. */
  init(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.refresh();
      } catch (err) {
        this.error = `cannot read ${this.dir}: ${(err as Error).message}`;
        console.error(`[backups] ${this.error}`);
      }
    });
  }

  /**
   * Call after a reload succeeds. previousText is the file text of the config
   * being replaced; nextText is what was just loaded.
   */
  afterGoodReload(previousText: string, nextText: string): Promise<BackupOutcome> {
    return this.enqueue(() => this.snapshot(previousText, nextText));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async snapshot(previousText: string, nextText: string): Promise<BackupOutcome> {
    if (previousText === nextText) return 'unchanged';
    try {
      const existing = await this.list();
      const newest = existing.at(-1);
      if (newest !== undefined) {
        const age = this.now() - newest.time;
        // A negative age means the clock went backwards; treat it as old
        // rather than refusing to back up until the clock catches up.
        if (age >= 0 && age < this.spacingMs) return 'too-recent';
        const newestText = await fs.readFile(path.join(this.dir, newest.name), 'utf8');
        if (newestText === previousText) return 'duplicate';
      }

      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const name = nameFor(this.now());
      // Written under a name that is not a backup name, then renamed, so a
      // half-written file is never mistaken for a backup.
      const temporary = path.join(this.dir, `.${name}.${process.pid}.tmp`);
      try {
        await fs.writeFile(temporary, previousText, { mode: 0o600 });
        await fs.rename(temporary, path.join(this.dir, name));
      } catch (err) {
        await fs.rm(temporary, { force: true });
        throw err;
      }

      await this.prune();
      await this.refresh();
      this.error = undefined;
      console.log(`[backups] saved the previous config as ${name} (${this.count} kept)`);
      return 'saved';
    } catch (err) {
      this.error = (err as Error).message;
      console.error(`[backups] could not back up the previous config: ${this.error}`);
      return 'failed';
    }
  }

  /** Backups Deckhand wrote, oldest first. A missing directory is no backups. */
  private async list(): Promise<Array<{ name: string; time: number }>> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const backups: Array<{ name: string; time: number }> = [];
    for (const name of names) {
      const time = timeOf(name);
      if (time !== null) backups.push({ name, time });
    }
    return backups.sort((a, b) => a.time - b.time);
  }

  /** Delete the oldest backups beyond the limit. Files with other names are never touched. */
  private async prune(): Promise<void> {
    const backups = await this.list();
    for (const old of backups.slice(0, Math.max(0, backups.length - this.keep))) {
      await fs.rm(path.join(this.dir, old.name), { force: true });
    }
  }

  private async refresh(): Promise<void> {
    const backups = await this.list();
    this.count = backups.length;
    this.newest = backups.at(-1)?.time ?? null;
  }
}
