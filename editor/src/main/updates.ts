import { isNewer, NO_UPDATE_STATE, releaseFrom, type UpdateState } from '../shared/updates.js';

/**
 * The update check: one request to GitHub for the latest release, made once
 * each time the editor's window opens (main.ts createWindow), and when the
 * person turns "Check for updates" on. No timer: a window left open is not
 * asked again, and an editor in the tray asks nothing until it is opened.
 * The daemon never does this.
 *
 * What is sent (PRIVACY.md): an HTTPS GET to api.github.com for this
 * repository's latest release, with "Deckhand" as its User-Agent (GitHub
 * requires one) and nothing else — no version, no identifier. GitHub sees
 * the address it comes from, as for any request. Nothing is downloaded or
 * installed: the pill's panel shows the release's own update line to copy,
 * and links to its page.
 */

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/juicetheforce/deckhand/releases/latest';
/** GitHub answers in well under a second; past this the check counts as failed, and the next opening asks again. */
const DEADLINE_MS = 10_000;
/** The answer is a few kilobytes; anything far larger is not GitHub's answer. */
const MAX_ANSWER_BYTES = 1024 * 1024;

export interface UpdateCheckerOptions {
  /** Where to ask: LATEST_RELEASE_URL, or a check's own server; null asks nothing (a check that does not test this). */
  url: string | null;
  /** The installed version (about.ts's editorVersion), or null in a checkout — then nothing is asked. */
  version: () => string | null;
  /** The "Check for updates" switch, as stored. */
  enabled: () => Promise<boolean>;
  /** The version "Not now" was last pressed for, as stored; null if never. */
  dismissed: () => Promise<string | null>;
  /** Told every change, to show it. */
  onChange: (state: UpdateState) => void;
}

export class UpdateChecker {
  private current: UpdateState = { ...NO_UPDATE_STATE };
  private running: Promise<void> | null = null;

  constructor(private readonly options: UpdateCheckerOptions) {}

  state(): UpdateState {
    return this.current;
  }

  /** The window opened, or the switch was turned on: ask once, unless a check is running already or the switch is off. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The switch changed: off forgets what was found and asks nothing; on asks now. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.set({ ...NO_UPDATE_STATE, enabled: false, status: 'off' });
      return;
    }
    this.set({ ...this.current, enabled: true, status: this.current.status === 'off' ? 'idle' : this.current.status });
    await this.check();
  }

  private async run(): Promise<void> {
    if (!(await this.options.enabled())) {
      this.set({ ...NO_UPDATE_STATE, enabled: false, status: 'off' });
      return;
    }
    const installed = this.options.version();
    // A checkout has no version to compare: nothing is asked. Nor in a check that names no server.
    if (installed === null || this.options.url === null) {
      this.set({ ...NO_UPDATE_STATE });
      return;
    }
    this.set({ ...this.current, enabled: true, status: 'checking' });
    try {
      const response = await fetch(this.options.url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Deckhand' },
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_ANSWER_BYTES) throw new Error('the answer is too large');
      const release = releaseFrom(JSON.parse(text));
      if (!release) throw new Error('the answer names no release');
      // Switched off while it was asked: what it found is not shown.
      if (!this.current.enabled) return;
      const dismissed = await this.options.dismissed();
      this.set(
        isNewer(release.version, installed)
          ? {
              ...NO_UPDATE_STATE,
              status: 'available',
              latest: release.version,
              url: release.url,
              whatsNew: release.whatsNew,
              updateLine: release.updateLine,
              installed,
              // It comes back only for a version newer than the one set aside.
              hidden: dismissed !== null && !isNewer(release.version, dismissed),
            }
          : { ...NO_UPDATE_STATE, status: 'current' },
      );
    } catch (err) {
      console.error(`[updates] could not check for an update: ${(err as Error).message}`);
      if (this.current.enabled) this.set({ ...NO_UPDATE_STATE, status: 'failed' });
    }
  }

  /** "Not now": no pill for this version. The caller stores the version. */
  hide(): void {
    if (this.current.status === 'available') this.set({ ...this.current, hidden: true });
  }

  private set(next: UpdateState): void {
    this.current = next;
    this.options.onChange(next);
  }
}
