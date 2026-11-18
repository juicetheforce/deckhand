import { useState } from 'react';
import type { PageDef, PanelDef } from '../../../src/types.js';
import { keyNamed } from '../shared/bulk.js';
import { regridPage } from '../shared/panel-size.js';
import { choiceOf, GridPicker, gridStateOf, panelOf, sizeName, useVirtualScreen, type GridState } from './GridPicker.js';

/**
 * "Change layout…" for one page of a virtual deck (decided 2026-11-17): the
 * fixed grids, the page's own preselected, and — before anything changes — a
 * warning naming every key on that page with no place in the grid picked.
 * One fixed grid to another keeps keys by row and column; only this page
 * changes. Blank and templates come with custom layouts (round 2).
 */
export function ChangeLayout({
  deckKey,
  pageName,
  page,
  current,
  onApply,
  onCancel,
}: {
  deckKey: string;
  pageName: string;
  page: PageDef;
  /** What the page shows now: its own panel, else the deck's default. */
  current: PanelDef | undefined;
  onApply: (panel: PanelDef, remember: ReturnType<typeof choiceOf>) => Promise<string | null>;
  onCancel: () => void;
}) {
  const screen = useVirtualScreen(deckKey);
  const [grid, setGrid] = useState<GridState>(() => gridStateOf(current));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = screen ? panelOf(screen, grid) : null;
  const dropped = panel ? regridPage(page, current, panel).dropped : [];

  const apply = async () => {
    if (!panel) return;
    setBusy(true);
    const failure = await onApply(panel, choiceOf(grid));
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  return (
    <div className="confirm-card glass change-layout" role="dialog" aria-label="Change layout" data-change-layout={pageName}>
      <p>
        Change the layout of <strong>“{pageName}”</strong>
        {current ? <span className="muted"> — now {sizeName(current.preset)}</span> : null}. Only this page changes.
      </p>
      {screen === null ? (
        <p className="muted small">Asking the daemon for the screen's size…</p>
      ) : (
        <GridPicker screen={screen} size={grid.size} rows={grid.rows} columns={grid.columns} onChange={(next) => setGrid((g) => ({ ...g, ...next }))} />
      )}
      {dropped.length > 0 && (
        <p className="warning-text" data-change-dropped={dropped.length}>
          {dropped.length === 1 ? '1 key has' : `${dropped.length} keys have`} no place in that grid and will be removed from this page:{' '}
          {dropped.map((d) => keyNamed(d.button, String(d.number))).join(', ')}.
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
      <div className="button-row">
        <button className="primary" disabled={panel === null || busy} onClick={() => void apply()} data-change-layout-apply>
          {dropped.length > 0 ? 'Remove them and change' : 'Change layout'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
