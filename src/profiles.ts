import { resolveProfile, startProfileOf } from './config.js';
import type { DeckSession } from './deck.js';
import type { Config, LayoutDef } from './types.js';

/** Thrown by switchTo() for a profile that does not exist, so callers can tell it from other failures. */
export class ProfileNotFoundError extends Error {
  constructor(ref: string) {
    super(`no profile with ID or name "${ref}"`);
  }
}

/**
 * Which profile is active, and which profile's layout each deck is showing.
 *
 * Switching profile changes every deck the new profile has a layout for. A
 * deck it has no layout for keeps what it was showing, so a
 * deck can be showing a different profile from the active one.
 *
 * Kept out of index.ts so the smoke test can drive it without starting the
 * daemon, and so the control socket can call the same switchTo().
 */
export class Profiles {
  private config: Config;
  private active: string;
  /**
   * The profile whose layout each deck last showed, by serial. Kept after a
   * deck disconnects, so a replugged deck comes back as it was. In memory
   * only: a restart starts again from startProfile.
   */
  private shown = new Map<string, string>();
  /** Called when the active profile, or the profile any deck shows, changes. */
  private onChange: () => void = () => undefined;

  constructor(config: Config) {
    this.config = config;
    this.active = startProfileOf(config);
  }

  /** For the control socket's "state" event. */
  setChangeListener(listener: () => void): void {
    this.onChange = listener;
  }

  /** The active profile's ID. */
  activeProfile(): string {
    return this.active;
  }

  /** A profile's display name, or null when it has none. */
  profileName(id: string): string | null {
    return this.config.profiles[id]?.name ?? null;
  }

  /** The profile whose layout a deck last showed this run, if any. */
  shownProfileFor(serial: string): string | undefined {
    return this.shown.get(serial);
  }

  /** Every deck serial some profile has a layout for. */
  configuredSerials(): Set<string> {
    const serials = new Set<string>();
    for (const profile of Object.values(this.config.profiles)) {
      for (const serial of Object.keys(profile.layouts)) serials.add(serial);
    }
    return serials;
  }

  /** "name (id)", or just the ID when the profile has no name. For logs. */
  private describe(id: string): string {
    const name = this.config.profiles[id]?.name;
    return name && name !== id ? `"${name}" (${id})` : `"${id}"`;
  }

  /**
   * The profile whose layout a deck should show, first match wins:
   *   1. the active profile
   *   2. the profile this deck last showed this run
   *   3. startProfile
   *   4. the first profile with a layout for this deck
   * Returns null if no profile has a layout for this deck.
   *
   * Used when a deck attaches and on every config reload.
   */
  chooseProfileFor(serial: string): string | null {
    const hasLayout = (id: string | undefined): id is string =>
      id !== undefined && this.config.profiles[id]?.layouts[serial] !== undefined;

    const preferred = [this.active, this.shown.get(serial), startProfileOf(this.config)];
    for (const id of preferred) {
      if (hasLayout(id)) return id;
    }
    for (const id of Object.keys(this.config.profiles)) {
      if (hasLayout(id)) return id;
    }
    return null;
  }

  /** A profile's layout for one deck. Only call with an ID from chooseProfileFor(). */
  layoutFor(profileId: string, serial: string): LayoutDef {
    return this.config.profiles[profileId].layouts[serial];
  }

  /** Record that a deck is now showing a profile's layout. */
  markShown(serial: string, profileId: string): void {
    this.shown.set(serial, profileId);
  }

  /**
   * Make a profile active, by ID or name. Every connected deck it has a layout
   * for goes to that layout's start page; the others are left alone.
   * Switching to the profile that is already active does nothing. Returns
   * whether the active profile changed.
   */
  async switchTo(ref: string, sessions: Map<string, DeckSession>): Promise<boolean> {
    const id = resolveProfile(this.config, ref);
    if (id === null) throw new ProfileNotFoundError(ref);
    if (id === this.active) return false;

    // Held here, not re-read inside the loop, so a config reload that lands
    // during one of the awaits below cannot pull the profile out from under it.
    const profile = this.config.profiles[id];
    // Set before any await, so a deck that attaches mid-switch gets the new profile.
    this.active = id;
    this.onChange();
    console.log(`[profiles] switched to ${this.describe(id)}`);

    for (const [serial, session] of sessions) {
      const layout = profile.layouts[serial];
      if (!layout) continue; // not covered: keeps its current layout
      this.shown.set(serial, id);
      await session.setLayout(layout);
    }
    return true;
  }

  /**
   * Apply a reloaded config to the open sessions. Each deck gets the profile
   * chooseProfileFor() picks. A deck that stays on the same profile keeps its
   * page if the page still exists; a deck that moves to another profile goes to
   * the start page. A deck no profile has a layout for is closed and removed
   * from `sessions`.
   */
  async applyReload(next: Config, sessions: Map<string, DeckSession>): Promise<void> {
    this.config = next;
    this.onChange();

    if (!next.profiles[this.active]) {
      const fallback = startProfileOf(next);
      console.log(
        `[profiles] active profile "${this.active}" is no longer in config; using ${this.describe(fallback)}`,
      );
      this.active = fallback;
    }

    for (const [serial, session] of sessions) {
      const id = this.chooseProfileFor(serial);
      if (id === null) {
        console.log(`[main] deck ${serial} removed from config, detaching`);
        await session.close();
        sessions.delete(serial);
        this.onChange();
        continue;
      }
      const keepPage = this.shown.get(serial) === id;
      this.shown.set(serial, id);
      await session.reconfigure(
        next.decks?.[serial] ?? {},
        next.profiles[id].layouts[serial],
        next.defaults ?? {},
        keepPage,
      );
    }
  }
}
