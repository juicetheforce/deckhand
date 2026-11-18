/**
 * Which control a point on a virtual deck's canvas is on: the one hit test,
 * for the daemon's touches and the editor. The daemon hit-tests, not the
 * helper, so shapes never reach the C. Import-free (shapes.ts is too), so the
 * editor can import it, as failed-badge.ts.
 *
 * A point is on a control when it is on its real shape (shapes.ts): inside a
 * round control's ellipse, a hexagon's six sides, a rectangle's rounded
 * corners — the box's right and bottom edges not included. **Where controls
 * overlap, the later in the list is on top**, so the list must be in the
 * panel's own order (its `controls` in config.json), never reading order:
 * Bring to front and Send to back change that order and nothing else.
 */
import { insideShape } from './shapes.js';

export interface HitControl {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: string;
  radius?: number;
}

export function controlAt(controls: ReadonlyArray<HitControl>, x: number, y: number): string | null {
  for (let i = controls.length - 1; i >= 0; i--) {
    const c = controls[i];
    if (insideShape(c, x - c.x, y - c.y)) return c.id;
  }
  return null;
}
