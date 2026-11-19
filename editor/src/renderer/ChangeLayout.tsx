import { useState } from 'react';
import type { PageDef, PanelDef } from '../../../src/types.js';
import { keyNamed } from '../shared/bulk.js';
import { regridPage } from '../shared/panel-size.js';
import { isCustomLayout } from '../../../src/panel-presets.js';
import { choiceOf, GridPicker, gridStateOf, panelOf, sizeName, useVirtualScreen, type GridState } from './GridPicker.js';

/**
 * "Change layout…" for one page of a virtual deck (decided 2026-11-17): the
 * fixed grids, the page's own preselected, and — before anything changes — a
 * warning naming every key on that page with no place in the grid picked.
 * One fixed grid to another keeps keys by row and column; only this page
 * changes. **A custom page changed to a fixed grid, and any page changed to
 * Blank, loses every key** (decided 2026-11-17; the warning, 23b). Blank
 * opens Edit layout on the page, empty: nothing is saved until a control is
 * added, and a page left empty stays as it was (2026-11-18). Templates come in
 * round 2b.
 */
export function ChangeLayout({
  deckKey,
  pageName,
  page,
  current,
  onApply,
  onBlank,
  onCancel,
}: {
  deckKey: string;
  pageName: string;
  page: PageDef;
  /** What the page shows now: its own panel, else the deck's default. */
  current: PanelDef | undefined;
  onApply: (panel: PanelDef, remember: ReturnType<typeof choiceOf>) => Promise<string | null>;
  /** Blank chosen: App opens Edit layout on the page, shown empty. */
  onBlank: () => void;
  onCancel: () => void;
}) {
  const screen = useVirtualScreen(deckKey);
  const fromCustom = isCustomLayout(current);
  const [grid, setGrid] = useState<GridState>(() => gridStateOf(fromCustom ? undefined : current));
  // A custom page's own choice is none of the fixed grids: Blank, the custom layout's starting point, stands for it (Claude's call).
  const [blank, setBlank] = useState(fromCustom);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = screen ? panelOf(screen, grid) : null;
  const dropped = panel ? regridPage(page, current, panel).dropped : [];
  // Everything goes: to Blank, or from a custom layout to a fixed grid.
  const keys = Object.values(page.buttons).filter((b) => Object.keys(b).length > 0).length;
  const controls = current?.controls.length ?? 0;
  const losesAll = blank || fromCustom;

  const apply = async () => {
    if (blank) {
      onBlank();
      return;
    }
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
        {current ? <span className="muted"> — now {fromCustom ? 'a custom layout' : sizeName(current.preset)}</span> : null}. Only this page changes.
      </p>
      {screen === null ? (
        <p className="muted small">Asking the daemon for the screen's size…</p>
      ) : (
        <GridPicker
          screen={screen}
          size={grid.size}
          rows={grid.rows}
          columns={grid.columns}
          onChange={(next) => {
            setBlank(false);
            setGrid((g) => ({ ...g, ...next }));
          }}
          blank={{ chosen: blank, onChoose: () => setBlank(true) }}
        />
      )}
      {losesAll && (controls > 0 || keys > 0) && (
        <div className="warning-text" data-change-loses-all="">
          <p>
            {blank ? `“${pageName}” starts again from Blank. Every key on this page is lost:` : `“${pageName}” becomes a grid of buttons. Every key on this page is lost, buttons included:`}
          </p>
          <ul className="link-list">
            {fromCustom && <li>{controls} {controls === 1 ? 'control' : 'controls'} — position, size and shape</li>}
            {keys > 0 && <li>{keys} {keys === 1 ? 'key' : 'keys'} — actions, icons and labels</li>}
          </ul>
          {blank && <p className="muted small">Nothing changes until you add a control. Left empty, the page stays as it is.</p>}
        </div>
      )}
      {!losesAll && dropped.length > 0 && (
        <p className="warning-text" data-change-dropped={dropped.length}>
          {dropped.length === 1 ? '1 key has' : `${dropped.length} keys have`} no place in that grid and will be removed from this page:{' '}
          {dropped.map((d) => keyNamed(d.button, String(d.number))).join(', ')}.
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
      <div className="button-row">
        <button className={losesAll && keys > 0 ? 'danger' : 'primary'} disabled={(panel === null && !blank) || busy} onClick={() => void apply()} data-change-layout-apply>
          {blank ? 'Start blank' : !losesAll && dropped.length > 0 ? 'Remove them and change' : 'Change layout'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
