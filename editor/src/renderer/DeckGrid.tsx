import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import { failedBadgeSvg, unsetBadgeSvg } from '../../../src/failed-badge.js';
import { cornerRadius, fillsBox, innerRect, shapeName, shapePath } from '../../../src/shapes.js';
import type { LiveFace } from '../../../src/control/protocol.js';
import type { ButtonDef, Config, PageBackgroundDef, PageDef } from '../../../src/types.js';
import { BUILTIN_PREFIX, iconUrl } from '../shared/icons.js';
import { useImageCheck } from './image-check.js';
import { fitScale, madeForAnother, positionedBox } from '../shared/templates.js';
import { PageGround } from './PageGround.js';
import { ValueFace } from './ValueFace.js';
import { keyDropRefused } from '../shared/bulk.js';
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
  /** By control id. */
  failedKeys: Record<string, string>;
  /** Whether an action's integration is not set up (model.ts notSetUp): its key is drawn as the deck draws it — dimmed, with the not-set-up badge. */
  notSetUp: (type: string | undefined) => boolean;
  /** Keys the deck is holding down right now (model.ts latchedKeysOn). */
  /** By control id. */
  latchedKeys: string[];
  /** The state each key with states is in on the deck right now (model.ts liveFacesOn), so its face follows it. By control id. */
  liveFaces: Record<string, LiveFace>;
  /** Each slider's and dial's value on the deck now (model.ts valuesOn), whole percent, by control id. */
  values?: Record<string, number>;
  selectedKeys: string[];
  /** A click, with the modifiers that decide whether it adds to the selection (Ctrl) or extends it (Shift). */
  onClickKey: (key: string, modifiers: { ctrl: boolean; shift: boolean }) => void;
  /** A right-click, at window coordinates, for the bulk menu. */
  onKeyMenu: (key: string, x: number, y: number) => void;
  /** A key dropped on another key of this deck: move it, swapping with whatever is there. Null when editing is blocked. */
  onMoveKey: ((from: string, to: string) => void) | null;
  /** A key dropped on another shown deck's key: copy it there. Null when editing is blocked or no other deck is shown. */
  onCopyKey: ((from: string, to: KeyRef) => void) | null;
  /** The key under the pointer while a key of this grid is dragged, on any deck (useKeyDrag), with why it refuses the drop if it does. */
  onKeyDragOver: (over: (KeyRef & { refused?: string | null }) | null) => void;
  /** The key on this deck something is being dragged over — an action from the library, or a key from this deck or another — drawn as the drop target. */
  dropTarget: string | null;
  /** Why the drop target refuses what is over it (26e: "Needs an action with a value"), drawn in its shape with that line; null when it would take it. */
  dropRefused?: string | null;
  /**
   * A virtual deck's room in its frame, in pixels at 100%: its page is drawn
   * positioned (keys where the panel puts them, at their size and shape),
   * scaled to fit and centred. Absent, it takes its frame's width.
   */
  box?: { width: number; height: number };
  /** A virtual deck's screen, when known: a layout made for another size is fitted inside it, as on the deck and in Edit layout. */
  screen?: { width: number; height: number } | null;
  /**
   * A virtual deck's page background as drawn — the page's own, or one being
   * changed in its panel and not yet saved. Drawn behind the keys over the
   * whole screen (PageGround). Ignored on a Stream Deck.
   */
  background?: PageBackgroundDef;
}

/** The stamp of a background's image (App's iconStamps), so a file changed on disk is drawn again. */
export function iconStampOf(stamps: Record<string, string>, background: PageBackgroundDef | undefined): string | undefined {
  return background?.image ? stamps[background.image] : undefined;
}

/** How far the pointer must travel before a press becomes a drag, so a slightly shaky click still selects. */
const DRAG_THRESHOLD_PX = 6;

/** Where a dragged key may land: on this deck, a move; on another shown deck, a copy. */
interface KeyDrop {
  onMoveKey: ((from: string, to: string) => void) | null;
  onCopyKey: ((from: string, to: KeyRef) => void) | null;
  /** The key under the pointer while a key is dragged, on any deck, or null: drawn by the grid it is on, with why it refuses the drop if it does. */
  onDragOver: (over: (KeyRef & { refused?: string | null }) | null) => void;
  /** The kind of a key on this grid: a slider's or dial's contents go only onto a slider or dial, a button's only onto a button. */
  kindOf: (key: string) => 'slider' | 'dial' | undefined;
  /** The action on a key of this grid, for the refusal's words. */
  actionOf: (key: string) => string | undefined;
}


/**
 * Key onto key: drag a button and drop it on another key. On this deck it
 * moves, and an occupied key swaps; on another shown deck it is copied there
 * and the original stays. Only the key under the pointer goes,
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
  const press = useRef<{ from: string; pointerId: number; x: number; y: number } | null>(null);
  // The drag as drawn, and a ref to the same, for the window listeners below.
  const [drag, setDragState] = useState<{ from: string; over: KeyRef | null } | null>(null);
  const dragRef = useRef(drag);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const setDrag = (next: { from: string; over: KeyRef | null } | null) => {
    const before = dragRef.current?.over ?? null;
    dragRef.current = next;
    setDragState(next);
    const after = next?.over ?? null;
    if (before?.serial !== after?.serial || before?.key !== after?.key) {
      const refused = next && after ? keyDropRefused(dropRef.current.kindOf(next.from), dropRef.current.actionOf(next.from), after.kind) : null;
      dropRef.current.onDragOver(after ? { ...after, refused } : null);
    }
  };
  const serialRef = useRef(serial);
  serialRef.current = serial;
  // A drag that ends back on its own key still produces a click there; it is not a selection click.
  const suppressClick = useRef(false);

  // Added once for the grid's lifetime. Each returns at once unless a key was pressed.
  useEffect(() => {
    /** The key a drop would land on: any key of this deck but the one dragged, or a key on another deck when copying is allowed. */
    const targetUnder = (x: number, y: number, from: string): KeyRef | null => {
      const key = keyUnder(x, y);
      if (key === null) return null;
      if (key.serial === serialRef.current) return key.key === from ? null : key;
      return dropRef.current.onCopyKey ? key : null;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      const over = targetUnder(e.clientX, e.clientY, p.from);
      const now = dragRef.current;
      if (now === null || now.from !== p.from || now.over?.serial !== over?.serial || now.over?.key !== over?.key) setDrag({ from: p.from, over });
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
      suppressClick.current = back !== null && back.serial === serialRef.current && back.key === p.from;
      setDrag(null);
      if (over === null) return;
      // Refused while still in the air (26e): letting go drops nothing.
      if (keyDropRefused(dropRef.current.kindOf(p.from), dropRef.current.actionOf(p.from), over.kind) !== null) return;
      if (over.serial === serialRef.current) dropRef.current.onMoveKey?.(p.from, over.key);
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
    onPointerDown: (key: string, occupied: boolean, e: ReactPointerEvent) => {
      if (!drop.onMoveKey || !occupied || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      press.current = { from: key, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
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


/** An icon drawn `scale` of the key, centred, as the deck draws a built-in (src/render.ts); 1 fills it. */
/**
 * An icon at `scale` of its key's box, on the deck's one rule (src/icon-scale.ts):
 * the image fitted whole (object-fit: contain) in a box `scale` times the key's,
 * centred; above 1 the key's own shape (its overflow, radius or clip-path) cuts it.
 */
function scaled(scale: number): CSSProperties {
  if (scale === 1) return {};
  const inset = `${((1 - scale) / 2) * 100}%`;
  return { inset: 'auto', left: inset, top: inset, width: `${scale * 100}%`, height: `${scale * 100}%` };
}

export function DeckGrid({ config, geometry, page, iconStamps, appIcons, failedKeys, notSetUp, latchedKeys, liveFaces, values, selectedKeys, onClickKey, onKeyMenu, onMoveKey, onCopyKey, onKeyDragOver, dropTarget, dropRefused = null, box, screen, background }: Props) {
  const keyDrag = useKeyDrag(geometry.serial, {
    onMoveKey,
    onCopyKey,
    onDragOver: onKeyDragOver,
    kindOf: (key) => geometry.keys.find((k) => k.id === key)?.kind,
    actionOf: (key) => page.buttons[key]?.action?.type,
  });
  // A virtual deck: every page drawn as its panel places it (round 2a). A Stream Deck: its grid, as always.
  const canvas = geometry.units === 'pixels' && geometry.canvas && geometry.canvas.width > 0 && geometry.canvas.height > 0 ? geometry.canvas : null;
  const gridStyle: CSSProperties = canvas
    ? positionedBox(canvas, box, screen)
    : {
        gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${geometry.rows}, auto)`,
        // Keys keep roughly the deck's proportions whatever the column count.
        maxWidth: `calc(${geometry.columns} * 104px)`,
      };

  // The background covers the whole screen: past a layout made for another size, which sits centred in it.
  let groundInset: { x: number; y: number } | undefined;
  if (canvas && box && screen && madeForAnother(canvas, screen) && 'height' in gridStyle) {
    const s = fitScale(screen, box);
    groundInset = { x: Math.max(0, (screen.width * s - (gridStyle.width as number)) / 2), y: Math.max(0, (screen.height * s - (gridStyle.height as number)) / 2) };
  }

  return (
    <div className={canvas ? 'grid grid-positioned' : 'grid'} style={gridStyle} data-deck={geometry.serial}>
      {canvas && <PageGround background={background ?? page.background} stamp={iconStampOf(iconStamps, background ?? page.background)} inset={groundInset} />}
      {geometry.keys.map((k, i) => (
        <Key
          key={k.id}
          serial={geometry.serial}
          config={config}
          id={k.id}
          number={i + 1}
          row={k.row}
          column={k.column}
          place={canvas ? placeOf(k, canvas) : undefined}
          hasScreen={k.feedback === 'lcd'}
          iconSize={canvas ? null : geometry.iconSize}
          button={page.buttons[k.id]}
          iconStamps={iconStamps}
          appIcons={appIcons}
          failure={failedKeys[k.id]}
          unset={notSetUp(page.buttons[k.id]?.action?.type)}
          latched={latchedKeys.includes(k.id)}
          live={liveFaces[k.id] ?? null}
          value={values?.[k.id] ?? null}
          selected={selectedKeys.includes(k.id)}
          onClick={(modifiers) => {
            if (!keyDrag.takeSuppressedClick()) onClickKey(k.id, modifiers);
          }}
          onMenu={(x, y) => onKeyMenu(k.id, x, y)}
          onPointerDown={(occupied, e) => keyDrag.onPointerDown(k.id, occupied, e)}
          dragging={keyDrag.drag?.from === k.id}
          dropTarget={dropTarget === k.id}
          dropRefused={dropTarget === k.id ? dropRefused : null}
        />
      ))}
    </div>
  );
}

export interface KeyProps {
  /** The deck this key is on, for the drags (keyUnder.ts). */
  serial: string;
  config: Config;
  /** Its control id. */
  id: string;
  /** Where it is as people count keys, from 1, in reading order: "Key 5". */
  number: number;
  row: number;
  column: number;
  /** On a virtual deck: where the key sits on its panel and its shape (placeOf). Absent on a Stream Deck's grid. */
  place?: Place;
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
  /** The state the deck shows it in, for a key with states; null for none known. */
  live: LiveFace | null;
  /** A slider's or dial's value on the deck, whole percent; null or absent when not known. */
  value?: number | null;
  selected: boolean;
  onClick: (modifiers: { ctrl: boolean; shift: boolean }) => void;
  onMenu: (x: number, y: number) => void;
  onPointerDown: (occupied: boolean, e: ReactPointerEvent) => void;
  /** This key is being dragged (drawn dimmed). */
  dragging: boolean;
  /** A dragged key is over this one (drawn as the dashed drop target). */
  dropTarget: boolean;
  /** …and refuses it, saying why (26e): a soft red dashed outline in its shape and the line. */
  dropRefused?: string | null;
}

export function Key({ serial, config, id, number, row, column, place, hasScreen, iconSize, button, iconStamps, appIcons, failure, unset, latched, live, value = null, selected, onClick, onMenu, onPointerDown, dragging, dropTarget, dropRefused = null }: KeyProps) {
  if (place?.kind) {
    return <ValueKey {...{ serial, config, id, number, place: place as Place & { kind: 'slider' | 'dial' }, button, iconStamps, failure, unset, value, selected, onClick, onMenu, onPointerDown, dragging, dropTarget, dropRefused }} />;
  }
  const unsetName = INTEGRATIONS[integrationOf(button?.action?.type) ?? 'obs'].name;
  const kind = keyKind(button);
  const incomplete = actionIncomplete(button?.action);
  // A placed key's label is sized to its inner rectangle (shapes.ts): the deck lays it out there.
  const face = keyFace(config, button, place ? place.inner.px : iconSize, live, appIcons);
  const stamp = face.icon === null ? undefined : iconStamps[face.icon];
  // Which icon failed to load, by path and stamp, so a changed path — or the
  // same path whose file changed — is tried again.
  const [missingIcon, setMissingIcon] = useState<string | null>(null);
  const iconId = face.icon === null ? null : `${face.icon}|${stamp ?? ''}`;
  // An image file the limits refuse is drawn as the deck draws it, the missing icon, with its reason (round 4).
  const verdict = useImageCheck(face.icon !== null && !face.icon.startsWith(BUILTIN_PREFIX) ? face.icon : null, stamp);
  const refusal = verdict?.state === 'refused' ? verdict.message : null;
  const iconMissing = iconId !== null && (missingIcon === iconId || refusal !== null);
  const classes = [
    'key',
    kind === 'bound' ? '' : `key-${kind}`,
    selected ? 'key-selected' : '',
    hasScreen ? '' : 'key-no-screen',
    dragging ? 'key-dragging' : '',
    dropTarget ? (dropRefused ? 'key-drop-refused' : 'key-drop-target') : '',
    incomplete ? 'key-incomplete' : '',
    latched ? 'key-latched' : '',
    unset ? 'key-unset' : '',
    place ? 'key-placed' : '',
    place && !place.fills ? 'key-shaped' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title =
    kind === 'empty'
      ? `Key ${number}: empty`
      : `Key ${number}: ${describeAction(button)}${latched ? ' — held down now' : ''}${unset ? ` — ${unsetName} is not set up` : ''}`;

  const faceText = (
    <>
      {face.label && (
        <span
          className={`key-label key-label-${face.labelPosition}`}
          // The deck's label size relative to its key pixels, applied to this key's width (container units).
          style={{ color: face.labelColor, fontFamily: face.labelFont, fontSize: `calc(${face.labelScale} * 100cqw)` }}
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
    </>
  );

  return (
    <button
      className={classes}
      // On a virtual deck every control is opaque, an empty one the plain key face, as the deck draws it:
      // the page's background never shows through a button (Ryan, 2026-11-18). A Stream Deck's empty key stays a dashed gap.
      style={{ ...(place ? place.style : { gridRow: row + 1, gridColumn: column + 1 }), background: kind === 'empty' && !place ? undefined : face.background }}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      data-deck={serial}
      data-key={id}
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
          style={{ objectFit: 'contain', ...scaled(face.iconScale) }}
          draggable={false}
          onError={() => setMissingIcon(iconId)}
        />
      )}
      {iconMissing && (
        // The same built-in the deck draws for an icon it cannot read.
        <img className="key-icon key-icon-missing" src={missingIconUrl} alt="" title={refusal ?? `Cannot read ${face.icon}`} data-icon-refused={refusal ?? undefined} style={scaled(face.builtinScale)} draggable={false} />
      )}
      {place ? (
        // The label, the marks and the badge in the shape's largest inner rectangle, as the deck draws them (src/render.ts renderFace).
        <span className="key-inner" style={place.inner.style}>
          {faceText}
        </span>
      ) : (
        faceText
      )}
      {dropTarget && dropRefused && <span className="drop-refused-line" data-drop-refused="">{dropRefused}</span>}
      {place && !place.fills && (
        // The shape's outline: the editor's own (the deck draws none), its colour saying selected or empty.
        <svg className="key-outline" viewBox={`0 0 ${place.w} ${place.h}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={place.path} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </button>
  );
}

/**
 * A slider or dial (src/value-controls.ts): its art and level (ValueFace), its
 * label in its band, the failed or not-set-up badge; no fill unless the key
 * has a background of its own — the page shows around the art.
 */
function ValueKey({ serial, config, id, number, place, button, iconStamps, failure, unset, value, selected, onClick, onMenu, onPointerDown, dragging, dropTarget, dropRefused }: Pick<KeyProps, 'serial' | 'config' | 'id' | 'number' | 'button' | 'iconStamps' | 'failure' | 'unset' | 'selected' | 'onClick' | 'onMenu' | 'onPointerDown' | 'dragging' | 'dropTarget' | 'dropRefused'> & { place: Place & { kind: 'slider' | 'dial' }; value: number | null }) {
  const kind = keyKind(button);
  const what = place.kind === 'slider' ? 'Slider' : 'Dial';
  const title = kind === 'empty' ? `${what}, key ${number}: empty` : `${what}, key ${number}: ${describeAction(button)}${value !== null ? ` — ${value}%` : ''}`;
  const classes = ['key', 'key-value', kind === 'empty' ? 'key-empty' : '', selected ? 'key-selected' : '', dragging ? 'key-dragging' : '', dropTarget ? (dropRefused ? 'key-drop-refused' : 'key-drop-target') : '', unset ? 'key-unset' : ''].filter(Boolean).join(' ');
  return (
    <button
      className={classes}
      style={{ ...place.style, background: button?.background ?? 'transparent' }}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      data-deck={serial}
      data-key={id}
      data-control-kind={place.kind}
      onPointerDown={(e) => onPointerDown(kind !== 'empty', e)}
      onClick={(e) => onClick({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <ValueFace kind={place.kind} direction={place.direction} w={place.w} h={place.h} button={button} config={config} value={value} stamps={iconStamps} />
      {dropTarget && dropRefused && <span className="drop-refused-line" data-drop-refused="">{dropRefused}</span>}
      <span className="key-inner" style={place.inner.style}>
        {unset && <span className="key-failed key-unset-badge" dangerouslySetInnerHTML={{ __html: unsetBadgeSvg(100) }} />}
        {failure !== undefined && !unset && <span className="key-failed" title={`Its last change failed: ${failure}`} dangerouslySetInnerHTML={{ __html: failedBadgeSvg(100) }} />}
      </span>
    </button>
  );
}

/** A key's place on a virtual deck's panel, as CSS: in percent of the panel, so it scales with it. */
export interface Place {
  /** A slider or dial (src/value-controls.ts); absent for a button. */
  kind?: 'slider' | 'dial';
  direction?: 'vertical' | 'horizontal';
  style: CSSProperties;
  /** Its box in canvas pixels. */
  w: number;
  h: number;
  /** A rectangle with square corners: drawn as a plain key, with no outline of its own. */
  fills: boolean;
  /** Its outline (shapes.ts shapePath), in its box's pixels. */
  path: string;
  /** Its largest inner rectangle: where the label, marks and badge go, and its width in canvas pixels. */
  inner: { style: CSSProperties; px: number };
}

const pct = (v: number) => `${v * 100}%`;

/** The hexagon's six corners, as a clip-path: in percent, so it stretches with its box as the deck's does. */
const HEXAGON_CLIP = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

export function placeOf(k: { x: number; y: number; w: number; h: number; shape: string; radius?: number; z?: number; index: number; kind?: 'slider' | 'dial'; direction?: 'vertical' | 'horizontal' }, canvas: { width: number; height: number }): Place {
  const box = { w: k.w, h: k.h, shape: k.shape, radius: k.radius };
  const shape = shapeName(k.shape);
  const r = cornerRadius(box);
  const inner = innerRect(box);
  const style: CSSProperties = {
    position: 'absolute',
    left: pct(k.x / canvas.width),
    top: pct(k.y / canvas.height),
    width: pct(k.w / canvas.width),
    height: pct(k.h / canvas.height),
    // The panel's own order: the later is on top, as on the deck.
    zIndex: (k.z ?? k.index) + 1,
    aspectRatio: 'auto',
    borderRadius: shape === 'round' ? '50%' : `${pct(r / k.w)} / ${pct(r / k.h)}`,
    ...(shape === 'hexagon' ? { clipPath: HEXAGON_CLIP } : {}),
  };
  return {
    ...(k.kind ? { kind: k.kind } : {}),
    ...(k.kind === 'slider' && k.direction ? { direction: k.direction } : {}),
    style,
    w: k.w,
    h: k.h,
    fills: fillsBox(box),
    path: shapePath(box),
    inner: {
      style: { left: pct(inner.x / k.w), top: pct(inner.y / k.h), width: pct(inner.w / k.w), height: pct(inner.h / k.h) },
      px: inner.w,
    },
  };
}


/** The panel drawn at its own proportions, as large as fits the room it has, centred. */
