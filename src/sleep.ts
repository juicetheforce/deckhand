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
 *
 * The images are kept, so waking is one brightness write. **The first press on
 * a dark deck only wakes it, its release swallowed too**; on a dimmed one it
 * runs its key as it wakes them. A press on any deck ends Sleep all decks for
 * all of them; a press during a lock wakes only that deck, until the lock ends.
 * Events only: no timer here.
 */

export type SleepAll = { mode: 'dim'; level: number } | { mode: 'off' };
export type SleepReason = 'lock' | 'all';
export type PressOutcome = 'none' | 'woke' | 'swallow';

/** What this needs of a deck session. */
export interface Sleeper {
  readonly serial: string;
  /** Whether it can go dark at all. */
  canDim(): boolean;
  /** Whether a lock darkens it. */
  sleepsOnLock(): boolean;
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

  constructor() {
    sessionLock.onLockChange(() => {
      if (!this.locked()) this.wokenFromLock.clear();
      this.apply();
    });
  }

  private locked(): boolean {
    const state = sessionLock.lockState();
    return state === 'locked' || state === 'inactive';
  }

  reason(deck: Sleeper): SleepReason | null {
    if (!deck.canDim()) return null;
    if (deck.sleepsOnLock() && this.onLock && this.locked() && !this.wokenFromLock.has(deck.serial)) return 'lock';
    return this.all ? 'all' : null;
  }

  /** The level a deck should show now, or null for its own brightness. */
  levelFor(deck: Sleeper): number | null {
    const reason = this.reason(deck);
    if (reason === null) return null;
    return reason === 'lock' || this.all?.mode !== 'dim' ? 0 : this.all.level;
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

  /** A deck's key went down: whether that wakes anything, and whether the key still runs. */
  press(deck: Sleeper): PressOutcome {
    const reason = this.reason(deck);
    const all = this.all;
    if (reason === null && all === null) return 'none';
    if (reason === 'lock') this.wokenFromLock.add(deck.serial);
    this.setAll(null);
    if (reason === 'lock') return 'swallow';
    return reason === 'all' && all?.mode === 'off' ? 'swallow' : 'woke';
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
