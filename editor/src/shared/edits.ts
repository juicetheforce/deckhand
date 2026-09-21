/**
 * The edits the editor can make to a config, as plain data. The renderer
 * builds them; the main process applies them (src/main/config-document.ts).
 *
 * Types only, importing nothing that touches Node: the renderer imports this.
 */
import type { ActionDef } from '../../../src/types.js';
import type { ButtonWrite } from './bulk.js';
import type { PairIconField } from './icons.js';

export interface ButtonLocation {
  profile: string;
  serial: string;
  page: string;
  index: number;
}

export type Edit =
  /** Set the key's press action, keeping icon, label and anything else on it. */
  | { kind: 'setAction'; at: ButtonLocation; action: ActionDef }
  /**
   * An action dragged from the library onto a key — authoring: a button *is* its action, icon and label, so the drop replaces
   * the action, removes any release action with it, and clears the icon and
   * the label, whatever was there. The action's default icon then renders.
   * Other fields (background, label style) stay.
   */
  | { kind: 'assignAction'; at: ButtonLocation; action: ActionDef }
  /**
   * Press/Release: `keyHold` down with these keys as the press
   * action and `keyHold` up with the same keys as the release action, together.
   * null removes both, keeping icon and label, like Clear hotkey.
   */
  | { kind: 'setPressRelease'; at: ButtonLocation; keys: string | null }
  /** "Clear hotkey": remove the press action, keeping icon and label. */
  | { kind: 'removeAction'; at: ButtonLocation }
  /** Set the key's icon to one of its three states. */
  | { kind: 'setIcon'; at: ButtonLocation; icon: IconChoice }
  /**
   * One icon of a state pair, on the action (see `pairIconFields`). A
   * file or built-in sets it; `default` removes it. No `none`: the daemon has
   * no deliberately blank half.
   */
  | { kind: 'setActionIcon'; at: ButtonLocation; field: PairIconField; icon: IconChoice }
  /** Set or (null or "") remove the label. */
  | { kind: 'setLabel'; at: ButtonLocation; label: string | null }
  /**
   * How the label is drawn. null removes
   * the field, so the key falls back to `defaults` in config.
   */
  | {
      kind: 'setLabelStyle';
      at: ButtonLocation;
      field: 'labelPosition' | 'labelColor' | 'labelSize';
      value: string | number | null;
    }
  /** "Clear button": remove the whole key — an empty, dark slot. */
  | { kind: 'clearButton'; at: ButtonLocation }
  /**
   * Write whole buttons into slots on one page, or (null) empty them — every
   * bulk operation: paste, copy to page or device, duplicate,
   * clear and swap (src/shared/bulk.ts decides what to write). One edit, so a
   * paste of ten keys is validated, saved and reloaded once, and a refused one
   * changes nothing at all.
   */
  | { kind: 'putButtons'; profile: string; serial: string; page: string; writes: ButtonWrite[] }
  /** Bare "add page": a new, empty, named page in one layout. */
  | { kind: 'addPage'; profile: string; serial: string; name: string }
  /**
   * A new profile, with a layout for each of these decks.
   * A layout must hold at least one page to be valid, so each gets one empty
   * page named `pageName`, and starts on it.
   */
  | { kind: 'addProfile'; name: string; serials: string[]; pageName: string }
  /** Give an existing profile a layout for a deck it does not cover, on the same terms. */
  | { kind: 'addLayout'; profile: string; serial: string; pageName: string }
  /**
   * Delete a page. Keys in the same
   * layout that navigated to it lose that action — a `page` action with a
   * missing target logs and does nothing on the deck, so leaving them would
   * leave keys that are invisibly dead. `startPage` is
   * moved if it named this page, because validateConfig refuses one that does
   * not resolve. Refused for a layout's last page: a layout must keep one.
   */
  | { kind: 'deletePage'; profile: string; serial: string; page: string }
  /**
   * Rename a deck (`decks.<serial>.name`). Deck config sits outside profiles, so a name set once
   * applies everywhere. null (or a blank name) removes it, and the deck falls
   * back to the model name the daemon reports.
   */
  | { kind: 'renameDeck'; serial: string; name: string | null }
  /**
   * Rename a page.
   *
   * Pages resolve by ID first and then by name, and the editor writes
   * IDs — but a hand-written `"to": "Combat"`, or a `startPage` naming the
   * page, would stop resolving the moment it is renamed. Those follow the
   * page to its new name; links by ID are left as they are. Pinning name links
   * to the ID would keep them working but make a hand-written config
   * unreadable.
   */
  | { kind: 'renamePage'; profile: string; serial: string; page: string; name: string }
  /**
   * Rename a profile. The same rule as renamePage, over the whole config:
   * a `profile` action resolves across every profile, so a key anywhere, and
   * `startProfile`, that named the profile follows it to the new name.
   */
  | { kind: 'renameProfile'; profile: string; name: string }
  /**
   * Delete a profile. Keys in the other profiles that switched to it lose
   * that action, keeping icon and label; `startProfile` moves if it named
   * this one; a deck no remaining profile covers gets a fresh layout, whose
   * one page is called `pageName` — a deck with nothing on it is worse than a
   * deck with a blank page. Refused for the last profile.
   * The rules, and the planning the confirmation shows, are in
   * src/shared/profile-deletion.ts.
   */
  | { kind: 'deleteProfile'; profile: string; pageName: string };

/**
 * A button's icon has three states, and they are not interchangeable.
 * One field, three readings — rather
 * than a second flag that could disagree with the first.
 */
export type IconChoice =
  /**
   * This file — or a built-in: `path` is `builtin:<name>`, stored as is.
   * Absolute paths under $HOME are stored as ~/...
   */
  | { kind: 'file'; path: string }
  /** Deliberately none: writes `"icon": null`, so a label-only button stays label-only even when its action has a default icon. */
  | { kind: 'none' }
  /** Nothing chosen: removes the key, so the action's built-in default renders. */
  | { kind: 'default' };

export type EditResult = { pageId?: string; profileId?: string };

export type ApplyResult = { ok: true; result: EditResult } | { ok: false; error: string };
