/**
 * One page of a virtual deck given another fixed grid ("Change layout…"):
 * its keys keep their row and column, as paste and Copy to device place
 * keys. A key with no place in the new grid is dropped, after a warning
 * naming it. Only that page changes: every page has its own layout. No undo,
 * as on a Stream Deck; the rolling backup every config change gets is the
 * last resort.
 *
 * Pure, importing only the daemon's own geometry: the main window builds the
 * warning with it, and the main process applies the same result.
 */
import { geometryOfPanel } from '../../../src/geometry.js';
import type { ButtonDef, PageDef, PanelDef } from '../../../src/types.js';

export interface DroppedKey {
  key: string;
  /** Its number as people count keys, in reading order from 1, on the grid it had. */
  number: number;
  button: ButtonDef;
}

/** Each control's row and column, as the editor's grid and paste read them. */
function places(panel: PanelDef | undefined): Map<string, string> {
  return new Map(geometryOfPanel(panel, '').keys.map((k) => [k.id, `${k.row}:${k.column}`]));
}

/**
 * `from` is the grid the page shows now: its own panel, or — a page not yet
 * given one — the deck's default.
 */
export function regridPage(page: PageDef, from: PanelDef | undefined, panel: PanelDef): { page: PageDef; dropped: DroppedKey[] } {
  const was = places(from);
  const order = new Map(geometryOfPanel(from, '').keys.map((k, i) => [k.id, i + 1]));
  const to = new Map([...places(panel)].map(([id, place]) => [place, id]));
  const buttons: Record<string, ButtonDef> = {};
  const dropped: DroppedKey[] = [];
  for (const [key, button] of Object.entries(page.buttons)) {
    const place = was.get(key);
    const target = place === undefined ? undefined : to.get(place);
    if (target === undefined) {
      // An empty slot ({}) is nothing to lose.
      if (Object.keys(button).length > 0) dropped.push({ key, number: order.get(key) ?? 0, button });
      continue;
    }
    buttons[target] = structuredClone(button);
  }
  dropped.sort((a, b) => a.number - b.number);
  return { page: { ...structuredClone(page), buttons, panel: structuredClone(panel) }, dropped };
}
