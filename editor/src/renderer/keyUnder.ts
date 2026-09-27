/** A key in a grid: which deck, and which key on it. */
export interface KeyRef {
  serial: string;
  index: number;
}

/**
 * The key under a window point, found with elementFromPoint, and the deck it
 * belongs to (DeckGrid's `data-deck` and `data-key-index`). Shared by the
 * key-onto-key drag and the library drag: with several grids on screen, an
 * index alone would name a key on every one of them.
 */
export function keyUnder(x: number, y: number): KeyRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key-index]');
  if (!el || el.dataset.deck === undefined) return null;
  return { serial: el.dataset.deck, index: Number(el.dataset.keyIndex) };
}
