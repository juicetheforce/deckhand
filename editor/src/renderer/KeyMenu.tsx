import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bulk } from './useBulk.js';
import { clipboardSummary, type Choice, type DeviceTarget } from './model.js';

/**
 * The right-click menu on a key (mockup 2a; scope §10). Bulk operations are
 * *operations* on something already on screen, so a gesture is allowed to hold
 * them (§10, "operations can hide; capabilities cannot") — and the same
 * operations are on the inspector when several keys are selected, with their
 * shortcuts written beside them, for someone who never right-clicks.
 *
 * "Copy to page ▸" and "Copy to device ▸" (mockup 2a) open *inside* the menu
 * rather than as a fly-out beside it: a fly-out from a key at the right edge of
 * the window has nowhere to go, and one list that grows is easier to aim at.
 */
export function KeyMenu({
  x,
  y,
  count,
  bulk,
  serial,
  otherPages,
  devices,
  onClose,
}: {
  /** Where the pointer was, in window coordinates. */
  x: number;
  y: number;
  /** How many keys the operations apply to. */
  count: number;
  bulk: Bulk;
  /** The deck being edited. */
  serial: string;
  /** The other pages on the deck being edited. */
  otherPages: Choice[];
  /** The other decks in this profile, with their pages. */
  devices: DeviceTarget[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState<'page' | 'device' | null>(null);
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
  }, [x, y, open]);

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
      <Submenu label="Copy to page" expanded={open === 'page'} disabled={otherPages.length === 0} title={otherPages.length === 0 ? 'This deck has no other page' : undefined} onToggle={() => setOpen(open === 'page' ? null : 'page')} />
      {open === 'page' &&
        otherPages.map((p) => <MenuItem key={p.id} label={p.label} indent onClick={act(() => bulk.copyTo(serial, p.id))} />)}
      <Submenu label="Copy to device" expanded={open === 'device'} disabled={devices.length === 0} title={devices.length === 0 ? 'This profile has no layout for another deck' : undefined} onToggle={() => setOpen(open === 'device' ? null : 'device')} />
      {open === 'device' &&
        devices.map((d) => (
          <DeviceGroup key={d.serial} device={d} onPick={(pageId) => act(() => bulk.copyTo(d.serial, pageId))()} />
        ))}
      <li className="key-menu-separator" role="separator" />
      <MenuItem label={several ? `Clear ${count} buttons` : 'Clear button'} shortcut="Del" danger onClick={act(bulk.clear)} />
    </ul>,
    document.body,
  );
}

/** "Copy to page ▸": opens its targets beneath it, inside the menu. */
function Submenu({ label, expanded, disabled, title, onToggle }: { label: string; expanded: boolean; disabled: boolean; title?: string; onToggle: () => void }) {
  return (
    <li>
      <button role="menuitem" className="key-menu-item" aria-expanded={expanded} disabled={disabled} title={title} onClick={onToggle}>
        <span>{label}</span>
        <span className="key-menu-shortcut" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
    </li>
  );
}

/**
 * One deck under "Copy to device": its name, then its pages. A deck that is not
 * connected is listed but cannot be picked — keys land by row and column, and
 * without the deck there is no geometry to place them by — and says so rather
 * than vanishing (§2: say why, do not hide).
 */
function DeviceGroup({ device, onPick }: { device: DeviceTarget; onPick: (page: string) => void }) {
  return (
    <>
      <li className="key-menu-heading" role="presentation">
        {device.label}
        {device.connected ? '' : ' — not connected'}
      </li>
      {device.pages.map((p) => (
        <MenuItem
          key={p.id}
          label={p.label}
          indent
          disabled={!device.connected}
          title={device.connected ? undefined : 'Plug this deck in to copy to it: keys are placed by its rows and columns.'}
          onClick={() => onPick(p.id)}
        />
      ))}
    </>
  );
}

function MenuItem({
  label,
  shortcut,
  disabled,
  danger,
  indent,
  title,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** A target under "Copy to page" or "Copy to device". */
  indent?: boolean;
  title?: string;
  onClick: () => void;
}) {
  const classes = ['key-menu-item', danger ? 'danger' : '', indent ? 'key-menu-indent' : ''].filter(Boolean).join(' ');
  return (
    <li>
      <button role="menuitem" className={classes} disabled={disabled} title={title} onClick={onClick}>
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
