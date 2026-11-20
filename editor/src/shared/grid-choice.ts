/**
 * The grid last picked for a virtual deck's page, per deck: New page
 * preselects it (decided 2026-11-17). Editor preferences, by deck key, never
 * config.json. Import-free apart from the daemon's limits, so the main
 * process checks what the window sends with the same rule the window uses.
 */
import { geometryOfPanel } from '../../../src/geometry.js';
import { makePanel, MAX_CUSTOM_COLUMNS, MAX_CUSTOM_ROWS, type Panel, type PanelSize, type ScreenSize } from '../../../src/panel-presets.js';
import type { PanelDef } from '../../../src/types.js';
import { validSerial } from './deck-positions.js';

export interface GridChoice {
  /** A fixed grid, or 'blank': New page and Change layout… also offer an empty custom layout (round 2a). */
  size: PanelSize | 'blank';
  /** Grid Size's rows and columns; absent for a preset. */
  rows?: number;
  columns?: number;
}

/** At most this many decks remembered: a guard against a corrupt preferences file, not a limit. */
export const MAX_GRID_CHOICES = 32;

const SIZES = new Set<string>(['small', 'medium', 'large', 'custom', 'blank']);
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

/** A choice as stored or sent, or null when it is not one. */
export function cleanGridChoice(value: unknown): GridChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.size !== 'string' || !SIZES.has(v.size)) return null;
  if (v.size !== 'custom') return { size: v.size as PanelSize | 'blank' };
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

/**
 * The fixed grids a virtual deck's page can have: Small, Medium, Large, and
 * Grid Size — the person's rows and columns, stored as `"preset": "custom"`
 * (renamed for display only, 2026-11-17, so existing configs keep their
 * meaning).
 */
export const SIZE_NAMES: Record<PanelSize, string> = { small: 'Small', medium: 'Medium', large: 'Large', custom: 'Grid Size' };

/** Grid Size's rows and columns from their fields: whole numbers, from 1 to the maximum (panel-presets clamps). */
export function customOf(rows: string, columns: string): { rows: number; columns: number } {
  return { rows: Math.max(1, Math.floor(Number(rows)) || 1), columns: Math.max(1, Math.floor(Number(columns)) || 1) };
}

/** What the picker holds: a size, and Grid Size's fields as typed. */
export interface GridState {
  size: PanelSize;
  rows: string;
  columns: string;
}

/** The picker set to what a panel is: its preset, and its rows and columns for Grid Size. */
export function gridStateOf(panel: PanelDef | undefined): GridState {
  if (!panel) return { size: 'medium', rows: '3', columns: '8' };
  const g = geometryOfPanel(panel, '');
  const size = panel.preset && panel.preset in SIZE_NAMES ? (panel.preset as PanelSize) : 'custom';
  // The picker's rows run along the short side (makePanel); a portrait canvas's
  // rows on screen are its columns there (Codex, PR #6).
  const portrait = panel.size.height > panel.size.width;
  const [rows, columns] = portrait ? [g.columns, g.rows] : [g.rows, g.columns];
  return { size, rows: String(Math.max(1, rows)), columns: String(Math.max(1, columns)) };
}

/** The picker's grid for a remembered choice: Blank remembers no grid, so Medium stands behind it. */
export function gridStateOfChoice(choice: GridChoice): GridState {
  return { size: choice.size === 'blank' ? 'medium' : choice.size, rows: String(choice.rows ?? 3), columns: String(choice.columns ?? 8) };
}

export function choiceOf(state: GridState): GridChoice {
  return state.size === 'custom' ? { size: 'custom', ...customOf(state.rows, state.columns) } : { size: state.size };
}

/** The panel a choice makes on this screen, by the daemon's own rule. */
export function panelOf(screen: ScreenSize, state: GridState): Panel {
  return makePanel(screen, state.size, state.size === 'custom' ? customOf(state.rows, state.columns) : undefined);
}

