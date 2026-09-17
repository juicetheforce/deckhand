import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** How far the pointer must travel before a press on a library row becomes a drag, as for keys in the grid. */
const DRAG_THRESHOLD_PX = 6;

export interface ActionDrag {
  type: string;
  /** Where the pointer is, for the floating label that follows it. */
  x: number;
  y: number;
  /** The key under the pointer, or null. */
  over: number | null;
}

/**
 * Dragging an action from the library onto a key (scope §10: authoring — the
 * drop replaces the action and clears the icon and the label).
 *
 * Pointer events and `elementFromPoint`, like the key-onto-key drag in
 * DeckGrid.tsx and the pane dividers: nothing depends on the platform's
 * drag-and-drop path. The two drags are kept apart on purpose (the maintainer,
 * 2026-09-16): this one authors a button, that one moves one. Escape cancels.
 */
export function useActionDrag(onDrop: (type: string, index: number) => void) {
  const press = useRef<{ type: string; pointerId: number; x: number; y: number } | null>(null);
  const [drag, setDragState] = useState<ActionDrag | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (next: ActionDrag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  // A drag that ends back on its own row still produces a click there; it is not a pick.
  const suppressClick = useRef(false);

  useEffect(() => {
    const keyUnder = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key-index]');
      return el ? Number(el.dataset.keyIndex) : null;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      setDrag({ type: p.type, x: e.clientX, y: e.clientY, over: keyUnder(e.clientX, e.clientY) });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;
      if (!dragRef.current) return; // never passed the threshold: an ordinary click
      const over = keyUnder(e.clientX, e.clientY);
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-action-type]');
      suppressClick.current = row?.dataset.actionType === p.type;
      setDrag(null);
      if (over !== null) dropRef.current(p.type, over);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !press.current) return;
      // Cancelling must not also clear the grid's selection (App's shortcuts).
      e.stopPropagation();
      e.preventDefault();
      press.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', cancel, true);
    };
  }, []);

  return {
    drag,
    /** Start watching a press on a library row. */
    start: (type: string, e: ReactPointerEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      press.current = { type, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      suppressClick.current = false;
    },
    /** True once for the click that ends a drag on its own row. */
    takeSuppressedClick: () => {
      const suppressed = suppressClick.current;
      suppressClick.current = false;
      return suppressed;
    },
  };
}
