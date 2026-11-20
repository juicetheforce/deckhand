/**
 * Edit layout's precision tools (scope §7, round 2b; boards 22a–22d, 22g,
 * 22h): the grid and snapping, nudging, and what several selected controls
 * can do together — move, align, distribute and match. Pure, like
 * layout-edit.ts, so the main window and the tests share one copy.
 *
 * Everything is in the panel's own canvas pixels. **The grid and snapping are
 * separate switches; holding Shift ignores both** (the caller passes neither).
 * **Controls cannot leave the canvas**: a group moves as one, stopped where
 * the first of them meets an edge, so their places relative to each other
 * never change.
 */
import { geometryOfPanel } from '../../../src/geometry.js';
import type { PanelControlDef, PanelDef } from '../../../src/types.js';
import { clampBox, controlNames, resizeBox, typedSize, withControl, type Handle } from './layout-edit.js';

export type Box = { x: number; y: number; w: number; h: number };

/** The grid's pitches, in canvas pixels (22g), and Other…'s limits. */
export const GRID_PITCHES: ReadonlyArray<number> = [10, 20, 40, 60, 80, 120];
export const DEFAULT_PITCH = 40;
export const MIN_PITCH = 2;
export const MAX_PITCH = 500;

/** How the mode places things: Grid, its pitch, and Snap. Shift held: both off for that drag. */
export interface Guides {
  grid: boolean;
  pitch: number;
  snap: boolean;
}

export const DEFAULT_GUIDES: Guides = { grid: false, pitch: DEFAULT_PITCH, snap: true };

/** Guides as stored or sent, or the defaults where a field is not one. */
export function cleanGuides(value: unknown): Guides {
  const v = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const pitch = typeof v.pitch === 'number' && Number.isInteger(v.pitch) && v.pitch >= MIN_PITCH && v.pitch <= MAX_PITCH ? v.pitch : DEFAULT_PITCH;
  return { grid: typeof v.grid === 'boolean' ? v.grid : DEFAULT_GUIDES.grid, pitch, snap: typeof v.snap === 'boolean' ? v.snap : DEFAULT_GUIDES.snap };
}

/** Snapping reaches this far, in screen pixels: the same feel at any zoom. */
export const SNAP_SCREEN_PX = 6;

/** A line something can snap to, on one axis, and what it is (22a: "snap · left edge of Dial 1"). */
export interface SnapTarget {
  at: number;
  label: string;
}

/** A guide drawn while dragging: the line snapped to. */
export interface SnapGuide {
  axis: 'x' | 'y';
  at: number;
  label: string;
}

/** Every line a drag can snap to: the other controls' edges and centres, and the panel's edges and centre (22h). */
export function snapTargets(panel: PanelDef, moving: ReadonlySet<string>): { x: SnapTarget[]; y: SnapTarget[] } {
  const names = controlNames(panel);
  const { width, height } = panel.size;
  const x: SnapTarget[] = [
    { at: 0, label: "the panel's left edge" },
    { at: width / 2, label: "the panel's centre" },
    { at: width, label: "the panel's right edge" },
  ];
  const y: SnapTarget[] = [
    { at: 0, label: "the panel's top edge" },
    { at: height / 2, label: "the panel's middle" },
    { at: height, label: "the panel's bottom edge" },
  ];
  for (const c of panel.controls) {
    if (moving.has(c.id)) continue;
    const name = names.get(c.id) ?? c.id;
    x.push({ at: c.x, label: `left edge of ${name}` }, { at: c.x + c.w / 2, label: `centre of ${name}` }, { at: c.x + c.w, label: `right edge of ${name}` });
    y.push({ at: c.y, label: `top edge of ${name}` }, { at: c.y + c.h / 2, label: `middle of ${name}` }, { at: c.y + c.h, label: `bottom edge of ${name}` });
  }
  return { x, y };
}

/** The nearest target to any of these positions, within reach: how far to shift, and the guide. */
function nearest(positions: number[], targets: SnapTarget[], reach: number): { shift: number; target: SnapTarget } | null {
  let best: { shift: number; target: SnapTarget } | null = null;
  for (const p of positions) {
    for (const t of targets) {
      const shift = t.at - p;
      if (Math.abs(shift) <= reach && (best === null || Math.abs(shift) < Math.abs(best.shift))) best = { shift, target: t };
    }
  }
  return best;
}

/** How placing works for one drag: the guides as switched (both off with Shift), and snapping's reach in canvas pixels. */
export interface Placing {
  grid: boolean;
  pitch: number;
  snap: boolean;
  /** SNAP_SCREEN_PX in canvas pixels at the canvas's current scale. */
  reach: number;
  targets: { x: SnapTarget[]; y: SnapTarget[] };
}

const onGrid = (v: number, pitch: number) => Math.round(v / pitch) * pitch;

/**
 * Where a box being moved lands: on one axis, an edge or centre snapped to
 * the nearest line within reach — snapping wins over the grid, being the more
 * deliberate of the two — else, with the grid on, its left or top edge on the
 * nearest grid line; then kept on the canvas. A guide is returned only for a
 * snap that held after that.
 */
export function placeMoved(box: Box, canvas: { width: number; height: number }, how: Placing): { box: Box; guides: SnapGuide[] } {
  let { x, y } = box;
  const found: SnapGuide[] = [];
  const axis = (pos: number, size: number, targets: SnapTarget[], name: 'x' | 'y'): number => {
    if (how.snap) {
      const hit = nearest([pos, pos + size / 2, pos + size], targets, how.reach);
      if (hit) {
        found.push({ axis: name, at: hit.target.at, label: hit.target.label });
        return pos + hit.shift;
      }
    }
    return how.grid ? onGrid(pos, how.pitch) : pos;
  };
  x = axis(x, box.w, how.targets.x, 'x');
  y = axis(y, box.h, how.targets.y, 'y');
  const placed = clampBox({ x, y, w: box.w, h: box.h }, canvas);
  return { box: placed, guides: found.filter((g) => touches(placed, g)) };
}

/** Whether a guide still lies on the box's edges or centre (a clamp can move it off). */
function touches(b: Box, g: SnapGuide): boolean {
  const lines = g.axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h];
  return lines.some((l) => Math.abs(l - g.at) < 0.5);
}

/**
 * A handle dragged by dx, dy: each edge it moves snapped to the nearest line
 * within reach, else to the grid when it is on; then resized as a plain drag
 * is (layout-edit.ts resizeBox: the opposite edge fixed, Lock proportions
 * kept, nothing off the canvas).
 */
export function placeResized(from: Box, handle: Handle, dx: number, dy: number, canvas: { width: number; height: number }, keepRatio: boolean, how: Placing): { box: Box; guides: SnapGuide[] } {
  const found: SnapGuide[] = [];
  const edge = (pos: number, targets: SnapTarget[], name: 'x' | 'y'): number => {
    if (how.snap) {
      const hit = nearest([pos], targets, how.reach);
      if (hit) {
        found.push({ axis: name, at: hit.target.at, label: hit.target.label });
        return pos + hit.shift;
      }
    }
    return how.grid ? onGrid(pos, how.pitch) : pos;
  };
  if (handle.includes('e')) dx = edge(from.x + from.w + dx, how.targets.x, 'x') - (from.x + from.w);
  if (handle.includes('w')) dx = edge(from.x + dx, how.targets.x, 'x') - from.x;
  if (handle.includes('s')) dy = edge(from.y + from.h + dy, how.targets.y, 'y') - (from.y + from.h);
  if (handle.includes('n')) dy = edge(from.y + dy, how.targets.y, 'y') - from.y;
  const box = resizeBox(from, handle, dx, dy, canvas, keepRatio);
  return { box, guides: found.filter((g) => touches(box, g)) };
}

/** The smallest box around these controls. */
export function boundsOf(boxes: ReadonlyArray<Box>): Box {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The selected controls, in the order they were selected, that the panel has. */
export function chosen(panel: PanelDef, ids: ReadonlyArray<string>): PanelControlDef[] {
  return ids.flatMap((id) => panel.controls.filter((c) => c.id === id));
}

/**
 * Several controls moved together by dx, dy, as one: the shift is cut short
 * where the first of them would leave the canvas, so their places relative to
 * each other never change. Whole pixels.
 */
export function moveTogether(panel: PanelDef, ids: ReadonlyArray<string>, dx: number, dy: number): PanelDef {
  const group = chosen(panel, ids);
  if (group.length === 0) return panel;
  const b = boundsOf(group);
  const sx = Math.round(Math.max(-b.x, Math.min(panel.size.width - (b.x + b.w), dx)));
  const sy = Math.round(Math.max(-b.y, Math.min(panel.size.height - (b.y + b.h), dy)));
  if (sx === 0 && sy === 0) return panel;
  const set = new Set(ids);
  return { ...panel, controls: panel.controls.map((c) => (set.has(c.id) ? { ...c, x: c.x + sx, y: c.y + sy } : c)) };
}

/**
 * Several controls dragged: their bounds placed as one box is (placeMoved:
 * snapped, or on the grid), then every control shifted by the same amount.
 */
export function placeGroup(panel: PanelDef, ids: ReadonlyArray<string>, from: ReadonlyArray<Box & { id: string }>, dx: number, dy: number, how: Placing): { panel: PanelDef; guides: SnapGuide[] } {
  const b = boundsOf(from);
  const { box, guides } = placeMoved({ ...b, x: b.x + dx, y: b.y + dy }, panel.size, how);
  const sx = box.x - b.x;
  const sy = box.y - b.y;
  const start = new Map(from.map((f) => [f.id, f]));
  const set = new Set(ids);
  return {
    panel: { ...panel, controls: panel.controls.map((c) => (set.has(c.id) && start.has(c.id) ? { ...c, x: Math.round(start.get(c.id)!.x + sx), y: Math.round(start.get(c.id)!.y + sy) } : c)) },
    guides,
  };
}

/**
 * The arrow keys (22h): the selection nudged by 1 px, or by one grid step
 * while the grid is on; several move together.
 */
export function nudge(panel: PanelDef, ids: ReadonlyArray<string>, dx: number, dy: number, guides: Guides): PanelDef {
  const step = guides.grid ? guides.pitch : 1;
  return moveTogether(panel, ids, dx * step, dy * step);
}

/** Every control a marquee touches (22c): its box meets the marquee's. */
export function inMarquee(panel: PanelDef, m: Box): string[] {
  const right = m.x + m.w;
  const bottom = m.y + m.h;
  const hit = new Set(panel.controls.filter((c) => c.x < right && c.x + c.w > m.x && c.y < bottom && c.y + c.h > m.y).map((c) => c.id));
  // In reading order, as keys are numbered: the "first selected" a marquee gives is its first key.
  return geometryOfPanel(panel, '').keys.map((k) => k.id).filter((id) => hit.has(id));
}

export type Alignment = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export const ALIGNMENTS: ReadonlyArray<Alignment> = ['left', 'centre', 'right', 'top', 'middle', 'bottom'];

/** Align (22d): every selected control against the selection's own bounds. */
export function align(panel: PanelDef, ids: ReadonlyArray<string>, how: Alignment): PanelDef {
  const group = chosen(panel, ids);
  if (group.length < 2) return panel;
  const b = boundsOf(group);
  const place = (c: PanelControlDef): Partial<PanelControlDef> => {
    switch (how) {
      case 'left':
        return { x: b.x };
      case 'centre':
        return { x: Math.round(b.x + (b.w - c.w) / 2) };
      case 'right':
        return { x: b.x + b.w - c.w };
      case 'top':
        return { y: b.y };
      case 'middle':
        return { y: Math.round(b.y + (b.h - c.h) / 2) };
      case 'bottom':
        return { y: b.y + b.h - c.h };
    }
  };
  return group.reduce((p, c) => withControl(p, c.id, place(c)), panel);
}

/**
 * Distribute (22d): across or down, the gaps between neighbours made equal,
 * the first and last staying where they are. Needs three or more.
 */
export function distribute(panel: PanelDef, ids: ReadonlyArray<string>, direction: 'across' | 'down'): PanelDef {
  const group = chosen(panel, ids);
  if (group.length < 3) return panel;
  const across = direction === 'across';
  const start = (c: Box) => (across ? c.x : c.y);
  const size = (c: Box) => (across ? c.w : c.h);
  const sorted = [...group].sort((a, b) => start(a) - start(b) || start(a) + size(a) - (start(b) + size(b)));
  const first = sorted[0];
  const last = sorted.reduce((l, c) => (start(c) + size(c) > start(l) + size(l) ? c : l), sorted[sorted.length - 1]);
  const middle = sorted.filter((c) => c !== first && c !== last);
  const span = start(last) + size(last) - start(first);
  const gap = (span - sorted.reduce((sum, c) => sum + size(c), 0)) / (sorted.length - 1);
  let at = start(first) + size(first) + gap;
  let out = panel;
  for (const c of middle) {
    out = withControl(out, c.id, across ? { x: Math.round(at) } : { y: Math.round(at) });
    at += size(c) + gap;
  }
  return out;
}

/**
 * Match width or height (22d) to the first one selected. A control with Lock
 * proportions keeps its shape, as a typed size does; every one stays on the
 * canvas.
 */
export function match(panel: PanelDef, ids: ReadonlyArray<string>, field: 'w' | 'h'): PanelDef {
  const group = chosen(panel, ids);
  if (group.length < 2) return panel;
  const to = group[0][field];
  return group.slice(1).reduce((p, c) => withControl(p, c.id, typedSize(c, field, to, panel.size)), panel);
}

/** The selection's position (22c's X and Y with several): the top-left of their bounds. */
export function groupPosition(panel: PanelDef, ids: ReadonlyArray<string>): { x: number; y: number } | null {
  const group = chosen(panel, ids);
  if (group.length === 0) return null;
  const b = boundsOf(group);
  return { x: b.x, y: b.y };
}

/** Several controls given a typed X or Y for their bounds: moved together, stopped at the canvas's edge. */
export function moveGroupTo(panel: PanelDef, ids: ReadonlyArray<string>, at: { x?: number; y?: number }): PanelDef {
  const now = groupPosition(panel, ids);
  if (!now) return panel;
  return moveTogether(panel, ids, at.x === undefined ? 0 : at.x - now.x, at.y === undefined ? 0 : at.y - now.y);
}

