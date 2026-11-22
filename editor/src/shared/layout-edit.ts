/**
 * Edit layout's arithmetic (scope §7, "Virtual decks stage 2", round 2a):
 * what each change in the mode does to a page's panel, and what it costs the
 * page's keys. Pure, so the main window and the tests share one copy; the main
 * process applies the result with the `setLayout` edit.
 *
 * Everything is in the panel's own canvas pixels (types.ts PanelDef), as the
 * mode bar and the inspector show them. **Controls cannot leave the canvas**:
 * a move or a typed value stops at its edge. **Overlap is allowed**: the later
 * in `controls` is on top.
 */
import { geometryOfPanel } from '../../../src/geometry.js';
import { CUSTOM_LAYOUT, isVerySmall, mmToPx, newButtonSide, sideMm, type ScreenSize } from '../../../src/panel-presets.js';
import { DIAL_MM, SLIDER_MAX_OF_SHORTER, SLIDER_MM, type ControlKind } from '../../../src/value-controls.js';
import { cornerRadius, insideShape, shapeName, type ShapeName } from '../../../src/shapes.js';
import type { ButtonDef, PageDef, PanelControlDef, PanelDef } from '../../../src/types.js';

/** A control is never smaller than this many canvas pixels on a side: small enough for any use, large enough to grab. */
export const MIN_SIDE = 8;

/**
 * Duplicate's offset, in canvas pixels, when none is given: one grid step
 * (board 22h) at the grid's default pitch, 40 px. The mode passes the pitch
 * chosen (round 2b).
 */
export const DUPLICATE_OFFSET = 40;

type Box = { x: number; y: number; w: number; h: number };

/** A box kept on the canvas, whole pixels, at least MIN_SIDE (or the canvas, if smaller). */
export function clampBox(box: Box, canvas: { width: number; height: number }): Box {
  const w = Math.round(Math.max(Math.min(MIN_SIDE, canvas.width), Math.min(box.w, canvas.width)));
  const h = Math.round(Math.max(Math.min(MIN_SIDE, canvas.height), Math.min(box.h, canvas.height)));
  const x = Math.round(Math.max(0, Math.min(box.x, canvas.width - w)));
  const y = Math.round(Math.max(0, Math.min(box.y, canvas.height - h)));
  return { x, y, w, h };
}

/** The page's controls with one replaced, kept on the canvas. */
export function withControl(panel: PanelDef, id: string, change: Partial<PanelControlDef>): PanelDef {
  return {
    ...panel,
    controls: panel.controls.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...change };
      const box = clampBox(next, panel.size);
      const out: PanelControlDef = { ...next, ...box };
      // The radius follows the box: never past a full pill.
      if (out.radius !== undefined) {
        const r = Math.round(cornerRadius(out));
        if (r > 0 && shapeName(out.shape) === 'rectangle') out.radius = r;
        else delete out.radius;
      }
      return out;
    }),
  };
}

/** Move a control to x, y: stopped at the canvas's edges, its size unchanged. */
export function moveControl(panel: PanelDef, id: string, x: number, y: number): PanelDef {
  return withControl(panel, id, { x, y });
}

/** A width or height typed into the inspector: with Lock proportions, the other follows. */
export function typedSize(c: Box & { keepRatio?: boolean }, field: 'w' | 'h', value: number, canvas: { width: number; height: number }): { w: number; h: number } {
  if (!c.keepRatio) return field === 'w' ? { w: value, h: c.h } : { w: c.w, h: value };
  const ratio = c.w / c.h;
  const sized = field === 'w' ? fitRatio(value, value / ratio, canvas.width, canvas.height) : fitRatio(value * ratio, value, canvas.width, canvas.height);
  return { w: Math.round(sized.w), h: Math.round(sized.h) };
}

/**
 * A locked size brought within its limits by one factor for both sides, so
 * the ratio survives a limit: grown until neither side is under MIN_SIDE,
 * then shrunk until both fit maxW × maxH (the larger limit wins if both
 * cannot hold). Clamping each side alone loses the ratio for good, as the
 * next edit takes the distorted box as its ratio.
 */
function fitRatio(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const grow = Math.max(1, MIN_SIDE / w, MIN_SIDE / h);
  const shrink = Math.min(1, maxW / (w * grow), maxH / (h * grow));
  return { w: w * grow * shrink, h: h * grow * shrink };
}

/** The eight handles: which edges each one moves. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: ReadonlyArray<Handle> = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * A control resized by dragging one handle by dx, dy from where it was
 * (`from`): the opposite edge or corner stays put, nothing leaves the canvas,
 * and with Lock proportions the box keeps its shape — an edge handle moves the
 * other side too, centred, and a corner follows whichever way the pointer
 * moved further.
 */
export function resizeBox(from: Box, handle: Handle, dx: number, dy: number, canvas: { width: number; height: number }, keepRatio: boolean): Box {
  const left0 = from.x;
  const top0 = from.y;
  const right0 = from.x + from.w;
  const bottom0 = from.y + from.h;
  let left = left0;
  let top = top0;
  let right = right0;
  let bottom = bottom0;
  if (handle.includes('w')) left = Math.min(right0 - MIN_SIDE, Math.max(0, left0 + dx));
  if (handle.includes('e')) right = Math.max(left0 + MIN_SIDE, Math.min(canvas.width, right0 + dx));
  if (handle.includes('n')) top = Math.min(bottom0 - MIN_SIDE, Math.max(0, top0 + dy));
  if (handle.includes('s')) bottom = Math.max(top0 + MIN_SIDE, Math.min(canvas.height, bottom0 + dy));
  if (!keepRatio) return clampBox({ x: left, y: top, w: right - left, h: bottom - top }, canvas);

  const ratio = from.w / from.h;
  let w = right - left;
  let h = bottom - top;
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');
  if (horizontal && vertical) {
    // A corner: the larger change wins.
    if (Math.abs(w - from.w) / from.w >= Math.abs(h - from.h) / from.h) h = w / ratio;
    else w = h * ratio;
  } else if (horizontal) h = w / ratio;
  else w = h * ratio;
  // Fitted on the canvas from the fixed side, keeping the ratio.
  const maxW = handle.includes('w') ? right0 : horizontal ? canvas.width - left0 : canvas.width;
  const maxH = handle.includes('n') ? bottom0 : vertical ? canvas.height - top0 : canvas.height;
  ({ w, h } = fitRatio(w, h, maxW, maxH));
  const x = handle.includes('w') ? right0 - w : horizontal ? left0 : from.x + (from.w - w) / 2;
  const y = handle.includes('n') ? bottom0 - h : vertical ? top0 : from.y + (from.h - h) / 2;
  return clampBox({ x, y, w, h }, canvas);
}

/** An id no control on this panel has, nor any in `also` (the page as Edit layout found it, so Discard never meets a reused id). */
export function freshControlId(panel: PanelDef, also: Iterable<string> = []): string {
  const taken = new Set([...panel.controls.map((c) => c.id), ...also]);
  for (let n = 1; ; n++) {
    const id = `c${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * A new Button, centred where it was dropped, at Medium's key size — about
 * 30 mm, so it fits any screen — on top of the rest. With no screen size
 * known yet, Medium's pixels for this canvas.
 */
export function addButton(panel: PanelDef, at: { x: number; y: number }, screen: ScreenSize | null, also: Iterable<string> = []): { panel: PanelDef; id: string } {
  // About 30 mm on the screen; in a layout made for another size, shown smaller or larger, as many of its pixels as that takes.
  const on = screen ?? { width: panel.size.width, height: panel.size.height };
  const side = newButtonSide(on) / Math.min(on.width / panel.size.width, on.height / panel.size.height);
  const id = freshControlId(panel, also);
  const box = clampBox({ x: at.x - side / 2, y: at.y - side / 2, w: side, h: side }, panel.size);
  return { panel: { ...panel, controls: [...panel.controls, { id, ...box }] }, id };
}

/**
 * A new Slider or Dial (round 5), centred where it was dropped, at its
 * physical size so it fits any screen: a slider about 14 × 60 mm — upright,
 * its long side never more than three-quarters of the panel's shorter side —
 * and a dial about 25 mm across. On top of the rest. A Button is addButton().
 */
export function addControl(panel: PanelDef, kind: ControlKind, at: { x: number; y: number }, screen: ScreenSize | null, also: Iterable<string> = []): { panel: PanelDef; id: string } {
  if (kind === 'button') return addButton(panel, at, screen, also);
  const on = screen ?? { width: panel.size.width, height: panel.size.height };
  // Screen pixels to this layout's pixels, for a layout made for another size.
  const k = 1 / Math.min(on.width / panel.size.width, on.height / panel.size.height);
  let w: number;
  let h: number;
  if (kind === 'slider') {
    const shorter = Math.min(panel.size.width, panel.size.height);
    h = Math.min(mmToPx(on, SLIDER_MM.along) * k, shorter * SLIDER_MAX_OF_SHORTER);
    w = Math.min(mmToPx(on, SLIDER_MM.across) * k, h);
  } else {
    w = h = mmToPx(on, DIAL_MM) * k;
  }
  const id = freshControlId(panel, also);
  const box = clampBox({ x: at.x - w / 2, y: at.y - h / 2, w, h }, panel.size);
  // A rectangle, as every slider and dial is (Ryan, 2026-11-22); a dial square, with Lock proportions on.
  const control: PanelControlDef = kind === 'slider' ? { id, ...box, kind } : { id, ...box, kind, keepRatio: true };
  return { panel: { ...panel, controls: [...panel.controls, control] }, id };
}

/** An empty custom layout for this canvas: where Blank starts, in the editor only — it is never saved empty. */
export function blankPanel(size: { width: number; height: number }): PanelDef {
  return { size: { ...size }, controls: [], preset: CUSTOM_LAYOUT };
}

/**
 * Duplicate (Ctrl+D): one new control on the page being edited, the same
 * size and shape, offset by one grid step and on top, carrying what the
 * selected one shows there — its whole key — as `button`.
 */
export function duplicateControl(panel: PanelDef, page: PageDef, id: string, also: Iterable<string> = [], offset = DUPLICATE_OFFSET): { panel: PanelDef; id: string; button: ButtonDef | null } | null {
  const source = panel.controls.find((c) => c.id === id);
  if (!source) return null;
  const copyId = freshControlId(panel, also);
  const box = clampBox({ x: source.x + offset, y: source.y + offset, w: source.w, h: source.h }, panel.size);
  const copy: PanelControlDef = { ...structuredClone(source), id: copyId, ...box };
  const button = page.buttons[id];
  return { panel: { ...panel, controls: [...panel.controls, copy] }, id: copyId, button: button && Object.keys(button).length > 0 ? structuredClone(button) : null };
}

export function deleteControl(panel: PanelDef, id: string): PanelDef {
  return { ...panel, controls: panel.controls.filter((c) => c.id !== id) };
}

/**
 * Duplicate with several selected: one copy of each, offset by one grid step,
 * each carrying its key; the copies in the order of the originals, on top —
 * the panel's order, never the order they were selected in, so overlapping
 * copies stack, and take touches, as the originals do.
 */
export function duplicateControls(panel: PanelDef, page: PageDef, ids: ReadonlyArray<string>, also: Iterable<string> = [], offset = DUPLICATE_OFFSET): { panel: PanelDef; ids: string[]; buttons: Record<string, ButtonDef> } {
  const taken = [...also];
  let out = panel;
  const made: string[] = [];
  const buttons: Record<string, ButtonDef> = {};
  const chosen = new Set(ids);
  for (const id of panel.controls.filter((c) => chosen.has(c.id)).map((c) => c.id)) {
    const copy = duplicateControl(out, page, id, taken, offset);
    if (!copy) continue;
    out = copy.panel;
    made.push(copy.id);
    taken.push(copy.id);
    if (copy.button) buttons[copy.id] = copy.button;
  }
  return { panel: out, ids: made, buttons };
}

/** Bring to front: last in the panel's order, so on top of everything. */
export function bringToFront(panel: PanelDef, id: string): PanelDef {
  const c = panel.controls.find((k) => k.id === id);
  return c ? { ...panel, controls: [...panel.controls.filter((k) => k.id !== id), c] } : panel;
}

/** Send to back: first in the panel's order, so under everything. */
export function sendToBack(panel: PanelDef, id: string): PanelDef {
  const c = panel.controls.find((k) => k.id === id);
  return c ? { ...panel, controls: [c, ...panel.controls.filter((k) => k.id !== id)] } : panel;
}

/** A control's shape changed: a rectangle's radius kept within its box; the other shapes need none. */
export function setShape(panel: PanelDef, id: string, shape: ShapeName): PanelDef {
  const c = panel.controls.find((k) => k.id === id);
  // A slider or dial is a rectangle (Ryan, 2026-11-22).
  if (!c || (c.kind !== undefined && shape !== 'rectangle')) return panel;
  const { radius, ...rest } = c;
  const next: PanelControlDef = shape === 'rectangle' && radius ? { ...rest, shape, radius } : { ...rest, shape };
  return { ...panel, controls: panel.controls.map((k) => (k.id === id ? next : k)) };
}

/**
 * Whether two controls' real shapes overlap — the honeycomb's touching
 * hexagons, whose boxes overlap, do not. Tested at points across the boxes'
 * shared part, about every 2% of the smaller control: exact enough for a
 * marker, never a reason to block anything.
 */
export function shapesOverlap(a: PanelControlDef, b: PanelControlDef): boolean {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return false;
  const step = Math.max(0.5, Math.min(a.w, a.h, b.w, b.h) / 50);
  for (let y = top + step / 2; y < bottom; y += step) {
    for (let x = left + step / 2; x < right; x += step) {
      if (insideShape(a, x - a.x, y - a.y) && insideShape(b, x - b.x, y - b.y)) return true;
    }
  }
  return false;
}

/** For each control, what is on top of it and what it is on top of, on real shapes (the quiet marker and the inspector's line, 22e). */
export function overlaps(panel: PanelDef): Map<string, { over: string[]; under: string[] }> {
  const out = new Map(panel.controls.map((c) => [c.id, { over: [] as string[], under: [] as string[] }]));
  for (let i = 0; i < panel.controls.length; i++) {
    for (let j = i + 1; j < panel.controls.length; j++) {
      const lower = panel.controls[i];
      const upper = panel.controls[j];
      if (!shapesOverlap(lower, upper)) continue;
      out.get(lower.id)!.under.push(upper.id);
      out.get(upper.id)!.over.push(lower.id);
    }
  }
  return out;
}

/** "Key 5" for each control: numbered in reading order, as keys always are (shared/bulk.ts keyNumber). */
export function controlNames(panel: PanelDef): Map<string, string> {
  return new Map(geometryOfPanel(panel, '').keys.map((k, i) => [k.id, `Key ${i + 1}`]));
}

/** The very-small warning's figure (22f): about how many mm the shorter side is, or null with no warning. */
export function verySmallMm(screen: ScreenSize | null, panel: PanelDef, c: { w: number; h: number }): { mm: number | null } | null {
  // Measured on the screen it is shown on: the panel's own canvas when the screen is not known. A layout
  // made for another size is shown at one scale, the largest that fits (24c).
  const on = screen ?? { width: panel.size.width, height: panel.size.height };
  const scale = Math.min(on.width / panel.size.width, on.height / panel.size.height);
  const w = c.w * scale;
  const h = c.h * scale;
  if (!isVerySmall(on, w, h)) return null;
  const mm = sideMm(on, Math.min(w, h));
  return { mm: mm === null ? null : Math.max(1, Math.round(mm)) };
}

/** What Discard changes would put back (23c): controls added, moved or resized, and deleted since the mode opened. */
export function layoutChanges(before: PanelDef | undefined, after: PanelDef): { added: number; moved: number; deleted: number; reordered: boolean } {
  const was = new Map((before?.controls ?? []).map((c) => [c.id, c]));
  const now = new Map(after.controls.map((c) => [c.id, c]));
  let added = 0;
  let moved = 0;
  let deleted = 0;
  for (const [id, c] of now) {
    const old = was.get(id);
    if (!old) added++;
    else if (old.x !== c.x || old.y !== c.y || old.w !== c.w || old.h !== c.h || shapeName(old.shape) !== shapeName(c.shape) || (old.radius ?? 0) !== (c.radius ?? 0) || !!old.keepRatio !== !!c.keepRatio || old.direction !== c.direction || old.touch !== c.touch) moved++;
  }
  for (const id of was.keys()) if (!now.has(id)) deleted++;
  const order = (p: PanelDef | undefined) => (p?.controls ?? []).filter((c) => was.has(c.id) && now.has(c.id)).map((c) => c.id).join();
  return { added, moved, deleted, reordered: order(before) !== order(after) };
}

/**
 * The page's keys under a new layout: a control's key stays while the control
 * does; a control gone takes its key with it. `extra` sets keys outright (a
 * duplicate's, or the keys Discard brings back).
 */
export function buttonsFor(page: PageDef, panel: PanelDef, extra: Record<string, ButtonDef> = {}): Record<string, ButtonDef> {
  const ids = new Set(panel.controls.map((c) => c.id));
  const out: Record<string, ButtonDef> = {};
  for (const [id, button] of Object.entries(page.buttons)) if (ids.has(id)) out[id] = structuredClone(button);
  for (const [id, button] of Object.entries(extra)) if (ids.has(id)) out[id] = structuredClone(button);
  return out;
}
