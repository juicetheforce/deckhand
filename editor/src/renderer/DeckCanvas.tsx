import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { DeckPosition, DeckPositions } from '../shared/deck-positions.js';
import {
  arrange,
  fitZoom,
  FOOT_PX,
  GAP_PX,
  HEAD_PX,
  MARGIN_PX,
  PAD_X_PX,
  panelRect,
  PITCH_PX,
  resolveOverlap,
  snap,
  union,
  zoomIn,
  zoomOut,
  type DeckSize,
  type Guide,
  type Neighbour,
  type Rect,
} from './canvas.js';

export interface CanvasDeck {
  serial: string;
  name: string;
  size: DeckSize;
}

/** What a panel needs from the canvas: where it is drawn and how it is picked up. */
export interface Placement {
  style: CSSProperties;
  onGrab: (e: ReactPointerEvent<HTMLElement>) => void;
  dragging: boolean;
  /** Dropped here, it would go back where it started (canvas.ts resolveOverlap). */
  refused: boolean;
  /** Locked in place: its header starts no drag. */
  locked: boolean;
  onLock: (locked: boolean) => void;
}

interface Props {
  decks: CanvasDeck[];
  /** As remembered; decks without one are placed by arrange(). */
  positions: DeckPositions;
  /** A deck dropped: every shown deck's position as drawn, the dropped one's new. */
  onMove: (positions: DeckPositions) => void;
  locked: string[];
  /** A deck locked or unlocked, with every shown deck's position as drawn: it is locked where it is seen. */
  onLock: (serial: string, locked: boolean, positions: DeckPositions) => void;
  panel: (serial: string, placement: Placement) => ReactNode;
}

interface Drag {
  serial: string;
  pointer: number;
  from: { x: number; y: number };
  start: DeckPosition;
  /** Where on the panel it was picked up, in key units from the panel's corner: the pointer rides there. */
  hold: { x: number; y: number };
  at: DeckPosition;
  guides: Guide[];
  refused: boolean;
  moved: boolean;
  /**
   * The drawing's frame when the drag began, held until it ends. The drawing
   * is centred in the window: let it grow as the deck passes its edge and it
   * shifts back by half the growth, so the deck falls behind the pointer
   * (Ryan, 2026-09-27; check:multi-deck, "moves exactly as far as the
   * pointer"). While held, the deck may be drawn outside the frame.
   */
  frame: Rect;
}

/** A press that moves less than this is not a drag. */
const DRAG_START_PX = 4;

/**
 * Several decks shown, arranged like KDE's displays (scope §10, "Multi-deck
 * editing"): each drawn to its real proportions — every key the same size —
 * and dragged by its header, snapping to the others' key columns, rows and
 * edges; decks never overlap. Positions are the person's, remembered by
 * serial; zoom is the window's — Fit all when the editor opens or the shown
 * decks change, never above 100%, and not otherwise changed under the
 * person (never on a resize).
 *
 * With one deck shown there is no canvas: App draws the grid alone.
 */
export function DeckCanvas({ decks, positions, onMove, locked, onLock, panel }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // The drag lives in a ref, read by the pointer handlers: a pointerup can
  // arrive before React has drawn the last move, and a handler reading state
  // would drop the deck a move behind. The state copy is only for drawing.
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const sizes = Object.fromEntries(decks.map((d) => [d.serial, d.size]));
  const placed = arrange(
    decks.map((d) => d.serial),
    sizes,
    positions,
  );
  const at = (serial: string) => (drag?.serial === serial ? drag.at : placed[serial]);
  const rects = decks.filter((d) => placed[d.serial]).map((d) => panelRect(at(d.serial), d.size));
  const bounds = union(rects);

  /** Fit all: every deck in the window, never above 100%. Measured from where the decks rest, not a drag. */
  const fit = () => {
    const el = viewport.current;
    if (!el) return;
    const resting = union(decks.filter((d) => placed[d.serial]).map((d) => panelRect(placed[d.serial], d.size)));
    setZoom(fitZoom(resting, { width: el.clientWidth, height: el.clientHeight }));
  };
  // On opening and whenever the shown decks change — never on a resize,
  // and not as a drag moves the bounds: nothing rescales under the person.
  const shownKey = decks.map((d) => `${d.serial}:${d.size.columns}x${d.size.rows}`).join(',');
  useLayoutEffect(fit, [shownKey]);

  if (!bounds) return null;
  const frame = drag?.frame ?? bounds;
  const origin = { left: frame.left, top: frame.top };
  const px = (units: number) => units * PITCH_PX;

  const neighbours = (serial: string): Neighbour[] =>
    decks.filter((d) => d.serial !== serial && placed[d.serial]).map((d) => ({ serial: d.serial, name: d.name, at: placed[d.serial], size: d.size }));

  const grab = (serial: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || locked.includes(serial) || (e.target as Element).closest('button, select, label, input')) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (the checks) has nothing to capture; they send the drag to the header.
    }
    const start = placed[serial];
    const panelBox = (e.currentTarget.closest('.deck-panel') ?? e.currentTarget).getBoundingClientRect();
    const hold = { x: (e.clientX - panelBox.left) / (PITCH_PX * zoom), y: (e.clientY - panelBox.top) / (PITCH_PX * zoom) };
    setDrag({ serial, pointer: e.pointerId, from: { x: e.clientX, y: e.clientY }, start, hold, at: start, guides: [], refused: false, moved: false, frame: bounds });
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointer) return;
    const dx = e.clientX - drag.from.x;
    const dy = e.clientY - drag.from.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
    const size = sizes[drag.serial];
    const others = neighbours(drag.serial);
    const raw = { x: drag.start.x + dx / (PITCH_PX * zoom), y: drag.start.y + dy / (PITCH_PX * zoom) };
    const snapped = snap(raw, size, others, zoom);
    // The pointer, in key units: where the deck was picked up, carried with the unsnapped drag.
    const held = panelRect(raw, size);
    const pointerAt = { x: held.left + drag.hold.x, y: held.top + drag.hold.y };
    const settled = resolveOverlap(snapped.at, size, pointerAt, others);
    // Shown where it would land: butted if it overlaps; where the pointer is, marked, if refused.
    setDrag({ ...drag, moved: true, at: settled ?? snapped.at, guides: settled && settled !== snapped.at ? [] : snapped.guides, refused: settled === null });
  };

  const drop = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointer) return;
    setDrag(null);
    if (drag.moved && !drag.refused) onMove({ ...placed, [drag.serial]: drag.at });
  };

  /** The system took the pointer away (a cancel is not a drop): the deck stays where it was. */
  const cancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointer === e.pointerId) setDrag(null);
  };

  return (
    <div className="canvas" data-multideck="" data-zoom={zoom}>
      <div className="canvas-viewport" ref={viewport}>
        <div
          className="canvas-sizer"
          style={{ width: px(frame.right - frame.left) * zoom + 2 * MARGIN_PX, height: px(frame.bottom - frame.top) * zoom + 2 * MARGIN_PX }}
        >
          <div className="canvas-content" style={{ transform: `translate(${MARGIN_PX}px, ${MARGIN_PX}px) scale(${zoom})` }}>
            {decks.map((d) => {
              const p = placed[d.serial];
              if (!p) return null;
              const r = panelRect(at(d.serial), d.size);
              const dragging = drag?.serial === d.serial && drag.moved;
              const style: CSSProperties = {
                left: px(r.left - origin.left),
                top: px(r.top - origin.top),
                width: d.size.columns * PITCH_PX - GAP_PX + 2 * PAD_X_PX,
                height: d.size.rows * PITCH_PX - GAP_PX + HEAD_PX + FOOT_PX,
              };
              return (
                <div key={d.serial} className="canvas-deck" onPointerMove={move} onPointerUp={drop} onPointerCancel={cancel}>
                  {panel(d.serial, {
                    style,
                    onGrab: grab(d.serial),
                    dragging,
                    refused: dragging && (drag?.refused ?? false),
                    locked: locked.includes(d.serial),
                    onLock: (lock) => onLock(d.serial, lock, placed),
                  })}
                </div>
              );
            })}
            {drag?.moved &&
              drag.guides.map((g) => (
                <div
                  key={g.axis}
                  className={`canvas-guide canvas-guide-${g.axis}`}
                  style={
                    g.axis === 'x'
                      ? { left: px(g.at - origin.left), top: px(g.from - origin.top), height: px(g.to - g.from) }
                      : { top: px(g.at - origin.top), left: px(g.from - origin.left), width: px(g.to - g.from) }
                  }
                >
                  <span className="canvas-guide-label" style={{ transform: `scale(${1 / zoom})` }}>
                    snap · {g.label}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>
      <div className="canvas-zoom glass" role="toolbar" aria-label="Zoom">
        <button className="canvas-zoom-step" aria-label="Zoom out" onClick={() => setZoom(zoomOut)}>
          −
        </button>
        <span className="canvas-zoom-level" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button className="canvas-zoom-step" aria-label="Zoom in" onClick={() => setZoom(zoomIn)}>
          +
        </button>
        <button className="canvas-zoom-text" onClick={fit}>
          Fit all
        </button>
        <button className="canvas-zoom-text canvas-zoom-reset" title="Zoom to 100%" onClick={() => setZoom(1)}>
          Reset
        </button>
      </div>
    </div>
  );
}
