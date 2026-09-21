import type { KeyFailure } from './control/protocol.js';
import type { ButtonDef, Config } from './types.js';

/**
 * Keys whose last press failed. The deck draws
 * a badge on them, and the control socket's status lists them, so the editor's
 * grid shows the same.
 *
 * What clears a mark, and what does not:
 * - the next press of that key that succeeds clears it;
 * - editing that key clears it — it is a different key now, not yet tried;
 * - no timer, and not a page or profile switch: a broken key stays marked until
 *   it works, on whichever page it is.
 *
 * Held for the daemon, not per deck session, so a mark survives unplugging and
 * replugging the deck. It is memory only: a daemon restart clears every mark.
 *
 * Cost: nothing while no key has failed; one entry per failed key otherwise.
 * No timers — a mark is added or removed only by a press or a config reload.
 */

interface Entry extends KeyFailure {
  /** The button as it was when it failed, to notice when it has been edited. */
  button: string;
}

function slot(profile: string, page: string, key: number): string {
  return `${profile}\u0000${page}\u0000${key}`;
}

export class KeyFailures {
  private readonly byDeck = new Map<string, Map<string, Entry>>();

  /** Mark a key failed. Returns whether anything changed (a new mark, or a different error). */
  mark(serial: string, failure: KeyFailure, button: ButtonDef | undefined): boolean {
    let deck = this.byDeck.get(serial);
    if (!deck) {
      deck = new Map();
      this.byDeck.set(serial, deck);
    }
    const key = slot(failure.profile, failure.page, failure.key);
    const before = deck.get(key);
    deck.set(key, { ...failure, button: JSON.stringify(button ?? null) });
    return before === undefined || before.error !== failure.error;
  }

  /** Clear a key's mark. Returns whether it had one. */
  clear(serial: string, profile: string, page: string, key: number): boolean {
    const deck = this.byDeck.get(serial);
    if (!deck?.delete(slot(profile, page, key))) return false;
    if (deck.size === 0) this.byDeck.delete(serial);
    return true;
  }

  has(serial: string, profile: string, page: string, key: number): boolean {
    return this.byDeck.get(serial)?.has(slot(profile, page, key)) ?? false;
  }

  /** A deck's failed keys, for the control socket's status. */
  forDeck(serial: string): KeyFailure[] {
    const deck = this.byDeck.get(serial);
    if (!deck) return [];
    return [...deck.values()].map(({ profile, page, key, error }) => ({ profile, page, key, error }));
  }

  /**
   * After a config reload: drop the mark of every key that was edited or
   * removed — its button is no longer the one that failed. Returns whether any
   * mark went.
   */
  prune(config: Config): boolean {
    let changed = false;
    for (const [serial, deck] of this.byDeck) {
      for (const [key, entry] of deck) {
        const button = config.profiles[entry.profile]?.layouts[serial]?.pages[entry.page]?.buttons[String(entry.key)];
        if (JSON.stringify(button ?? null) !== entry.button) {
          deck.delete(key);
          changed = true;
        }
      }
      if (deck.size === 0) this.byDeck.delete(serial);
    }
    return changed;
  }
}
