import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import { failedBadgeSvg, unsetBadgeSvg } from '../../../src/failed-badge.js';
import type { ButtonDef, Config, PageDef } from '../../../src/types.js';
import { iconUrl } from '../shared/icons.js';
import { actionName } from './catalogue.js';
import { keyUnder, type KeyRef } from './keyUnder.js';
import { actionIncomplete, describeAction, integrationOf, INTEGRATIONS, keyFace, keyKind, type AppIcons, type DeckGeometryWithSerial } from './model.js';

interface Props {
  config: Config;
  geometry: DeckGeometryWithSerial;
  page: PageDef;
  /** Icon path → its file's stamp (src/main/icon-files.ts), so a changed file is fetched again. */
  iconStamps: Record<string, string>;
  /** Each app's resolved icon, for app keys with no icon of their own (model.ts appIconsOf). */
  appIcons: AppIcons;
  /** Keys on this page whose last press on the deck failed, and why (model.ts failedKeysOn). */
  failedKeys: Record<number, string>;
  /** Whether an action's integration is not set up (model.ts notSetUp): its key is drawn as the deck draws it — dimmed, with the not-set-up badge. */
  notSetUp: (type: string | undefined) => boolean;
  /** Keys the deck is holding down right now (model.ts latchedKeysOn). */
  latchedKeys: number[];
  selectedKeys: number[];
  /** A click, with the modifiers that decide whether it adds to the selection (Ctrl) or extends it (Shift). */
  onClickKey: (index: number, modifiers: { ctrl: boolean; shift: boolean }) => void;
  /** A right-click, at window coordinates, for the bulk menu. */
  onKeyMenu: (index: number, x: number, y: number) => void;
  /** A key dropped on another key of this deck: move it, swapping with whatever is there. Null when editing is blocked. */
  onMoveKey: ((from: number, to: number) => void) | null;
  /** A key dropped on another shown deck's key: copy it there. Null when editing is blocked or no other deck is shown. */
  onCopyKey: ((from: number, to: KeyRef) => void) | null;
  /** The key under the pointer while a key of this grid is dragged, on any deck (useKeyDrag). */
  onKeyDragOver: (over: KeyRef | null) => void;
  /** The key on this deck something is being dragged over — an action from the library, or a key from this deck or another — drawn as the drop target. */
  dropTarget: number | null;
}

/** How far the pointer must travel before a press becomes a drag, so a slightly shaky click still selects. */
const DRAG_THRESHOLD_PX = 6;

/** Where a dragged key may land: on this deck, a move; on another shown deck, a copy. */
interface KeyDrop {
  onMoveKey: ((from: number, to: number) => void) | null;
  onCopyKey: ((from: number, to: KeyRef) => void) | null;
  /** The key under the pointer while a key is dragged, on any deck, or null: drawn by the grid it is on. */
  onDragOver: (over: KeyRef | null) => void;
}

/**
 * Key onto key: drag a button and drop it on another key. On this deck it
 * moves, and an occupied key swaps; on another shown deck it is copied there
 * and the original stays (scope §10). Only the key under the pointer goes,
 * even with several selected — a block of keys moves by Copy, Paste and
 * Clear.
 *
 * Pointer events rather than HTML drag-and-drop, the same as the pane
 * dividers: the key is found under the pointer with elementFromPoint, so
 * nothing depends on the platform's drag-and-drop path. Escape cancels.
 *
 * The key under the pointer is reported up (onDragOver), because the grid a
 * key is dropped on is not always the grid it came from, and that grid draws
 * the drop target.
 */
function useKeyDrag(serial: string, drop: KeyDrop) {
  const press = useRef<{ from: number; pointerId: number; x: number; y: number } | null>(null);
  // The drag as drawn, and a ref to the same, for the window listeners below.
  const [drag, setDragState] = useState<{ from: number; over: KeyRef | null } | null>(null);
  const dragRef = useRef(drag);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const setDrag = (next: { from: number; over: KeyRef | null } | null) => {
    const before = dragRef.current?.over ?? null;
    dragRef.current = next;
    setDragState(next);
    const after = next?.over ?? null;
    if (before?.serial !== after?.serial || before?.index !== after?.index) dropRef.current.onDragOver(after);
  };
  const serialRef = useRef(serial);
  serialRef.current = serial;
  // A drag that ends back on its own key still produces a click there; it is not a selection click.
  const suppressClick = useRef(false);

  // Added once for the grid's lifetime. Each returns at once unless a key was pressed.
  useEffect(() => {
    /** The key a drop would land on: any key of this deck but the one dragged, or a key on another deck when copying is allowed. */
    const targetUnder = (x: number, y: number, from: number): KeyRef | null => {
      const key = keyUnder(x, y);
      if (key === null) return null;
      if (key.serial === serialRef.current) return key.index === from ? null : key;
      return dropRef.current.onCopyKey ? key : null;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      const over = targetUnder(e.clientX, e.clientY, p.from);
      const now = dragRef.current;
      if (now === null || now.from !== p.from || now.over?.serial !== over?.serial || now.over?.index !== over?.index) setDrag({ from: p.from, over });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;
      if (!dragRef.current) return; // never passed the threshold: an ordinary click
      const over = targetUnder(e.clientX, e.clientY, p.from);
      // The browser clicks the element where the press and the release share an
      // ancestor: the key itself only if the drag ended back on it. Released
      // anywhere else, no key is clicked, and a flag left set would swallow the
      // next real click.
      const back = keyUnder(e.clientX, e.clientY);
      suppressClick.current = back !== null && back.serial === serialRef.current && back.index === p.from;
      setDrag(null);
      if (over === null) return;
      if (over.serial === serialRef.current) dropRef.current.onMoveKey?.(p.from, over.index);
      else dropRef.current.onCopyKey?.(p.from, over);
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
      // A grid gone mid-drag (its deck hidden or unplugged) must not leave its target drawn on another.
      if (dragRef.current?.over) dropRef.current.onDragOver(null);
    };
  }, []);

  return {
    drag,
    /** Start watching a press on a key that holds a button. */
    onPointerDown: (index: number, occupied: boolean, e: ReactPointerEvent) => {
      if (!drop.onMoveKey || !occupied || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
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

export function DeckGrid({ config, geometry, page, iconStamps, appIcons, failedKeys, notSetUp, latchedKeys, selectedKeys, onClickKey, onKeyMenu, onMoveKey, onCopyKey, onKeyDragOver, dropTarget }: Props) {
  const keyDrag = useKeyDrag(geometry.serial, { onMoveKey, onCopyKey, onDragOver: onKeyDragOver });
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${geometry.rows}, auto)`,
    // Keys keep roughly the deck's proportions whatever the column count.
    maxWidth: `calc(${geometry.columns} * 104px)`,
  };

  return (
    <div className="grid" style={gridStyle} data-deck={geometry.serial}>
      {geometry.keys.map((k) => (
        <Key
          key={k.index}
          serial={geometry.serial}
          config={config}
          index={k.index}
          row={k.row}
          column={k.column}
          hasScreen={k.feedback === 'lcd'}
          iconSize={geometry.iconSize}
          button={page.buttons[String(k.index)]}
          iconStamps={iconStamps}
          appIcons={appIcons}
          failure={failedKeys[k.index]}
          unset={notSetUp(page.buttons[String(k.index)]?.action?.type)}
          latched={latchedKeys.includes(k.index)}
          selected={selectedKeys.includes(k.index)}
          onClick={(modifiers) => {
            if (!keyDrag.takeSuppressedClick()) onClickKey(k.index, modifiers);
          }}
          onMenu={(x, y) => onKeyMenu(k.index, x, y)}
          onPointerDown={(occupied, e) => keyDrag.onPointerDown(k.index, occupied, e)}
          dragging={keyDrag.drag?.from === k.index}
          dropTarget={dropTarget === k.index}
        />
      ))}
    </div>
  );
}

interface KeyProps {
  /** The deck this key is on, for the drags (keyUnder.ts). */
  serial: string;
  config: Config;
  index: number;
  row: number;
  column: number;
  hasScreen: boolean;
  iconSize: number | null;
  button: ButtonDef | undefined;
  iconStamps: Record<string, string>;
  appIcons: AppIcons;
  /** The error, if this key's last press on the deck failed. */
  failure: string | undefined;
  /** Its integration (OBS, VTube Studio) is not set up: drawn dimmed with the not-set-up badge, which stands in for a failure badge, as on the deck. */
  unset: boolean;
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

function Key({ serial, config, index, row, column, hasScreen, iconSize, button, iconStamps, appIcons, failure, unset, latched, selected, onClick, onMenu, onPointerDown, dragging, dropTarget }: KeyProps) {
  const unsetName = INTEGRATIONS[integrationOf(button?.action?.type) ?? 'obs'].name;
  const kind = keyKind(button);
  const incomplete = actionIncomplete(button?.action);
  const face = keyFace(config, button, iconSize, latched, appIcons);
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
    unset ? 'key-unset' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title =
    kind === 'empty'
      ? `Key ${index + 1}: empty`
      : `Key ${index + 1}: ${describeAction(button)}${latched ? ' — held down now' : ''}${unset ? ` — ${unsetName} is not set up` : ''}`;

  return (
    <button
      className={classes}
      style={{ gridRow: row + 1, gridColumn: column + 1, background: kind === 'empty' ? undefined : face.background }}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      data-deck={serial}
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
      {unset && (
        // The deck's not-set-up badge, from the same drawing (src/failed-badge.ts).
        <span className="key-failed key-unset-badge" title={`${unsetName} is not set up: ${INTEGRATIONS[integrationOf(button?.action?.type) ?? 'obs'].notSetUp}`} dangerouslySetInnerHTML={{ __html: unsetBadgeSvg(100) }} />
      )}
      {failure !== undefined && !unset && (
        // The deck's own badge, from the same drawing (src/failed-badge.ts),
        // inlined: the page's CSP refuses data: images. Sized in CSS.
        <span className="key-failed" title={`Its last press failed: ${failure}`} dangerouslySetInnerHTML={{ __html: failedBadgeSvg(100) }} />
      )}
    </button>
  );
}
