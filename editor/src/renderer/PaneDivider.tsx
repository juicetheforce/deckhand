import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { clampPane, PANE_LIMITS, widthWhileDragging, type PaneName } from './panes.js';

interface Props {
  pane: PaneName;
  width: number;
  onResize: (pane: PaneName, width: number) => void;
  label: string;
}

/** How far one arrow-key press moves a divider. */
const KEY_STEP = 16;

/**
 * The draggable divider between two panes (scope §10). Both panes felt
 * cramped at fixed widths, the icon picker most of all (the maintainer, 2026-09-15).
 *
 * Pointer capture rather than window listeners: the pointer keeps reporting to
 * this element even when it leaves it, so a fast drag cannot lose the pane.
 * Arrow keys move it too, because a 6-pixel drag target is no way to reach
 * something from the keyboard; double-click returns it to its default.
 */
export function PaneDivider({ pane, width, onResize, label }: Props) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    // A synthetic pointer (the checks dispatch them) owns no capture, and
    // asking for one throws; the drag works either way.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // no real pointer to capture
    }
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    onResize(pane, widthWhileDragging(pane, drag.current.startWidth, event.clientX - drag.current.startX));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const final = widthWhileDragging(pane, drag.current.startWidth, event.clientX - drag.current.startX);
    drag.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // never captured
    }
    onResize(pane, final);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize(pane, widthWhileDragging(pane, width, step));
  };

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={PANE_LIMITS[pane].min}
      aria-valuemax={PANE_LIMITS[pane].max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(pane, clampPane(pane, PANE_LIMITS[pane].default))}
    >
      <span className="pane-divider-grip" aria-hidden />
    </div>
  );
}
