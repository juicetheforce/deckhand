/**
 * The grid last picked for a virtual deck's page, per deck: New page
 * preselects it (decided 2026-11-17). Editor preferences, by deck key, never
 * config.json. Import-free apart from the daemon's limits, so the main
 * process checks what the window sends with the same rule the window uses.
 */
import { MAX_CUSTOM_COLUMNS, MAX_CUSTOM_ROWS, type PanelSize } from '../../../src/panel-presets.js';
import { validSerial } from './deck-positions.js';

export interface GridChoice {
  size: PanelSize;
  /** Grid Size's rows and columns; absent for a preset. */
  rows?: number;
  columns?: number;
}

/** At most this many decks remembered: a guard against a corrupt preferences file, not a limit. */
export const MAX_GRID_CHOICES = 32;

const SIZES = new Set<string>(['small', 'medium', 'large', 'custom']);
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

/** A choice as stored or sent, or null when it is not one. */
export function cleanGridChoice(value: unknown): GridChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.size !== 'string' || !SIZES.has(v.size)) return null;
  if (v.size !== 'custom') return { size: v.size as PanelSize };
  return whole(v.rows, MAX_CUSTOM_ROWS) && whole(v.columns, MAX_CUSTOM_COLUMNS) ? { size: 'custom', rows: v.rows, columns: v.columns } : null;
}

/** What was stored, keeping only well-formed entries, newest last. */
export function readGridChoices(stored: unknown): Record<string, GridChoice> {
  const out: Record<string, GridChoice> = {};
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [serial, choice] of Object.entries(stored as Record<string, unknown>).slice(-MAX_GRID_CHOICES)) {
    const clean = cleanGridChoice(choice);
    if (validSerial(serial) && clean) out[serial] = clean;
  }
  return out;
}

/** The stored choices with this deck's set, moved to the end so the oldest go first. */
export function withGridChoice(stored: Record<string, GridChoice>, serial: string, choice: GridChoice): Record<string, GridChoice> {
  const { [serial]: _old, ...rest } = stored;
  const next = { ...rest, [serial]: choice };
  return Object.fromEntries(Object.entries(next).slice(-MAX_GRID_CHOICES));
}
