import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Placement } from './DeckCanvas.js';
import { Dropdown } from './Dropdown.js';
import { LockIcon } from './icons.js';
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
  /** A virtual deck's Change layout… for the page shown; absent on a Stream Deck, or with no page. */
  onChangeLayout?: () => void;
  /**
   * A virtual deck's Edit layout, for the page shown; absent on a Stream Deck.
   * `open`: the mode is open on this deck, so the button is lit, and pressing
   * it is Done. `preset`: the page is a fixed grid, so the first press asks
   * once whether to make it custom (21e).
   */
  editLayout?: { open: boolean; preset: boolean; onOpen: () => void; onMakeCustom: () => Promise<string | null>; onDone: () => void };
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
 * Clicking its name focuses the deck; dragging its header moves it on the
 * canvas (DeckCanvas.tsx).
 */
/** A deck name gets this much of its own width at most when the frame is widened for the header; longer ones end in an ellipsis. */
const NAME_ROOM_PX = 160;

export function DeckPanel({ serial, name, size, focused, pages, page, disabled, onFocus, onPage, onChangeLayout, editLayout, pageLocked = false, onHeaderNeed, children, placement }: Props) {
  const { arrange } = placement;
  const header = useRef<HTMLElement>(null);
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
    <section className={classes} data-deck-panel={serial} style={placement.style}>
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
        {editLayout && <EditLayoutButton name={name} disabled={disabled} {...editLayout} />}
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
 * Edit layout, on a virtual deck's header (19b): lit while the mode is open,
 * when pressing it is Done. On a fixed grid it asks once, in a small
 * confirmation under the button, whether to make that page a custom layout,
 * every key kept (21e); Esc, Cancel or a click outside changes nothing.
 */
function EditLayoutButton({ name, disabled, open, preset, onOpen, onMakeCustom, onDone }: { name: string; disabled: boolean } & NonNullable<Props['editLayout']>) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  // Under the button, in the window: the deck's frame clips what overflows it.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!asking || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 6 });
  }, [asking]);
  useEffect(() => {
    if (!asking) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node) && !card.current?.contains(e.target as Node)) setAsking(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAsking(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [asking]);
  const press = () => {
    if (open) onDone();
    else if (preset) {
      setError(null);
      setAsking((a) => !a);
    } else onOpen();
  };
  const makeCustom = async () => {
    setBusy(true);
    const failure = await onMakeCustom();
    setBusy(false);
    if (failure === null) setAsking(false);
    else setError(failure);
  };
  return (
    <span className="deck-panel-edit-wrap" ref={wrap}>
      <button
        className="deck-panel-edit-layout"
        aria-pressed={open}
        disabled={disabled && !open}
        onClick={press}
        title={open ? 'Done' : 'Move, resize and add controls'}
        data-edit-layout={open ? 'open' : 'closed'}
      >
        Edit layout
      </button>
      {asking && at && createPortal(
        <span ref={card} className="edit-layout-confirm glass" style={{ left: at.left, top: at.top }} role="dialog" aria-label={`Make this page on ${name} a custom layout`} data-make-custom="">
          <strong>Make this page a custom layout?</strong>
          <span className="muted small">Every key and its action is kept.</span>
          {error && <span className="field-error">{error}</span>}
          <span className="button-row">
            <button onClick={() => setAsking(false)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void makeCustom()} data-make-custom-confirm="">
              Make it custom
            </button>
          </span>
        </span>,
        document.body,
      )}
    </span>
  );
}
