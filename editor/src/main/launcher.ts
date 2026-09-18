/**
 * The editor as a launcher (Ship piece 2, scope §7): a thing the maintainer opens, not a
 * resident process. Closing the window puts the editor in the tray and hands
 * back everything an open editor holds — config.json and its watcher, the
 * daemon socket, the icon watchers — so what is left at rest is the main
 * process and the tray icon. Opening again, from the tray or by launching the
 * editor a second time, takes them back and makes a new window.
 *
 * No Electron here: main.ts passes the pieces in, so the lifecycle — and the
 * races in it, such as a click on the tray while a close is still writing
 * edits — is tested in plain Node (test/launcher.test.ts), and in real
 * Electron by scripts/check-tray.mjs.
 */

/** What the launcher needs of a window. */
export interface LauncherWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  /** Called once the window has closed. */
  onClosed(listener: () => void): void;
}

export interface LauncherDeps {
  /** Take what an open editor holds: open config.json, connect to the daemon. */
  acquire(): Promise<void>;
  /** Hand it all back, writing unsaved edits and preferences first. */
  release(): Promise<void>;
  createWindow(): LauncherWindow;
  /** Whether closing the window keeps the editor in the tray (a preference; on unless turned off). */
  closeToTray(): Promise<boolean>;
  /**
   * Whether there is a tray to come back from. If the icon could not be
   * created, closing the window quits: a running editor with no window and
   * nothing to click is the one outcome that must not happen.
   */
  trayAlive(): boolean;
  /** Quit the application (app.quit(), whose before-quit writes unsaved edits). */
  quit(): void;
}

export class Launcher {
  private window: LauncherWindow | null = null;
  /** Whether acquire() has run without a release() since. */
  private holding = false;
  private quitting = false;
  /**
   * open() and the work after a close run one at a time, in order. A tray
   * click during a release waits for it, then acquires again — never a
   * window on a store that is being closed underneath it.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LauncherDeps) {}

  /** Open the editor, or bring its window forward if it is open. The tray, a second launch and startup all come here. */
  open(): Promise<void> {
    return this.inTurn(async () => {
      if (this.quitting) return;
      const current = this.window;
      if (current && !current.isDestroyed()) {
        if (current.isMinimized()) current.restore();
        current.show();
        current.focus();
        return;
      }
      if (!this.holding) {
        await this.deps.acquire();
        this.holding = true;
      }
      const created = this.deps.createWindow();
      this.window = created;
      created.onClosed(() => this.closed(created));
    });
  }

  /** Quit for good: the tray's Quit. */
  quit(): void {
    this.quitting = true;
    this.deps.quit();
  }

  /** For checks: is a window open, and is the editor holding its resources. */
  state(): { windowOpen: boolean; holding: boolean } {
    return { windowOpen: this.window !== null && !this.window.isDestroyed(), holding: this.holding };
  }

  private closed(which: LauncherWindow): void {
    if (this.window === which) this.window = null;
    void this.inTurn(async () => {
      // Opened again before this turn came round, or quitting anyway.
      if (this.quitting || this.window) return;
      if (this.deps.trayAlive() && (await this.deps.closeToTray())) {
        if (this.holding) {
          await this.deps.release();
          this.holding = false;
        }
      } else {
        this.quit();
      }
    });
  }

  private inTurn(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    // A failed step must not stop the ones after it.
    this.queue = run.catch((err) => console.error(`[launcher] ${err instanceof Error ? err.message : String(err)}`));
    return run;
  }
}
