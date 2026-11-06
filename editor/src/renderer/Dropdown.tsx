import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type MouseEventHandler } from 'react';
import { createPortal, flushSync } from 'react-dom';

/**
 * Every dropdown in the editor: Show in editor's trigger and panel (Toolbar.tsx)
 * for choosing one thing. Not a native <select>, whose popup belongs to the system
 * and can't be made to look like the rest.
 *
 * The list is drawn on document.body, so a scrolling Settings page or a glass panel
 * can't clip it, placed by the trigger, above it if there's no room below. It keeps
 * what a native one has: Enter, Space and the arrows open it; the arrows, Home and
 * End move; a letter jumps; Enter picks; Esc closes; Tab moves on from the trigger;
 * a click outside closes it. As a native one's did, keys pressed in it stay out of
 * the grid's shortcuts (App.tsx's useBulkShortcuts).
 *
 * It opens synchronously, so a check can click the trigger and then an option.
 */

export interface DropdownOption {
  value: string;
  label: string;
}

/** A trigger's data-* attributes, and the rest a <button> takes. */
type TriggerProps = Omit<HTMLAttributes<HTMLButtonElement>, 'onChange' | 'onContextMenu'> & { [data: `data-${string}`]: string | undefined };

export function Dropdown({
  value,
  options,
  disabled,
  onChange,
  onContextMenu,
  className,
  ...trigger
}: {
  value: string;
  options: readonly DropdownOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
} & TriggerProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const shown = options.find((o) => o.value === value)?.label ?? value;

  const show = () => flushSync(() => setOpen(true));
  const hide = (refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Placed by the trigger, on the current selection, once the list has a size.
  useLayoutEffect(() => {
    const list = menu.current;
    const anchor = button.current;
    if (!open || !list || !anchor) return;
    const at = anchor.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const below = window.innerHeight - at.bottom - gap - margin;
    const above = at.top - gap - margin;
    const height = list.scrollHeight + 2;
    const under = height <= below || below >= above;
    const room = Math.max(under ? below : above, 60);
    list.style.minWidth = `${at.width}px`;
    list.style.maxHeight = `${room}px`;
    list.style.top = `${under ? at.bottom + gap : Math.max(margin, at.top - gap - Math.min(height, room))}px`;
    list.style.left = `${Math.max(margin, Math.min(at.left, window.innerWidth - list.offsetWidth - margin))}px`;
    (list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? list.querySelector<HTMLButtonElement>('[role="option"]'))?.focus({ preventScroll: false });
  }, [open]);

  // Anything else happening closes it: a press elsewhere, the window resized or left.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const scrolled = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const gone = () => setOpen(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
    };
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide(true);
    } else if (e.key === 'Tab') {
      // Back on the trigger, with the browser left to move on from there, either way.
      hide(true);
      return;
    } else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key.length === 1 && e.key !== ' ') {
      const letter = e.key.toLowerCase();
      const from = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
      from.find((r) => r.textContent?.trim().toLowerCase().startsWith(letter))?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        {...trigger}
        ref={button}
        type="button"
        className={`dropdown-trigger${className ? ` ${className}` : ''}`}
        data-dropdown=""
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onContextMenu={onContextMenu}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          show();
        }}
      >
        <span className="dropdown-shown">{shown}</span>
        <span className="muted" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open &&
        createPortal(
          <ul ref={menu} className="tab-menu dropdown-menu" role="listbox" aria-label={trigger['aria-label']} data-dropdown-menu="" onKeyDown={onMenuKey}>
            {options.map((o) => (
              <li key={o.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  className="dropdown-option"
                  data-value={o.value}
                  aria-selected={o.value === value}
                  onClick={() => {
                    hide(true);
                    if (o.value !== value) onChange(o.value);
                  }}
                >
                  <span className="dropdown-shown">{o.label}</span>
                  {o.value === value && (
                    <span className="dropdown-mark" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
