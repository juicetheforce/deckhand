/**
 * The three-pane layout's widths (docs/scope.md §10). The panes are
 * draggable: the library and the inspector are given widths, the grid takes
 * what is left. Pure, so test/panes.test.ts runs it in Node.
 *
 * **Widths are not persisted** (the maintainer, 2026-09-15): the window itself resizes,
 * and this is something set once in passing, not worth a stored dimension. A
 * fresh editor opens at the defaults.
 *
 * Limits are chosen from what each pane holds: the library's entries have two
 * lines of text, and the inspector holds the icon picker's thumbnail grid,
 * which is why it is the wider default and may grow further.
 */

export interface PaneWidths {
  library: number;
  inspector: number;
}

export const PANE_LIMITS = {
  library: { min: 180, max: 420, default: 230 },
  // 200px so the icon grid's narrow steps (4 and 3 columns) can be reached.
  inspector: { min: 200, max: 620, default: 340 },
} as const;

export type PaneName = keyof typeof PANE_LIMITS;

export const DEFAULT_PANE_WIDTHS: PaneWidths = {
  library: PANE_LIMITS.library.default,
  inspector: PANE_LIMITS.inspector.default,
};

/** A width forced within that pane's limits, rounded to whole pixels. */
export function clampPane(pane: PaneName, width: number): number {
  const { min, max } = PANE_LIMITS[pane];
  if (!Number.isFinite(width)) return PANE_LIMITS[pane].default;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * A pane's new width while its divider is dragged. `delta` is how far the
 * pointer has moved from where the drag started, in pixels; the inspector
 * grows as the pointer moves left, which is why its delta is subtracted.
 */
export function widthWhileDragging(pane: PaneName, startWidth: number, delta: number): number {
  return clampPane(pane, pane === 'library' ? startWidth + delta : startWidth - delta);
}

/** How wide a divider's own grid column is, in pixels (its grip is drawn inside it). */
export const DIVIDER_WIDTH = 8;

/**
 * The CSS `grid-template-columns` for the panes: library, divider, grid,
 * divider, inspector. The dividers are grid tracks of their own so that
 * dragging one does not move anything else.
 */
export function paneColumns(widths: PaneWidths): string {
  return `${widths.library}px ${DIVIDER_WIDTH}px minmax(0, 1fr) ${DIVIDER_WIDTH}px ${widths.inspector}px`;
}
