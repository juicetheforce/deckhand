/**
 * The edits the editor can make to a config, as plain data. The renderer
 * builds them; the main process applies them (src/main/config-document.ts).
 *
 * Types only, importing nothing that touches Node: the renderer imports this.
 */
import type { ActionDef } from '../../../src/types.js';

export interface ButtonLocation {
  profile: string;
  serial: string;
  page: string;
  index: number;
}

export type Edit =
  /** Set the key's press action, keeping icon, label and anything else on it. */
  | { kind: 'setAction'; at: ButtonLocation; action: ActionDef }
  /** "Clear hotkey": remove the press action, keeping icon and label. */
  | { kind: 'removeAction'; at: ButtonLocation }
  /** Set the key's icon to one of its three states. */
  | { kind: 'setIcon'; at: ButtonLocation; icon: IconChoice }
  /** Set or (null or "") remove the label. */
  | { kind: 'setLabel'; at: ButtonLocation; label: string | null }
  /**
   * How the label is drawn. The schema and src/render.ts have carried all
   * three positions since v0.1; only the editor UI was missing. null removes
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
  /** Bare "add page" (scope §7, phase A): a new, empty, named page in one layout. */
  | { kind: 'addPage'; profile: string; serial: string; name: string }
  /**
   * A new profile (scope §7, phase B), with a layout for each of these decks.
   * A layout must hold at least one page to be valid, so each gets one empty
   * page named `pageName`, and starts on it.
   */
  | { kind: 'addProfile'; name: string; serials: string[]; pageName: string }
  /** Give an existing profile a layout for a deck it does not cover, on the same terms. */
  | { kind: 'addLayout'; profile: string; serial: string; pageName: string }
  /**
   * Delete a page (scope §7, B3, pulled forward from M5). Keys in the same
   * layout that navigated to it lose that action — a `page` action with a
   * missing target logs and does nothing on the deck, so leaving them would
   * leave keys that are invisibly dead (the maintainer, 2026-09-15). `startPage` is
   * moved if it named this page, because validateConfig refuses one that does
   * not resolve. Refused for a layout's last page: a layout must keep one.
   */
  | { kind: 'deletePage'; profile: string; serial: string; page: string }
  /**
   * Rename a deck (scope §10, the maintainer 2026-09-16). `decks.<serial>.name` is
   * already in the schema; this is editor UI over an existing field, not a
   * schema change. Deck config sits outside profiles, so a name set once
   * applies everywhere. null (or a blank name) removes it, and the deck falls
   * back to the model name the daemon reports.
   */
  | { kind: 'renameDeck'; serial: string; name: string | null }
  /**
   * Rename a page. **Pulled forward from M5** (the maintainer, 2026-09-16) so the tab's
   * right-click menu can carry Rename beside Delete, which is what lets the
   * "⋯" button go.
   *
   * Pages resolve by ID first and then by name (§5), and the editor writes
   * IDs — but a hand-written `"to": "Combat"`, or a `startPage` naming the
   * page, would stop resolving the moment it is renamed. Both are rewritten to
   * the page's ID as part of the rename, which preserves what they meant and
   * makes them immune to the next rename.
   */
  | { kind: 'renamePage'; profile: string; serial: string; page: string; name: string };

/**
 * A button's icon has three states, and they are not interchangeable
 * (docs/scope.md §10, the maintainer 2026-09-16). One field, three readings — rather
 * than a second flag that could disagree with the first.
 */
export type IconChoice =
  /** This file. Absolute paths under $HOME are stored as ~/... */
  | { kind: 'file'; path: string }
  /** Deliberately none: writes `"icon": null`, so a label-only button stays label-only after phase C. */
  | { kind: 'none' }
  /** Nothing chosen: removes the key, so the action's built-in default renders (phase C). */
  | { kind: 'default' };

export type EditResult = { pageId?: string; profileId?: string };

export type ApplyResult = { ok: true; result: EditResult } | { ok: false; error: string };
