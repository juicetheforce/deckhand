/** A key in a grid: which deck, and which key on it, by control id. */
export interface KeyRef {
  serial: string;
  key: string;
}

/**
 * The key under a window point, found with elementFromPoint, and the deck it
 * belongs to (DeckGrid's `data-deck` and `data-key`). Shared by the
 * key-onto-key drag and the library drag: with several grids on screen, a
 * key's id alone would name a key on every one of them.
 */
export function keyUnder(x: number, y: number): KeyRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key]');
  if (!el || el.dataset.deck === undefined || el.dataset.key === undefined) return null;
  return { serial: el.dataset.deck, key: el.dataset.key };
}
