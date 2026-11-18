import { useEffect, useId, useState } from 'react';
import { gridFor, MAX_CUSTOM_COLUMNS, MAX_CUSTOM_ROWS, PRESET_SIZES, type Grid, type PanelSize, type ScreenSize } from '../../../src/panel-presets.js';
import { customOf, SIZE_NAMES } from '../shared/grid-choice.js';

// The grid picker, shared by Settings › Decks' Add (the deck's default size) and the
// main window's New page and Change layout…. Its state and the panels it makes are pure, in shared/grid-choice.ts, so they are tested without a DOM.
export { choiceOf, customOf, gridStateOf, gridStateOfChoice, panelOf, SIZE_NAMES, type GridState } from '../shared/grid-choice.js';

/** A stored preset's display name; anything else (a hand-edited value) reads as Grid Size. */
export function sizeName(preset: string | undefined): string {
  return preset && preset in SIZE_NAMES ? SIZE_NAMES[preset as PanelSize] : SIZE_NAMES.custom;
}

/** "3 × 8 keys, about 26 mm" — a size as the picker offers it. */
export function describeGrid(grid: Grid): string {
  const keys = `${grid.rows} × ${grid.columns} keys`;
  return grid.keyMm !== null ? `${keys}, about ${Math.round(grid.keyMm)} mm` : `${keys}, ${grid.keyPx} px`;
}

/** The picker: Small, Medium, Large with what each gives on this screen, or Grid Size's rows and columns. */
export function GridPicker({ screen, size, rows, columns, onChange }: {
  screen: ScreenSize;
  size: PanelSize;
  rows: string;
  columns: string;
  onChange: (next: { size?: PanelSize; rows?: string; columns?: string }) => void;
}) {
  // Two pickers in one window must not share a radio group.
  const group = useId();
  const custom = customOf(rows, columns);
  const grid = gridFor(screen, size, custom);
  return (
    <div className="vd-sizes" role="radiogroup" aria-label="Grid size">
      {[...PRESET_SIZES, 'custom' as const].map((s) => (
        <label key={s} className="vd-size" data-vd-size={s}>
          <input
            type="radio"
            name={group}
            checked={size === s}
            // Grid Size starts from the size picked before it, so its fields are never empty.
            onChange={() => onChange(s === 'custom' ? { size: s, rows: String(grid.rows), columns: String(grid.columns) } : { size: s })}
          />
          <span className="vd-size-name">{SIZE_NAMES[s]}</span>
          <span className="muted small">{s === 'custom' ? 'set the rows and columns' : describeGrid(gridFor(screen, s))}</span>
        </label>
      ))}
      {size === 'custom' && (
        <div className="sp-fields">
          <label className="sp-field sp-field-port">
            <span className="sp-field-label">Rows</span>
            <input className="sp-input" type="number" min={1} max={MAX_CUSTOM_ROWS} value={rows} onChange={(e) => onChange({ rows: e.target.value })} data-vd-field="rows" />
          </label>
          <label className="sp-field sp-field-port">
            <span className="sp-field-label">Columns</span>
            <input className="sp-input" type="number" min={1} max={MAX_CUSTOM_COLUMNS} value={columns} onChange={(e) => onChange({ columns: e.target.value })} data-vd-field="columns" />
          </label>
          <span className="muted small vd-custom-result">
            {describeGrid(grid)} · at most {MAX_CUSTOM_ROWS} × {MAX_CUSTOM_COLUMNS}
          </span>
        </div>
      )}
      {grid.verySmall && (
        <p className="muted small vd-warning" data-vd-warning="small">
          These keys are very small, and may be hard to press. You can still use them.
        </p>
      )}
    </div>
  );
}

/** A virtual deck's screen, to size a grid for it: its pixels and, when the daemon knows them, millimetres. Null until known. */
export function useVirtualScreen(key: string | null): ScreenSize | null {
  const [screen, setScreen] = useState<{ key: string; size: ScreenSize | null } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void window.deckhand.virtualScreenSize(key).then((size) => alive && setScreen({ key, size }));
    return () => {
      alive = false;
    };
  }, [key]);
  return screen && screen.key === key ? screen.size : null;
}
