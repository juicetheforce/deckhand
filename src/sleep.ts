import * as sessionLock from './services/session-lock.js';

/**
 * Deck sleep: who is dark, and why, for every deck at once.
 *
 * - **On lock**: while logind says the session is locked or not active, every
 *   Stream Deck is at brightness 0. Not a virtual deck: the lock screen and the
 *   monitor's power saving already cover its screen. An unreadable state is not a
 *   lock: a deck left dark because logind went away is the worse failure, so
 *   this is the opposite of a virtual deck's touches, which fail closed.
 * - **Sleep all decks** (`sleep.all`): every deck, virtual ones too, dimmed to a
 *   level, or off.
 * - **Idle**: as the compositor reports it (services/idle.ts), every Stream Deck
 *   dimmed, then dark. A virtual deck has its monitor's own power saving.
 *
 * The images are kept, so waking is one brightness write. **The first press on
 * a dark deck only wakes it, its release swallowed too**; on a dimmed one it
 * runs its key as it wakes them. A press on any deck ends Sleep all decks for
 * all of them; a press during a lock wakes only that deck, until the lock ends,
 * and so does a press while the desktop is idle.
 *
 * **The one timer here is one-shot, never at rest.** A press that wakes a deck
 * while the desktop is still idle starts a deadline to put it back, because a
 * press that types nothing is not input to the compositor, which would otherwise
 * leave the deck lit until the next idle. It is cancelled when the desktop reports
 * resumed, restarted by another deck press, and overridden by a lock.
 */

export type SleepAll = { mode: 'dim'; level: number } | { mode: 'off' };
export type SleepReason = 'lock' | 'idle' | 'all';
export type IdleLevel = 'dim' | 'sleep';
export type PressOutcome = 'none' | 'woke' | 'swallow';

/** What this needs of a deck session. */
export interface Sleeper {
  readonly serial: string;
  /** Whether it can go dark at all. */
  canDim(): boolean;
  /** Whether a lock or the desktop going idle darkens it: not a virtual deck, whose monitor has its own power saving. */
  followsDesktop(): boolean;
  setBrightness(value: number): Promise<void>;
  currentBrightness(): number;
  /** The level to show, or null for its own brightness. */
  applySleep(level: number | null): void;
  /** A key showing Sleep all decks' state may need drawing again. */
  invalidateByType(types: string[]): void;
}

class SleepCoordinator {
  private decks = new Set<Sleeper>();
  private onLock = true;
  private all: SleepAll | null = null;
  /** Decks woken by a press during the current lock. */
  private wokenFromLock = new Set<string>();
  private idle: IdleLevel | null = null;
  /** Settings' "Dim to", a percent. */
  private dimTo = 20;
  /** How long a deck woken while idle stays lit: the shortest idle timeout set. */
  private redimMs = 0;
  /** Decks woken by a press while the desktop is idle, until the deadline or it resumes. */
  private wokenFromIdle = new Set<string>();
  private redim: NodeJS.Timeout | null = null;

  constructor() {
    sessionLock.onLockChange(() => {
      if (!this.locked()) this.wokenFromLock.clear();
      // A lock overrides the deadline; whoever it woke goes back with the rest.
      this.cancelRedim();
      this.wokenFromIdle.clear();
      this.apply();
    });
  }

  private locked(): boolean {
    const state = sessionLock.lockState();
    return state === 'locked' || state === 'inactive';
  }

  private lockApplies(deck: Sleeper): boolean {
    return deck.followsDesktop() && this.onLock && this.locked() && !this.wokenFromLock.has(deck.serial);
  }

  private idleLevel(deck: Sleeper): number | null {
    if (this.idle === null || !deck.followsDesktop() || this.wokenFromIdle.has(deck.serial)) return null;
    return this.idle === 'sleep' ? 0 : this.dimTo;
  }

  private allLevel(): number | null {
    if (this.all === null) return null;
    return this.all.mode === 'off' ? 0 : this.all.level;
  }

  /** Why a deck is dark or dimmed now: whichever makes it darkest, a lock first. */
  reason(deck: Sleeper): SleepReason | null {
    if (!deck.canDim()) return null;
    if (this.lockApplies(deck)) return 'lock';
    const idle = this.idleLevel(deck);
    const all = this.allLevel();
    if (idle === null) return all === null ? null : 'all';
    return all === null || idle <= all ? 'idle' : 'all';
  }

  /** The level a deck should show now, or null for its own brightness. */
  levelFor(deck: Sleeper): number | null {
    const reason = this.reason(deck);
    if (reason === null) return null;
    if (reason === 'lock') return 0;
    return reason === 'idle' ? this.idleLevel(deck) : this.allLevel();
  }

  add(deck: Sleeper): void {
    this.decks.add(deck);
  }

  remove(deck: Sleeper): void {
    this.decks.delete(deck);
  }

  /** A connected deck, for a key that acts on another one (Brightness's target). */
  deck(serial: string): Sleeper | undefined {
    for (const deck of this.decks) if (deck.serial === serial) return deck;
    return undefined;
  }

  /** Keys of these types on every deck may need drawing again. */
  invalidateByType(types: string[]): void {
    for (const deck of this.decks) deck.invalidateByType(types);
  }

  /** Settings' "Sleep when the screen locks"; read from the config on every load. */
  setOnLock(on: boolean): void {
    if (on === this.onLock) return;
    this.onLock = on;
    this.apply();
  }

  /** The desktop's idle state, as the compositor says it. */
  setIdle(level: IdleLevel | null): void {
    if (level === this.idle) return;
    this.idle = level;
    if (level === null) {
      this.cancelRedim();
      this.wokenFromIdle.clear();
    }
    this.apply();
  }

  /** Settings' "Dim to", and how long a deck woken while idle stays lit. */
  setIdleSettings(dimTo: number, redimMs: number): void {
    this.dimTo = dimTo;
    this.redimMs = redimMs;
    this.apply();
  }

  private cancelRedim(): void {
    if (this.redim) clearTimeout(this.redim);
    this.redim = null;
  }

  private startRedim(): void {
    this.cancelRedim();
    if (this.redimMs <= 0 || this.locked()) return;
    this.redim = setTimeout(() => {
      this.redim = null;
      this.wokenFromIdle.clear();
      this.apply();
    }, this.redimMs);
    this.redim.unref();
  }

  /** A deck's key went down: whether that wakes anything, and whether the key still runs. */
  press(deck: Sleeper): PressOutcome {
    const reason = this.reason(deck);
    const dark = this.levelFor(deck) === 0;
    const wasAll = this.all !== null;
    // Another press while one is counting down: it starts again.
    if (this.redim) this.startRedim();
    if (reason === null && !wasAll) return 'none';
    if (this.lockApplies(deck)) this.wokenFromLock.add(deck.serial);
    if (this.idleLevel(deck) !== null) {
      this.wokenFromIdle.add(deck.serial);
      this.startRedim();
    }
    this.setAll(null);
    return dark ? 'swallow' : 'woke';
  }

  toggleAll(next: SleepAll): void {
    this.setAll(this.all ? null : next);
  }

  allActive(): boolean {
    return this.all !== null;
  }

  private setAll(next: SleepAll | null): void {
    const changed = (this.all === null) !== (next === null);
    this.all = next;
    this.apply();
    if (changed) this.invalidateByType(['sleep.all']);
  }

  private apply(): void {
    for (const deck of this.decks) deck.applySleep(this.levelFor(deck));
  }
}

export const sleep = new SleepCoordinator();
