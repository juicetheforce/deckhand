/**
 * The canvas's arithmetic (scope §10, "Multi-deck editing"): where the shown
 * decks sit, what a dragged deck snaps to, how an overlap is resolved, and
 * zoom. Pure, so it is tested without a window (test/canvas.test.ts).
 *
 * Everything is in key units — one unit is a key and the gap after it, at
 * 100% — and a deck's position is its grid's top-left (shared/deck-positions).
 * Every deck is drawn at the same key size with the same panel around it, so
 * two decks' edges line up exactly when their key columns (or rows) do.
 */
import type { DeckPosition, DeckPositions } from '../shared/deck-positions.js';

/** At 100%. KEY_PX and GAP_PX are the grid's; the panel's padding and header are fixed on the canvas. */
export const KEY_PX = 88;
export const GAP_PX = 10;
export const PITCH_PX = KEY_PX + GAP_PX;
/** The panel's side padding. */
export const PAD_X_PX = 14;
/** Above the grid: the panel's top padding, its header, and the gap below the header. */
export const HEAD_PX = 10 + 28 + 10;
/** Below the grid: the panel's bottom padding. */
export const FOOT_PX = 14;
/** Between two decks butted against each other. */
export const GUTTER_PX = 16;
/** How near, on screen, a dragged deck must come to snap. */
export const SNAP_PX = 8;
/** Space around the arrangement inside the canvas, on screen. */
export const MARGIN_PX = 24;

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export interface DeckSize {
  columns: number;
  rows: number;
}

/** A panel's outline, in key units. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const u = (px: number) => px / PITCH_PX;
const EPS = 1e-6;

/** Keys and the gaps between them: n keys are n units less one gap. */
const span = (keys: number) => keys - u(GAP_PX);

export function panelRect(at: DeckPosition, size: DeckSize): Rect {
  return {
    left: at.x - u(PAD_X_PX),
    top: at.y - u(HEAD_PX),
    right: at.x + span(size.columns) + u(PAD_X_PX),
    bottom: at.y + span(size.rows) + u(FOOT_PX),
  };
}

/** Overlapping, not merely touching. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right - EPS && b.left < a.right - EPS && a.top < b.bottom - EPS && b.top < a.bottom - EPS;
}

export function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/**
 * Where each shown deck is drawn. A remembered position is used unless it
 * overlaps a deck already placed (a deck moved into a hidden deck's place
 * while it was hidden); every other deck goes below the lowest, left-aligned
 * with the leftmost — stacking fits a normal screen. Nothing here is saved:
 * a position is written only when the person drops a deck.
 */
export function arrange(shown: string[], sizes: Record<string, DeckSize>, remembered: DeckPositions): DeckPositions {
  const placed: DeckPositions = {};
  const rects: Rect[] = [];
  const later: string[] = [];
  for (const serial of shown) {
    const size = sizes[serial];
    if (!size) continue;
    const at = remembered[serial];
    const rect = at ? panelRect(at, size) : null;
    if (at && rect && !rects.some((r) => overlaps(r, rect))) {
      placed[serial] = { x: at.x, y: at.y };
      rects.push(rect);
    } else {
      later.push(serial);
    }
  }
  for (const serial of later) {
    const size = sizes[serial];
    const all = union(rects);
    const at = all ? { x: all.left + u(PAD_X_PX), y: all.bottom + u(GUTTER_PX + HEAD_PX) } : { x: 0, y: 0 };
    placed[serial] = at;
    rects.push(panelRect(at, size));
  }
  return placed;
}

/** Another deck, as the dragged one sees it. */
export interface Neighbour {
  serial: string;
  name: string;
  at: DeckPosition;
  size: DeckSize;
}

/** The dashed line shown while a deck is held against something, in key units. */
export interface Guide {
  axis: 'x' | 'y';
  /** The line's x for axis 'x' (a vertical line), its y for axis 'y'. */
  at: number;
  from: number;
  to: number;
  label: string;
}

interface Candidate {
  value: number;
  /** Where the line is drawn, on the other axis from its extent. */
  line: number;
  label: string;
  /** The deck it snaps to, for the line's extent. */
  other: Rect;
}

/** One axis of a deck, so columns and rows share the arithmetic. */
interface Axis {
  at: (p: DeckPosition) => number;
  keys: (s: DeckSize) => number;
  low: (r: Rect) => number;
  high: (r: Rect) => number;
  /** Panel beyond the grid at the low end (before key 1) and the high end. */
  before: number;
  after: number;
  words: { key: string; low: string; high: string; lowEdge: string; highEdge: string };
}

const X: Axis = {
  at: (p) => p.x,
  keys: (s) => s.columns,
  low: (r) => r.left,
  high: (r) => r.right,
  before: u(PAD_X_PX),
  after: u(PAD_X_PX),
  words: { key: 'key column', low: 'beside', high: 'beside', lowEdge: 'left edge', highEdge: 'right edge' },
};

const Y: Axis = {
  at: (p) => p.y,
  keys: (s) => s.rows,
  low: (r) => r.top,
  high: (r) => r.bottom,
  before: u(HEAD_PX),
  after: u(FOOT_PX),
  words: { key: 'key row', low: 'above', high: 'below', lowEdge: 'top edge', highEdge: 'bottom edge' },
};

function candidates(axis: Axis, size: DeckSize, other: Neighbour, raw: number): Candidate[] {
  const o = panelRect(other.at, other.size);
  const origin = axis.at(other.at);
  const mine = axis.keys(size);
  const theirs = axis.keys(other.size);
  const out: Candidate[] = [];
  // Its key columns (rows), where at least one of each deck's lines up. The
  // first and last are its edges: every panel has the same frame.
  const k = Math.round(raw - origin);
  if (k > -mine && k < theirs) {
    const value = origin + k;
    const edge = k === 0 ? axis.words.lowEdge : k === theirs - mine ? axis.words.highEdge : null;
    out.push(
      edge === null
        ? { value, line: value, label: `aligned to ${other.name} ${axis.words.key}`, other: o }
        : { value, line: k === 0 ? axis.low(o) : axis.high(o), label: `aligned to ${other.name}'s ${edge}`, other: o },
    );
  }
  // Butted against it, either side, a gutter apart.
  const g = u(GUTTER_PX);
  out.push({ value: axis.high(o) + g + axis.before, line: axis.high(o) + g / 2, label: `${axis.words.high} ${other.name}`, other: o });
  out.push({ value: axis.low(o) - g - axis.after - span(mine), line: axis.low(o) - g / 2, label: `${axis.words.low} ${other.name}`, other: o });
  return out;
}

function nearest(options: Candidate[], raw: number, threshold: number): Candidate | null {
  let best: Candidate | null = null;
  for (const c of options) {
    const d = Math.abs(c.value - raw);
    if (d <= threshold + EPS && (best === null || d < Math.abs(best.value - raw) - EPS)) best = c;
  }
  return best;
}

/**
 * Snap a dragged deck: each axis on its own, to the nearest of every other
 * deck's key columns (rows), its edges, or the place butted against it,
 * within SNAP_PX on screen at this zoom.
 */
export function snap(raw: DeckPosition, size: DeckSize, others: Neighbour[], zoom: number): { at: DeckPosition; guides: Guide[] } {
  const threshold = SNAP_PX / (PITCH_PX * zoom);
  const x = nearest(others.flatMap((o) => candidates(X, size, o, raw.x)), raw.x, threshold);
  const y = nearest(others.flatMap((o) => candidates(Y, size, o, raw.y)), raw.y, threshold);
  const at = { x: x?.value ?? raw.x, y: y?.value ?? raw.y };
  // The line spans both decks, where the dragged one ends up.
  const settled = panelRect(at, size);
  const guides: Guide[] = [];
  if (x) guides.push({ axis: 'x', at: x.line, from: Math.min(settled.top, x.other.top), to: Math.max(settled.bottom, x.other.bottom), label: x.label });
  if (y) guides.push({ axis: 'y', at: y.line, from: Math.min(settled.left, y.other.left), to: Math.max(settled.right, y.other.right), label: y.label });
  return { at, guides };
}

type Side = 'left' | 'right' | 'above' | 'below';

/**
 * Decks never overlap (Ryan, 2026-09-27). A drop that would overlap another
 * deck is butted against it on the side **the pointer is nearest** — the
 * edge of that deck closest to where the person is holding the dragged one —
 * and keeps its other coordinate. So a deck dragged over another follows the
 * pointer from edge to edge rather than sticking where it came from (Ryan's
 * revision, the same day: the first rule, "the side it came from", held a
 * deck below another until its whole height had cleared the top).
 *
 * The deck hit is the one under the pointer, or failing that the one
 * overlapped most. Returns null when butting it there still overlaps a deck,
 * which the rule cannot settle: the caller puts the deck back where it
 * started.
 */
export function resolveOverlap(at: DeckPosition, size: DeckSize, pointer: DeckPosition, others: Neighbour[]): DeckPosition | null {
  const rect = panelRect(at, size);
  const inside = (r: Rect) => pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  const hit = others
    .map((o) => ({ o, r: panelRect(o.at, o.size) }))
    .filter(({ r }) => overlaps(rect, r))
    .map(({ o, r }) => ({
      o,
      r,
      under: inside(r),
      area: (Math.min(rect.right, r.right) - Math.max(rect.left, r.left)) * (Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top)),
    }))
    .sort((a, b) => Number(b.under) - Number(a.under) || b.area - a.area)[0];
  if (!hit) return at;
  const r = hit.r;
  const edges: [Side, number][] = [
    ['left', Math.abs(pointer.x - r.left)],
    ['right', Math.abs(pointer.x - r.right)],
    ['above', Math.abs(pointer.y - r.top)],
    ['below', Math.abs(pointer.y - r.bottom)],
  ];
  const side = edges.sort((a, b) => a[1] - b[1])[0][0];
  const g = u(GUTTER_PX);
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const best =
    side === 'left'
      ? { x: at.x + (r.left - g - width - rect.left), y: at.y }
      : side === 'right'
        ? { x: at.x + (r.right + g - rect.left), y: at.y }
        : side === 'above'
          ? { x: at.x, y: at.y + (r.top - g - height - rect.top) }
          : { x: at.x, y: at.y + (r.bottom + g - rect.top) };
  const settled = panelRect(best, size);
  return others.some((o) => overlaps(settled, panelRect(o.at, o.size))) ? null : best;
}

/** Stored to a thousandth of a key: exact enough, and a readable file. */
export function roundPosition(at: DeckPosition): DeckPosition {
  return { x: Math.round(at.x * 1000) / 1000, y: Math.round(at.y * 1000) / 1000 };
}

/** The largest zoom that shows every deck in the viewport, never above 100% (scope §10). */
export function fitZoom(bounds: Rect | null, viewport: { width: number; height: number }): number {
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) return 1;
  const w = (bounds.right - bounds.left) * PITCH_PX;
  const h = (bounds.bottom - bounds.top) * PITCH_PX;
  const fit = Math.min((viewport.width - 2 * MARGIN_PX) / w, (viewport.height - 2 * MARGIN_PX) / h);
  return Math.max(MIN_ZOOM, Math.min(1, fit));
}

export function zoomIn(zoom: number): number {
  return ZOOM_STEPS.find((z) => z > zoom + EPS) ?? MAX_ZOOM;
}

export function zoomOut(zoom: number): number {
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - EPS) ?? MIN_ZOOM;
}
