import type { CSSProperties, ReactNode } from 'react';
import type { Choice } from './model.js';

interface Props {
  serial: string;
  name: string;
  /** Columns and rows from the daemon's geometry; null for a moment while the daemon's lists disagree. */
  size: { rows: number; columns: number } | null;
  /** The deck the toolbar, inspector and key selection act on. */
  focused: boolean;
  /** This deck's pages, and the one it shows; empty with no layout in this profile. */
  pages: Choice[];
  page: string;
  disabled: boolean;
  onFocus: () => void;
  onPage: (page: string) => void;
  /** The grid, or the card saying why there is none. */
  children: ReactNode;
}

/**
 * One deck among several shown (scope §10, "Multi-deck editing"): a header
 * with its name, columns × rows (8 × 4, as decks are named) and, on the focused deck, the "Editing"
 * marker; then its grid. With one deck shown there is no panel at all — the
 * grid sits in the well as it always has.
 *
 * Page tabs stay in the toolbar for the focused deck; every other deck
 * carries only this compact Page ▾, which shows the page on the deck as a tab
 * does. Clicking the header focuses the deck.
 */
export function DeckPanel({ serial, name, size, focused, pages, page, disabled, onFocus, onPage, children }: Props) {
  return (
    <section
      className={focused ? 'deck-panel deck-panel-focused' : 'deck-panel'}
      data-multideck=""
      data-deck-panel={serial}
      style={size ? ({ '--columns': size.columns } as CSSProperties) : undefined}
    >
      <header className="deck-panel-header">
        <button className="deck-panel-name" onClick={onFocus} disabled={focused} title={focused ? undefined : `Edit ${name}`}>
          {name}
        </button>
        {size && (
          <span className="deck-panel-size muted">
            {size.columns} × {size.rows}
          </span>
        )}
        {focused && <span className="deck-panel-editing">Editing</span>}
        <span className="toolbar-spacer" />
        {!focused && pages.length > 0 && (
          <label className="deck-panel-page">
            <span className="muted">Page</span>
            <select aria-label={`Page on ${name}`} value={page} disabled={disabled} onChange={(e) => onPage(e.target.value)}>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {children}
    </section>
  );
}
