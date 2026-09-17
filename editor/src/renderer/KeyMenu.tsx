import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bulk } from './useBulk.js';
import { clipboardSummary } from './model.js';

/**
 * The right-click menu on a key (mockup 2a; scope §10). Bulk operations are
 * *operations* on something already on screen, so a gesture is allowed to hold
 * them (§10, "operations can hide; capabilities cannot") — and the same
 * operations are on the inspector when several keys are selected, with their
 * shortcuts written beside them, for someone who never right-clicks.
 */
export function KeyMenu({
  x,
  y,
  count,
  bulk,
  onClose,
}: {
  /** Where the pointer was, in window coordinates. */
  x: number;
  y: number;
  /** How many keys the operations apply to. */
  count: number;
  bulk: Bulk;
  onClose: () => void;
}) {
  const menu = useRef<HTMLUListElement>(null);

  // Opened on a key near the right or bottom edge, the menu would run off the
  // window; measured before paint and pulled back inside.
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    setPlace({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    });
  }, [x, y]);

  // Close on a pointer anywhere else, or Escape. Pointerdown rather than
  // click, so the menu is gone before whatever is underneath reacts.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape here closes the menu only; it must not also clear the selection.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const act = (operation: () => void | Promise<void>) => () => {
    onClose();
    void operation();
  };
  const several = count > 1;

  // Into document.body: a glass pane's backdrop-filter makes it the containing
  // block for position: fixed, which put the menu far from the pointer.
  return createPortal(
    <ul ref={menu} className="key-menu" role="menu" style={place} aria-label="Key actions">
      <MenuItem label={several ? `Duplicate ${count} keys` : 'Duplicate key'} shortcut="Ctrl+D" onClick={act(bulk.duplicate)} />
      <MenuItem label={several ? `Copy ${count} keys` : 'Copy'} shortcut="Ctrl+C" onClick={act(bulk.copy)} />
      <MenuItem
        label="Paste"
        shortcut="Ctrl+V"
        disabled={bulk.clipboard === null}
        title={bulk.clipboard === null ? 'Nothing copied yet' : `Paste ${clipboardSummary(bulk.clipboard)}`}
        onClick={act(bulk.paste)}
      />
      <li className="key-menu-separator" role="separator" />
      <MenuItem label={several ? `Clear ${count} buttons` : 'Clear button'} shortcut="Del" danger onClick={act(bulk.clear)} />
    </ul>,
    document.body,
  );
}

function MenuItem({
  label,
  shortcut,
  disabled,
  danger,
  title,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button role="menuitem" className={danger ? 'key-menu-item danger' : 'key-menu-item'} disabled={disabled} title={title} onClick={onClick}>
        <span>{label}</span>
        {shortcut && <kbd className="key-menu-shortcut">{shortcut}</kbd>}
      </button>
    </li>
  );
}

/**
 * The line under the grid: what the clipboard holds, and what the last bulk
 * operation did. Shown only while there is something to say — no permanent
 * status chrome (scope §10).
 */
export function BulkStatus({ bulk }: { bulk: Bulk }) {
  if (bulk.clipboard === null && bulk.message === null) return null;
  return (
    <div className="bulk-status" role="status">
      {bulk.message !== null && (
        <p className="bulk-message">
          {bulk.message}
          <button className="link-button" aria-label="Dismiss" title="Dismiss" onClick={bulk.dismissMessage}>
            ✕
          </button>
        </p>
      )}
      {bulk.clipboard !== null && (
        <p className="bulk-clipboard">
          <span className="muted">Clipboard:</span> {clipboardSummary(bulk.clipboard)}
          <button className="link-button" title="Empty the clipboard" onClick={bulk.emptyClipboard}>
            Empty
          </button>
        </p>
      )}
    </div>
  );
}
