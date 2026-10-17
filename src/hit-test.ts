/**
 * Which control a point on a virtual deck's canvas is on: the one hit test,
 * for the daemon's touches now and the editor's later. The daemon hit-tests,
 * not the helper, so shapes other than squares never reach the C.
 * Import-free, so the editor can import it, as failed-badge.ts.
 *
 * Stage 1 has only squares: a point is on a control when it is inside its
 * rectangle, its right and bottom edges not included. Where controls overlap,
 * the last in the list is on top.
 */

export interface HitControl {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: string;
}

export function controlAt(controls: ReadonlyArray<HitControl>, x: number, y: number): string | null {
  for (let i = controls.length - 1; i >= 0; i--) {
    const c = controls[i];
    if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c.id;
  }
  return null;
}
