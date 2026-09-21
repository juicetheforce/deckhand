/**
 * Deleting a profile, as one pure function that both
 * the confirmation and the edit run — the confirmation on a copy — so what the
 * confirmation names is what the delete does. Page delete once had the two
 * decide separately, and they disagreed (docs/code-state.md, B1).
 *
 * What a delete does:
 * - Refused for the last profile: the daemon refuses a config with none.
 * - Keys in the other profiles that switch to it lose that action and keep
 *   their icon and label, as page delete does; in a multi, only that step
 *   goes. A `profile` action resolves across the whole config, so every
 *   profile and deck is looked at. A key left pointing at a missing profile
 *   would fail on every press.
 * - `startProfile` moves to the first remaining profile if it named this one:
 *   the daemon refuses one that does not resolve.
 * - A deck that only this profile covered gets a fresh, one-page layout in
 *   the start profile — "a deck with nothing on it is worse than a deck with
 *   a blank page". The start profile is the one the daemon falls back to when
 *   the active profile is deleted, so the deck shows the blank page at once
 *   instead of being detached.
 *
 * Pure, and imports nothing that touches Node: the renderer builds the
 * confirmation from planProfileDeletion(), the main process applies
 * deleteProfile().
 */
import { resolveProfile, startProfileOf } from '../../../src/config-common.js';
import type { ActionDef, Config, LayoutDef, PageDef } from '../../../src/types.js';
import { multiSteps, pagesWithNoWayOff, targetsProfile } from './links.js';

/** A key, somewhere in the config, that switches to the profile being deleted. */
export interface ProfileLink {
  profile: string;
  serial: string;
  page: string;
  index: number;
  /** Which of the button's two actions it is. */
  where: 'action' | 'onRelease';
  /** The switch is one step of a multi action, not the whole action. */
  inMulti: boolean;
}

/** A page, by where it lives. */
export interface PageRef {
  profile: string;
  serial: string;
  page: string;
}

/** What a delete changed besides removing the profile and its links. */
export interface DeletionResult {
  /** The profile `startProfile` moved to, or null if it did not move. */
  startProfileMovesTo: string | null;
  /** Decks only this profile covered, which got a fresh layout… */
  freshLayouts: string[];
  /** …in this profile (the start profile after the delete). */
  freshLayoutsIn: string;
}

export interface ProfileDeletion extends DeletionResult {
  /** Keys in other profiles that lose their switch to this profile. */
  links: ProfileLink[];
  /** Pages that had a key leaving them and will have none (scope §10's guard). */
  stranded: PageRef[];
}

/**
 * Every key outside `profileId` that switches to it. Keys inside it are left
 * out: they are deleted with it. Call before the profile is removed — a link
 * written as its name stops resolving once it is gone.
 */
export function profileLinks(config: Config, profileId: string): ProfileLink[] {
  const found: ProfileLink[] = [];
  for (const [profile, profileDef] of Object.entries(config.profiles)) {
    if (profile === profileId) continue;
    for (const [serial, layout] of Object.entries(profileDef.layouts)) {
      for (const [page, pageDef] of Object.entries(layout.pages)) {
        for (const [key, button] of Object.entries(pageDef.buttons)) {
          for (const where of ['action', 'onRelease'] as const) {
            const action = button[where];
            if (targetsProfile(action, config, profileId)) {
              found.push({ profile, serial, page, index: Number(key), where, inMulti: false });
            } else if (multiSteps(action)?.some((step) => targetsProfile(step, config, profileId))) {
              found.push({ profile, serial, page, index: Number(key), where, inMulti: true });
            }
          }
        }
      }
    }
  }
  return found;
}

/** Take one action off a key; a key left with nothing on it is removed, since {} is an empty slot anyway. */
function removeFromButton(page: PageDef, index: number, where: 'action' | 'onRelease'): void {
  const key = String(index);
  const button = page.buttons[key];
  if (!button) return;
  delete button[where];
  if (Object.keys(button).length === 0) delete page.buttons[key];
}

/**
 * Delete a profile, in place, by the rules at the top of this file. Throws for
 * an unknown profile or the last one. `newLayout` makes the fresh layout a deck
 * gets when nothing else covers it; the editor's makes one named page.
 */
export function deleteProfile(config: Config, profileId: string, newLayout: () => LayoutDef): DeletionResult {
  if (!Object.prototype.hasOwnProperty.call(config.profiles, profileId)) throw new Error(`no profile with ID "${profileId}"`);
  const remaining = Object.keys(config.profiles).filter((id) => id !== profileId);
  if (remaining.length === 0) throw new Error('the last profile cannot be deleted: Deckhand needs at least one');

  // Before the delete, while a link written as the name still resolves.
  for (const link of profileLinks(config, profileId)) {
    const page = config.profiles[link.profile].layouts[link.serial].pages[link.page];
    const action = page.buttons[String(link.index)]?.[link.where] as ActionDef | undefined;
    if (!action) continue;
    const steps = link.inMulti ? multiSteps(action) : null;
    if (steps) {
      const kept = steps.filter((step) => !targetsProfile(step, config, profileId));
      if (kept.length === 0) removeFromButton(page, link.index, link.where);
      else action.steps = kept;
    } else {
      removeFromButton(page, link.index, link.where);
    }
  }

  const covered = Object.keys(config.profiles[profileId].layouts);
  const startProfileBefore = config.startProfile;
  delete config.profiles[profileId];

  if (config.startProfile !== undefined && resolveProfile(config, config.startProfile) === null) {
    config.startProfile = remaining[0];
  }

  // After startProfile has settled: the fresh layouts go where the daemon will look.
  const home = startProfileOf(config);
  const freshLayouts: string[] = [];
  for (const serial of covered) {
    const stillCovered = Object.values(config.profiles).some((p) => Object.prototype.hasOwnProperty.call(p.layouts, serial));
    if (stillCovered) continue;
    config.profiles[home].layouts[serial] = newLayout();
    freshLayouts.push(serial);
  }
  return { startProfileMovesTo: config.startProfile !== startProfileBefore ? (config.startProfile ?? null) : null, freshLayouts, freshLayoutsIn: home };
}

/** Every page with no way off, across the config, as "profile serial page" keys. */
function strandedPages(config: Config): Set<string> {
  const out = new Set<string>();
  for (const [profile, profileDef] of Object.entries(config.profiles)) {
    for (const [serial, layout] of Object.entries(profileDef.layouts)) {
      for (const page of pagesWithNoWayOff(layout)) out.add(JSON.stringify([profile, serial, page]));
    }
  }
  return out;
}

/**
 * What deleting `profileId` would do, found by doing it to a copy — so it
 * cannot disagree with deleteProfile(). Throws as deleteProfile() does.
 */
export function planProfileDeletion(config: Config, profileId: string): ProfileDeletion {
  const links = profileLinks(config, profileId);
  const before = strandedPages(config);
  const after = structuredClone(config);
  // A stand-in layout: one page, so the guard never flags it, as a real one.
  const result = deleteProfile(after, profileId, () => ({ pages: { fresh: { buttons: {} } } }));
  const stranded = [...strandedPages(after)]
    .filter((key) => !before.has(key))
    .map((key) => {
      const [profile, serial, page] = JSON.parse(key) as [string, string, string];
      return { profile, serial, page };
    });
  return { ...result, links, stranded };
}
