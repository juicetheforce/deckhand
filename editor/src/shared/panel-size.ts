/**
 * A virtual deck's panel given a new size, in one profile: every page's keys
 * keep their row and column, as paste and Copy to device place keys. A key
 * with no place in the new grid is dropped, and named first so the editor can
 * ask; the configuration is kept before such a resize (main.ts), as before a
 * profile delete — the editor has no undo.
 *
 * Pure, importing only the daemon's own geometry: the Settings window builds
 * the confirmation with it, and the main process applies the same result.
 */
import { geometryOfPanel } from '../../../src/geometry.js';
import type { ButtonDef, LayoutDef, PanelDef } from '../../../src/types.js';

export interface DroppedKey {
  page: string;
  key: string;
  button: ButtonDef;
}

/** Each control's row and column, as the editor's grid and paste read them. */
function places(panel: PanelDef | undefined): Map<string, string> {
  return new Map(geometryOfPanel(panel, '').keys.map((k) => [k.id, `${k.row}:${k.column}`]));
}

export function resizePanel(layout: LayoutDef, panel: PanelDef): { layout: LayoutDef; dropped: DroppedKey[] } {
  const from = places(layout.panel);
  const to = new Map([...places(panel)].map(([id, place]) => [place, id]));
  const next: LayoutDef = { ...structuredClone(layout), panel: structuredClone(panel) };
  const dropped: DroppedKey[] = [];
  for (const [pageId, page] of Object.entries(layout.pages)) {
    const buttons: Record<string, ButtonDef> = {};
    for (const [key, button] of Object.entries(page.buttons)) {
      const place = from.get(key);
      const target = place === undefined ? undefined : to.get(place);
      if (target === undefined) {
        // An empty slot ({}) is nothing to lose.
        if (Object.keys(button).length > 0) dropped.push({ page: pageId, key, button });
        continue;
      }
      buttons[target] = structuredClone(button);
    }
    next.pages[pageId] = { ...next.pages[pageId], buttons };
  }
  return { layout: next, dropped };
}
