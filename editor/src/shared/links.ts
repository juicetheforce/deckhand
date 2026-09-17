/**
 * What points at a page, so deleting one can say what it breaks and then fix
 * it (docs/scope.md §7, M4 phase B, B1).
 *
 * Scope is one layout, deliberately. A `page` action resolves its target
 * inside the layout of the deck it fired from — `ctx.deck.goToPage(to)` in
 * src/actions/system.ts, resolving through the daemon's own resolvePage — so a
 * key in another profile, or on another deck, can never be pointing at this
 * page even when it names the same string.
 *
 * Pure, and imports nothing that touches Node: the renderer uses it to build
 * the confirmation, the main process to apply the edit.
 */
import { resolvePage } from '../../../src/config-common.js';
import type { ActionDef, LayoutDef } from '../../../src/types.js';

export interface PageLink {
  /** The page holding the key, by ID. */
  page: string;
  index: number;
  /** Which of the button's two actions it is. */
  where: 'action' | 'onRelease';
  /** The pointer is one step of a multi action, not the whole action. */
  inMulti: boolean;
}

/** Whether an action navigates to `pageId`, by the daemon's own ID-then-name resolution. */
export function targetsPage(action: unknown, layout: LayoutDef, pageId: string): boolean {
  const a = action as ActionDef | undefined;
  if (!a || a.type !== 'page' || typeof a.to !== 'string') return false;
  return resolvePage(layout, a.to) === pageId;
}

/** The steps of a multi action, or null if it is not one. */
export function multiSteps(action: unknown): ActionDef[] | null {
  const a = action as ActionDef | undefined;
  if (!a || a.type !== 'multi' || !Array.isArray(a.steps)) return null;
  return a.steps as ActionDef[];
}

/**
 * Every key in this layout that navigates to `pageId`. Keys on the page itself
 * are left out: they are deleted with it. Call before the page is removed —
 * a link written as the page's *name* stops resolving once it is gone.
 */
export function pageLinks(layout: LayoutDef, pageId: string): PageLink[] {
  const found: PageLink[] = [];
  for (const [page, def] of Object.entries(layout.pages)) {
    if (page === pageId) continue;
    for (const [key, button] of Object.entries(def.buttons)) {
      for (const where of ['action', 'onRelease'] as const) {
        const action = button[where];
        if (targetsPage(action, layout, pageId)) {
          found.push({ page, index: Number(key), where, inMulti: false });
        } else if (multiSteps(action)?.some((step) => targetsPage(step, layout, pageId))) {
          found.push({ page, index: Number(key), where, inMulti: true });
        }
      }
    }
  }
  return found;
}

/**
 * An action with its navigation that goes nowhere *in this layout* taken out
 * (docs/scope.md §7, B3): a key copied to another deck keeps its icon and label
 * but loses a `page` action whose target does not resolve there, the same
 * treatment as page delete (the maintainer, 2026-09-16). A `multi` loses only the steps
 * that go nowhere, and is removed if none are left.
 *
 * `back: true` names no page, so it always stays; a target that does resolve
 * in the new layout stays too — the daemon resolves it there by the same rule.
 *
 * Returns the action to keep (undefined if none) and whether anything was
 * dropped. The action passed in is not modified.
 */
export function keepResolvableNavigation(action: ActionDef, layout: LayoutDef): { action: ActionDef | undefined; dropped: boolean } {
  const goesNowhere = (a: ActionDef) => a.type === 'page' && typeof a.to === 'string' && resolvePage(layout, a.to) === null;
  if (goesNowhere(action)) return { action: undefined, dropped: true };
  const steps = multiSteps(action);
  if (steps === null) return { action, dropped: false };
  const kept = steps.filter((step) => !goesNowhere(step));
  if (kept.length === steps.length) return { action, dropped: false };
  if (kept.length === 0) return { action: undefined, dropped: true };
  return { action: { ...action, steps: kept }, dropped: true };
}

/**
 * Whether an action can move the deck off the page it fired from.
 *
 * - `page` with `to` counts only when the target **resolves in this layout**:
 *   the daemon logs and does nothing for a missing target
 *   (`DeckSession.goToPage`), so a key pointing nowhere is not a way out.
 * - `page` with `back: true` counts. It does nothing when the history is
 *   empty, but the guard is about being stranded on a page you *navigated to*,
 *   and in that case there is always history.
 * - `profile` counts: it moves every deck the profile covers.
 * - A `multi` counts if any of its steps does.
 */
export function leavesPage(action: unknown, layout: LayoutDef): boolean {
  const a = action as ActionDef | undefined;
  if (!a) return false;
  if (a.type === 'profile') return true;
  if (a.type === 'page') {
    if (a.back === true) return true;
    return typeof a.to === 'string' && resolvePage(layout, a.to) !== null;
  }
  return multiSteps(a)?.some((step) => leavesPage(step, layout)) ?? false;
}

/**
 * Pages in this layout with no key that can leave them — scope §10's guard: no
 * key is auto-reserved for Back (on a 15-key deck that is a slot you cannot
 * spare), so the editor warns instead.
 *
 * A layout with a single page is never flagged: there is nowhere else to go,
 * so there is no navigation to get wrong.
 */
export function pagesWithNoWayOff(layout: LayoutDef): string[] {
  const ids = Object.keys(layout.pages);
  if (ids.length < 2) return [];
  return ids.filter(
    (id) =>
      !Object.values(layout.pages[id].buttons).some(
        (button) => leavesPage(button.action, layout) || leavesPage(button.onRelease, layout),
      ),
  );
}
