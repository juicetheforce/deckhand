import type { ReactNode } from 'react';
import type { Placement } from './DeckCanvas.js';
import { Dropdown } from './Dropdown.js';
import { LockIcon } from './icons.js';
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
  /** A virtual deck's Change layout… for the page shown; absent on a Stream Deck, or with no page. */
  onChangeLayout?: () => void;
  /** The grid, or the card saying why there is none. */
  children: ReactNode;
  /** On the canvas: where it is drawn, and its header picks it up. */
  placement: Placement;
}

/**
 * One shown deck in its frame, one deck or several (the frame round,
 * 2026-11-18): a header with its name, columns × rows (8 × 4, as decks are
 * named), a virtual deck's Change layout…, and the Page ▾; then its grid.
 *
 * Every header carries the Page ▾, the focused deck's included, so a header
 * is the same whatever the number or position of decks; the toolbar's page
 * tabs stay for the focused deck, for quick switching. What exists only to
 * arrange several decks — the grip, the Editing marker, the lock — is drawn
 * only with two or more (`data-multideck`, which check:one-deck counts).
 * Clicking its name focuses the deck; dragging its header moves it on the
 * canvas (DeckCanvas.tsx).
 */
export function DeckPanel({ serial, name, size, focused, pages, page, disabled, onFocus, onPage, onChangeLayout, children, placement }: Props) {
  const { arrange } = placement;
  const classes = [
    'deck-panel',
    focused && arrange && 'deck-panel-focused',
    placement.dragging && 'deck-panel-dragging',
    placement.refused && 'deck-panel-refused',
    (placement.locked || !arrange) && 'deck-panel-locked',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes} data-deck-panel={serial} style={placement.style}>
      <header className="deck-panel-header" onPointerDown={arrange ? placement.onGrab : undefined} title={arrange && !placement.locked ? 'Drag to move' : undefined}>
        {arrange && !placement.locked && (
          <span className="deck-panel-grip" aria-hidden="true" data-multideck="">
            ⠿
          </span>
        )}
        <button className="deck-panel-name" onClick={onFocus} disabled={focused} title={focused ? name : `Edit ${name}`}>
          {name}
        </button>
        {size && (
          <span className="deck-panel-size muted">
            {size.columns} × {size.rows}
          </span>
        )}
        {focused && arrange && (
          <span className="deck-panel-editing" data-multideck="">
            Editing
          </span>
        )}
        <span className="toolbar-spacer" />
        {onChangeLayout && (
          <button className="deck-panel-change-layout" disabled={disabled} onClick={onChangeLayout} title={`Change the layout of this page on ${name}`}>
            Change layout…
          </button>
        )}
        {pages.length > 0 && (
          <label className="deck-panel-page">
            <span className="muted">Page</span>
            <Dropdown aria-label={`Page on ${name}`} value={page} options={pages.map((p) => ({ value: p.id, label: p.label }))} disabled={disabled} onChange={onPage} />
          </label>
        )}
        {arrange && (
          <button
            className="deck-panel-lock"
            data-multideck=""
            aria-pressed={placement.locked}
            aria-label={placement.locked ? `Unlock ${name}'s position` : `Lock ${name} in place`}
            title={placement.locked ? 'Locked in place — click to let it be dragged' : 'Lock in place, so it cannot be dragged by accident'}
            onClick={() => placement.onLock(!placement.locked)}
          >
            <LockIcon locked={placement.locked} size={16} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}
