import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Placement } from './DeckCanvas.js';
import { Dropdown } from './Dropdown.js';
import { BackgroundIcon, LockIcon } from './icons.js';
import type { Choice } from './model.js';

interface Props {
  serial: string;
  name: string;
  /**
   * What the header says of its size: columns × rows ("8 × 4"), or on a
   * virtual deck's custom page, which has none, the screen's resolution
   * ("1920 × 720") — Ryan, 2026-11-18. Null for a moment while the daemon's
   * lists disagree.
   */
  size: string | null;
  /** The deck the toolbar, inspector and key selection act on. */
  focused: boolean;
  /** This deck's pages, and the one it shows; empty with no layout in this profile. */
  pages: Choice[];
  page: string;
  disabled: boolean;
  onFocus: () => void;
  onPage: (page: string) => void;
  /** A virtual deck's Change layout… for a grid page shown; absent on a custom page, a Stream Deck, or with no page. */
  onChangeLayout?: () => void;
  /**
   * A virtual deck's Edit layout, for a custom page shown; absent on a grid
   * page and on a Stream Deck. `open`: the mode is open on this deck, so the
   * button is lit, pressing it is Done, and Discard changes (`changed`: dimmed
   * until something has) and Done sit beside it.
   */
  editLayout?: { open: boolean; changed: boolean; onOpen: () => void; onDiscard: () => void; onDone: () => void };
  /**
   * A virtual deck's background icon (19b, 24a), on every page, grid or
   * custom: it opens the page's background panel under it, lit while that is
   * open, dimmed in Edit layout. Absent on a Stream Deck.
   */
  background?: { open: boolean; dimmed: boolean; onToggle: (anchor: DOMRect) => void };
  /** In Edit layout: the Page ▾ and Change layout… are dimmed (the person edits the page they entered on). */
  pageLocked?: boolean;
  /**
   * The width the header needs, in pixels at 100%, reported as it changes:
   * a virtual deck's frame is never narrower than its header (Ryan,
   * 2026-11-18), so the canvas widens it to this.
   */
  onHeaderNeed?: (px: number) => void;
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
 * **Any click on the frame that is not a drag focuses the deck** — its header,
 * its name, any empty part of the frame (Ryan, 2026-11-20); a key's own click
 * focuses it as before, and what is a control of its own (a button, the Page
 * ▾) does its own job. Dragging its header moves it on the canvas
 * (DeckCanvas.tsx).
 */
/** A press that moves this far is a drag, and its click focuses nothing (DeckCanvas.tsx DRAG_START_PX). */
const CLICK_SLOP_PX = 4;
/** What does its own job when clicked, so a click on it is not a click on the frame. */
const OWN_CLICK = 'button, input, select, textarea, label, a, [data-dropdown], [role="listbox"], [role="option"], .key';

/** A deck name gets this much of its own width at most when the frame is widened for the header; longer ones end in an ellipsis. */
const NAME_ROOM_PX = 160;

export function DeckPanel({ serial, name, size, focused, pages, page, disabled, onFocus, onPage, onChangeLayout, editLayout, background, pageLocked = false, onHeaderNeed, children, placement }: Props) {
  const { arrange } = placement;
  const header = useRef<HTMLElement>(null);
  /** Where the last press on the frame began, to tell a click from a drag. */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const clickFrame = (e: ReactMouseEvent<HTMLElement>) => {
    const from = pressedAt.current;
    pressedAt.current = null;
    if (focused || e.button !== 0 || (e.target as Element).closest(OWN_CLICK)) return;
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) >= CLICK_SLOP_PX) return;
    onFocus();
  };
  // The header's need, measured where layout is known: offsetWidth ignores the canvas's zoom.
  useLayoutEffect(() => {
    const el = header.current;
    if (!el || !onHeaderNeed) return;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const items = [...el.children].filter((c) => !c.classList.contains('toolbar-spacer')) as HTMLElement[];
    let need = 0;
    for (const item of items) need += item.classList.contains('deck-panel-name') ? Math.min(item.scrollWidth, NAME_ROOM_PX) : item.offsetWidth;
    need += gap * Math.max(0, items.length - 1);
    // The frame's padding and border either side (canvas.ts PAD_X_PX).
    const frame = el.closest('.deck-panel') as HTMLElement | null;
    const pad = frame ? frame.offsetWidth - frame.clientWidth + parseFloat(getComputedStyle(frame).paddingLeft) + parseFloat(getComputedStyle(frame).paddingRight) : 28;
    onHeaderNeed(Math.ceil(need + pad));
  });
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
    <section
      className={classes}
      data-deck-panel={serial}
      style={placement.style}
      onPointerDownCapture={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={clickFrame}
    >
      <header ref={header} className="deck-panel-header" onPointerDown={arrange ? placement.onGrab : undefined} title={arrange && !placement.locked ? 'Drag to move' : undefined}>
        {arrange && !placement.locked && (
          <span className="deck-panel-grip" aria-hidden="true" data-multideck="">
            ⠿
          </span>
        )}
        <button className="deck-panel-name" onClick={onFocus} disabled={focused} title={focused ? name : `Edit ${name}`}>
          {name}
        </button>
        {size && <span className="deck-panel-size muted">{size}</span>}
        {focused && arrange && (
          <span className="deck-panel-editing" data-multideck="">
            Editing
          </span>
        )}
        <span className="toolbar-spacer" />
        {background && (
          <button
            className="deck-panel-background"
            aria-label={`Background of this page on ${name}`}
            aria-pressed={background.open}
            aria-expanded={background.open}
            title="Background"
            disabled={disabled || background.dimmed}
            onClick={(e) => background.onToggle(e.currentTarget.getBoundingClientRect())}
            data-background-icon={background.open ? 'open' : 'closed'}
          >
            <BackgroundIcon size={16} />
          </button>
        )}
        {editLayout && <EditLayoutButton disabled={disabled} {...editLayout} />}
        {onChangeLayout && (
          <button className="deck-panel-change-layout" disabled={disabled || pageLocked} onClick={onChangeLayout} title={`Change the layout of this page on ${name}`}>
            Change layout…
          </button>
        )}
        {pages.length > 0 && (
          <label className="deck-panel-page">
            <span className="muted">Page</span>
            <Dropdown aria-label={`Page on ${name}`} value={page} options={pages.map((p) => ({ value: p.id, label: p.label }))} disabled={disabled || pageLocked} onChange={onPage} />
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

/**
 * Edit layout, on a virtual deck's header (19b), on a custom page only — a
 * grid page has no Edit layout (Ryan, 2026-11-20: a page is a grid or custom
 * for its whole life). Lit while the mode is open, when pressing it is Done;
 * then Discard changes and Done sit beside it, Done as the primary button, so
 * the way out is on the deck being edited (Ryan, 2026-11-20).
 */
function EditLayoutButton({ disabled, open, changed, onOpen, onDiscard, onDone }: { disabled: boolean } & NonNullable<Props['editLayout']>) {
  return (
    <>
      <button
        className="deck-panel-edit-layout"
        aria-pressed={open}
        disabled={disabled && !open}
        onClick={open ? onDone : onOpen}
        title={open ? 'Done' : 'Move, resize and add controls'}
        data-edit-layout={open ? 'open' : 'closed'}
      >
        Edit layout
      </button>
      {open && (
        <>
          <button className="deck-panel-discard" disabled={!changed} onClick={onDiscard} data-discard-changes="">
            Discard changes
          </button>
          <button className="primary deck-panel-done" onClick={onDone} data-done="">
            Done
          </button>
        </>
      )}
    </>
  );
}
