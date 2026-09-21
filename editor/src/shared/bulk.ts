/**
 * Where keys land in the bulk operations: copy, paste, copy to page or device, duplicate, clear and swap.
 *
 * Every operation comes down to "write these slots on this page", which is one
 * `putButtons` edit — so a paste of ten keys is validated, saved and reloaded
 * once, and can never land half-way. This module decides *what* to write; the
 * main process only writes it (config-document.ts).
 *
 * Positions are rows and columns from the daemon's geometry, never indices:
 * index 20 is a different place on the XL and nowhere on a
 * 15-key Original V2, so a key keeps its place in the grid and anything with no
 * place on the target is skipped and named.
 *
 * Pure, and imports nothing that touches Node: the renderer uses it, and
 * test/bulk.test.ts runs it in plain Node.
 */
import type { ActionDef, ButtonDef, LayoutDef, PageDef } from '../../../src/types.js';
import { keepResolvableNavigation } from './links.js';

/** The part of a deck's geometry (the socket's `decks`) placement needs. */
export interface KeyGrid {
  keys: ReadonlyArray<{ index: number; row: number; column: number }>;
}

/** One slot to write. `null` empties it. */
export interface ButtonWrite {
  index: number;
  button: ButtonDef | null;
}

/** A copied key: its button, and where it sat relative to the top-left of what was copied. */
export interface ClipKey {
  /** Rows and columns below and right of the copied block's top-left corner. */
  rowOffset: number;
  columnOffset: number;
  /** Where it was copied from, to name it when it cannot be placed. */
  sourceIndex: number;
  button: ButtonDef;
}

/**
 * The editor's clipboard. It lives in the renderer's memory only: not the
 * system clipboard, and not saved.
 */
export interface Clipboard {
  keys: ClipKey[];
  /** The copied block's top-left corner on the page it came from. */
  origin: { row: number; column: number };
}

export interface Placement {
  writes: ButtonWrite[];
  /** Copied keys with no position on the target deck, which were not written. */
  skipped: ClipKey[];
  /** Keys that were written but lost a Go to page whose target is not in the target layout. */
  lostNavigation: Array<{ index: number; key: ClipKey }>;
}

function positionOf(grid: KeyGrid, index: number): { row: number; column: number } | null {
  const key = grid.keys.find((k) => k.index === index);
  return key ? { row: key.row, column: key.column } : null;
}

function indexAt(grid: KeyGrid, row: number, column: number): number | null {
  return grid.keys.find((k) => k.row === row && k.column === column)?.index ?? null;
}

/** Key indices sorted into reading order: row by row, left to right. Indices not on the deck are dropped. */
export function readingOrder(grid: KeyGrid, indices: Iterable<number>): number[] {
  const wanted = new Set(indices);
  return grid.keys
    .filter((k) => wanted.has(k.index))
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((k) => k.index);
}

/**
 * Shift+click: every key from `from` to `to` in reading order, inclusive, the
 * way a file manager selects a run of icons.
 */
export function rangeSelection(grid: KeyGrid, from: number, to: number): number[] {
  const all = readingOrder(grid, grid.keys.map((k) => k.index));
  const a = all.indexOf(from);
  const b = all.indexOf(to);
  if (a === -1 || b === -1) return b === -1 ? [] : [to];
  return all.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * Copy the selected keys. Empty slots are not copied, so a paste never empties
 * a key — it only ever writes buttons. Buttons are deep-copied: editing the
 * page afterwards does not change what is on the clipboard. Null when nothing
 * selected holds a button.
 */
export function copyKeys(page: PageDef, grid: KeyGrid, indices: Iterable<number>): Clipboard | null {
  const found: Array<{ index: number; row: number; column: number; button: ButtonDef }> = [];
  for (const index of readingOrder(grid, indices)) {
    const button = page.buttons[String(index)];
    const at = positionOf(grid, index);
    if (!button || Object.keys(button).length === 0 || !at) continue;
    found.push({ index, ...at, button });
  }
  if (found.length === 0) return null;
  const origin = { row: Math.min(...found.map((f) => f.row)), column: Math.min(...found.map((f) => f.column)) };
  return {
    origin,
    keys: found.map((f) => ({
      rowOffset: f.row - origin.row,
      columnOffset: f.column - origin.column,
      sourceIndex: f.index,
      button: structuredClone(f.button),
    })),
  };
}

/**
 * Where a clipboard lands on a deck with `grid`, with its top-left corner at
 * `anchor`, into `layout`. Occupied keys are replaced, without
 * confirmation. A key whose position is off the target deck is skipped. A
 * `page` action that does not resolve in `layout` is dropped, keeping the rest
 * of the key.
 */
export function placeClipboard(clip: Clipboard, anchor: { row: number; column: number }, grid: KeyGrid, layout: LayoutDef): Placement {
  const placement: Placement = { writes: [], skipped: [], lostNavigation: [] };
  for (const key of clip.keys) {
    const index = indexAt(grid, anchor.row + key.rowOffset, anchor.column + key.columnOffset);
    if (index === null) {
      placement.skipped.push(key);
      continue;
    }
    const button = structuredClone(key.button);
    let dropped = false;
    for (const where of ['action', 'onRelease'] as const) {
      const action = button[where] as ActionDef | undefined;
      if (!action) continue;
      const kept = keepResolvableNavigation(action, layout);
      if (!kept.dropped) continue;
      dropped = true;
      if (kept.action) button[where] = kept.action;
      else delete button[where];
    }
    if (dropped) placement.lostNavigation.push({ index, key });
    // A button left with nothing on it is an empty slot, written as one.
    placement.writes.push({ index, button: Object.keys(button).length === 0 ? null : button });
  }
  return placement;
}

/**
 * Where a paste's top-left corner goes: the first selected key in reading
 * order, or — with nothing selected — where the keys were copied from.
 */
export function pasteAnchor(grid: KeyGrid, selected: Iterable<number>, clip: Clipboard): { row: number; column: number } {
  const first = readingOrder(grid, selected)[0];
  return (first !== undefined ? positionOf(grid, first) : null) ?? clip.origin;
}

export type Duplication = { ok: true; writes: ButtonWrite[]; created: number[] } | { ok: false; error: string };

/**
 * Duplicate the selected keys onto the same page. Each copy goes into the next
 * empty key after its original in reading order, wrapping round to the top —
 * so duplicating a key puts its twin beside it where there is room. All or
 * nothing: if the page has too few empty keys, nothing is written.
 *
 * Same page, so navigation needs no fixing. `created` is where the copies went,
 * in the order of their originals, for the editor to select them.
 */
export function duplicateKeys(page: PageDef, grid: KeyGrid, indices: Iterable<number>): Duplication {
  const order = readingOrder(grid, grid.keys.map((k) => k.index));
  const occupied = new Set(order.filter((i) => {
    const button = page.buttons[String(i)];
    return button !== undefined && Object.keys(button).length > 0;
  }));
  const sources = readingOrder(grid, indices).filter((i) => occupied.has(i));
  if (sources.length === 0) return { ok: false, error: 'Nothing to duplicate: the selected keys are empty.' };

  const writes: ButtonWrite[] = [];
  const created: number[] = [];
  for (const source of sources) {
    const start = order.indexOf(source);
    let target: number | undefined;
    for (let step = 1; step < order.length; step++) {
      const candidate = order[(start + step) % order.length];
      if (!occupied.has(candidate)) {
        target = candidate;
        break;
      }
    }
    if (target === undefined) {
      const free = order.length - occupied.size + created.length;
      return {
        ok: false,
        error:
          sources.length === 1
            ? 'This page has no empty key to duplicate into.'
            : `Duplicating ${sources.length} keys needs ${sources.length} empty keys; this page has ${free}.`,
      };
    }
    occupied.add(target);
    created.push(target);
    writes.push({ index: target, button: structuredClone(page.buttons[String(source)]) });
  }
  return { ok: true, writes, created };
}

/** Clear button, for every selected key: an empty, dark slot. No confirmation, however many. */
export function clearKeys(page: PageDef, indices: Iterable<number>): ButtonWrite[] {
  return [...new Set(indices)].filter((i) => page.buttons[String(i)] !== undefined).map((index) => ({ index, button: null }));
}

/**
 * Key onto key: the whole button moves, and dropping onto an
 * occupied key swaps the two. Nothing is cleared or defaulted.
 */
export function swapKeys(page: PageDef, from: number, to: number): ButtonWrite[] {
  if (from === to) return [];
  const a = page.buttons[String(from)];
  const b = page.buttons[String(to)];
  return [
    { index: to, button: a ? structuredClone(a) : null },
    { index: from, button: b ? structuredClone(b) : null },
  ];
}

/** A key named for a message: its label if it has one, and its position as the deck numbers keys (from 1). */
export function keyName(button: ButtonDef | undefined, index: number): string {
  return button?.label ? `“${button.label}” (key ${index + 1})` : `key ${index + 1}`;
}
