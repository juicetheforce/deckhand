import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import { failedBadgeSvg } from '../../../src/failed-badge.js';
import type { ButtonDef, Config, PageDef } from '../../../src/types.js';
import { iconUrl } from '../shared/icons.js';
import { actionName } from './catalogue.js';
import { actionIncomplete, describeAction, keyFace, keyKind, type DeckGeometryWithSerial } from './model.js';

interface Props {
  config: Config;
  geometry: DeckGeometryWithSerial;
  page: PageDef;
  /** Icon path → its file's stamp (src/main/icon-files.ts), so a changed file is fetched again. */
  iconStamps: Record<string, string>;
  /** Keys on this page whose last press on the deck failed, and why (model.ts failedKeysOn). */
  failedKeys: Record<number, string>;
  /** Keys the deck is holding down right now (model.ts latchedKeysOn). */
  latchedKeys: number[];
  selectedKeys: number[];
  /** A click, with the modifiers that decide whether it adds to the selection (Ctrl) or extends it (Shift). */
  onClickKey: (index: number, modifiers: { ctrl: boolean; shift: boolean }) => void;
  /** A right-click, at window coordinates, for the bulk menu. */
  onKeyMenu: (index: number, x: number, y: number) => void;
  /** A key dropped on another key: move it, swapping with whatever is there. Null when editing is blocked. */
  onMoveKey: ((from: number, to: number) => void) | null;
  /** The key an action from the library is being dragged over (useActionDrag), drawn as the drop target. */
  actionDropTarget: number | null;
}

/** How far the pointer must travel before a press becomes a drag, so a slightly shaky click still selects. */
const DRAG_THRESHOLD_PX = 6;

/**
 * Key onto key: drag a button and drop it on another key to move
 * it; an occupied key swaps. Only the key under the pointer moves, even with
 * several selected — a block of keys moves by Copy, Paste and Clear.
 *
 * Pointer events rather than HTML drag-and-drop, the same as the pane
 * dividers: the key is found under the pointer with elementFromPoint, so
 * nothing depends on the platform's drag-and-drop path. Escape cancels.
 */
function useKeyDrag(onMoveKey: ((from: number, to: number) => void) | null) {
  const press = useRef<{ from: number; pointerId: number; x: number; y: number } | null>(null);
  // The drag as drawn, and a ref to the same, for the window listeners below.
  const [drag, setDragState] = useState<{ from: number; over: number | null } | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (next: { from: number; over: number | null } | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const moveRef = useRef(onMoveKey);
  moveRef.current = onMoveKey;
  // A drag that ends back on its own key still produces a click there; it is not a selection click.
  const suppressClick = useRef(false);

  // Added once for the grid's lifetime. Each returns at once unless a key was pressed.
  useEffect(() => {
    const keyUnder = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key-index]');
      return el ? Number(el.dataset.keyIndex) : null;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      const over = keyUnder(e.clientX, e.clientY);
      if (dragRef.current?.over !== over || dragRef.current?.from !== p.from) setDrag({ from: p.from, over });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;
      if (!dragRef.current) return; // never passed the threshold: an ordinary click
      const over = keyUnder(e.clientX, e.clientY);
      // The browser clicks the element where the press and the release share an
      // ancestor: the key itself only if the drag ended back on it. Released
      // anywhere else, no key is clicked, and a flag left set would swallow the
      // next real click.
      suppressClick.current = over === p.from;
      setDrag(null);
      if (over !== null && over !== p.from) moveRef.current?.(p.from, over);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !press.current) return;
      // Cancelling a drag must not also clear the selection. Two guards, either
      // of which alone holds: stopping it here keeps it from the grid's
      // bubble-phase shortcuts, and they also ignore an event already prevented.
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
    /** Start watching a press on a key that holds a button. */
    onPointerDown: (index: number, occupied: boolean, e: ReactPointerEvent) => {
      if (!onMoveKey || !occupied || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      press.current = { from: index, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      suppressClick.current = false;
    },
    /** True once for the click that ends a drag. */
    takeSuppressedClick: () => {
      const suppressed = suppressClick.current;
      suppressClick.current = false;
      return suppressed;
    },
  };
}

export function DeckGrid({ config, geometry, page, iconStamps, failedKeys, latchedKeys, selectedKeys, onClickKey, onKeyMenu, onMoveKey, actionDropTarget }: Props) {
  const keyDrag = useKeyDrag(onMoveKey);
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${geometry.rows}, auto)`,
    // Keys keep roughly the deck's proportions whatever the column count.
    maxWidth: `calc(${geometry.columns} * 104px)`,
  };

  return (
    <div className="grid" style={gridStyle}>
      {geometry.keys.map((k) => (
        <Key
          key={k.index}
          config={config}
          index={k.index}
          row={k.row}
          column={k.column}
          hasScreen={k.feedback === 'lcd'}
          iconSize={geometry.iconSize}
          button={page.buttons[String(k.index)]}
          iconStamps={iconStamps}
          failure={failedKeys[k.index]}
          latched={latchedKeys.includes(k.index)}
          selected={selectedKeys.includes(k.index)}
          onClick={(modifiers) => {
            if (!keyDrag.takeSuppressedClick()) onClickKey(k.index, modifiers);
          }}
          onMenu={(x, y) => onKeyMenu(k.index, x, y)}
          onPointerDown={(occupied, e) => keyDrag.onPointerDown(k.index, occupied, e)}
          dragging={keyDrag.drag?.from === k.index}
          dropTarget={(keyDrag.drag !== null && keyDrag.drag.over === k.index && keyDrag.drag.from !== k.index) || actionDropTarget === k.index}
        />
      ))}
    </div>
  );
}

interface KeyProps {
  config: Config;
  index: number;
  row: number;
  column: number;
  hasScreen: boolean;
  iconSize: number | null;
  button: ButtonDef | undefined;
  iconStamps: Record<string, string>;
  /** The error, if this key's last press on the deck failed. */
  failure: string | undefined;
  /** This key is latched down on the deck right now. */
  latched: boolean;
  selected: boolean;
  onClick: (modifiers: { ctrl: boolean; shift: boolean }) => void;
  onMenu: (x: number, y: number) => void;
  onPointerDown: (occupied: boolean, e: ReactPointerEvent) => void;
  /** This key is being dragged (drawn dimmed). */
  dragging: boolean;
  /** A dragged key is over this one (drawn as the dashed drop target). */
  dropTarget: boolean;
}

function Key({ config, index, row, column, hasScreen, iconSize, button, iconStamps, failure, latched, selected, onClick, onMenu, onPointerDown, dragging, dropTarget }: KeyProps) {
  const kind = keyKind(button);
  const incomplete = actionIncomplete(button?.action);
  const face = keyFace(config, button, iconSize, latched);
  const stamp = face.icon === null ? undefined : iconStamps[face.icon];
  // Which icon failed to load, by path and stamp, so a changed path — or the
  // same path whose file changed — is tried again.
  const [missingIcon, setMissingIcon] = useState<string | null>(null);
  const iconId = face.icon === null ? null : `${face.icon}|${stamp ?? ''}`;
  const iconMissing = iconId !== null && missingIcon === iconId;
  const classes = [
    'key',
    kind === 'bound' ? '' : `key-${kind}`,
    selected ? 'key-selected' : '',
    hasScreen ? '' : 'key-no-screen',
    dragging ? 'key-dragging' : '',
    dropTarget ? 'key-drop-target' : '',
    incomplete ? 'key-incomplete' : '',
    latched ? 'key-latched' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title =
    kind === 'empty' ? `Key ${index + 1}: empty` : `Key ${index + 1}: ${describeAction(button)}${latched ? ' — held down now' : ''}`;

  return (
    <button
      className={classes}
      style={{ gridRow: row + 1, gridColumn: column + 1, background: kind === 'empty' ? undefined : face.background }}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      data-key-index={index}
      onPointerDown={(e) => onPointerDown(kind !== 'empty', e)}
      onClick={(e) => onClick({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {face.icon && !iconMissing && (
        <img
          className="key-icon"
          src={iconUrl(face.icon, stamp)}
          alt=""
          style={{ objectFit: face.iconFit }}
          draggable={false}
          onError={() => setMissingIcon(iconId)}
        />
      )}
      {iconMissing && (
        // The same built-in the deck draws for an icon it cannot read.
        <img className="key-icon key-icon-missing" src={missingIconUrl} alt="" title={`Cannot read ${face.icon}`} draggable={false} />
      )}
      {face.label && (
        <span
          className={`key-label key-label-${face.labelPosition}`}
          // The deck's label size relative to its key pixels, applied to this key's width (container units).
          style={{ color: face.labelColor, fontSize: `calc(${face.labelScale} * 100cqw)` }}
        >
          {/* One block per line, each cut on its own, as the deck does (src/label-fit.ts). */}
          {face.label.split('\n').filter((line) => line.length > 0).map((line, i) => (
            <span key={i} className="key-label-line">
              {line}
            </span>
          ))}
        </span>
      )}
      {!face.icon && !face.label && button?.action && (
        // A live face (now playing, clock) is not drawn here; name the action so the key is not blank.
        <span className="key-caption">{actionName(button.action.type)}</span>
      )}
      {incomplete && (
        <span className="key-mark" title="Its action is missing a setting, so pressing it does nothing yet">
          not set up
        </span>
      )}
      {kind === 'unbound' && (
        <span className="key-mark" title="Shows something, but does nothing when pressed">
          no action
        </span>
      )}
      {failure !== undefined && (
        // The deck's own badge, from the same drawing (src/failed-badge.ts),
        // inlined: the page's CSP refuses data: images. Sized in CSS.
        <span className="key-failed" title={`Its last press failed: ${failure}`} dangerouslySetInnerHTML={{ __html: failedBadgeSvg(100) }} />
      )}
    </button>
  );
}
