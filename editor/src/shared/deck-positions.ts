/**
 * Where each deck sits on the editor's canvas (scope §10, "Multi-deck
 * editing"): the top-left of its grid — key 1's corner — in key units, one
 * unit being a key and the gap after it. Key units, not pixels, so a position
 * means the same at any zoom and window size.
 *
 * Global, by serial, in the editor preferences; never config.json. A hidden
 * deck keeps its position, so showing it again puts it back.
 */
export interface DeckPosition {
  x: number;
  y: number;
}

export type DeckPositions = Record<string, DeckPosition>;

/** More than anyone has decks; the oldest is forgotten past it. */
export const MAX_DECK_POSITIONS = 32;

/** Far beyond any arrangement on a desk; a stored value past it is not a position. */
const LIMIT = 10_000;

export function validPosition(value: unknown): value is DeckPosition {
  if (value === null || typeof value !== 'object') return false;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= LIMIT && Math.abs(y) <= LIMIT;
}

export function validSerial(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/** What was stored, keeping only well-formed entries (a hand-edited file may hold anything). */
export function readPositions(stored: unknown): DeckPositions {
  const out: DeckPositions = {};
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [serial, position] of Object.entries(stored as Record<string, unknown>).slice(-MAX_DECK_POSITIONS)) {
    if (validSerial(serial) && validPosition(position)) out[serial] = { x: position.x, y: position.y };
  }
  return out;
}

/** The positions with this deck's set: moved to the end as the newest, the oldest dropped past the cap. */
export function withPosition(positions: DeckPositions, serial: string, position: DeckPosition): DeckPositions {
  const rest = Object.entries(positions).filter(([s]) => s !== serial);
  return Object.fromEntries([...rest.slice(-(MAX_DECK_POSITIONS - 1)), [serial, { x: position.x, y: position.y }]]);
}
