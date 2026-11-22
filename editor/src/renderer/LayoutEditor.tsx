import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { geometryOfPanel } from '../../../src/geometry.js';
import type { ScreenSize } from '../../../src/panel-presets.js';
import { cornerRadius, shapeName, SHAPE_NAMES, type ShapeName } from '../../../src/shapes.js';
import type { ButtonDef, Config, PageBackgroundDef, PageDef, PanelControlDef, PanelDef } from '../../../src/types.js';
import { bringToFront, controlNames, HANDLES, overlaps, sendToBack, setShape, typedSize, verySmallMm, withControl, type Handle } from '../shared/layout-edit.js';
import { align, ALIGNMENTS, distribute, GRID_PITCHES, groupPosition, inMarquee, match, MAX_PITCH, MIN_PITCH, moveGroupTo, placeGroup, placeMoved, placeResized, SNAP_SCREEN_PX, snapTargets, type Alignment, type Guides, type Placing, type SnapGuide } from '../shared/layout-arrange.js';
import { Dropdown } from './Dropdown.js';
import { layoutScale, madeForAnother } from '../shared/templates.js';
import { Switch } from './settings-ui.js';
import { describeAction, keyKind, type AppIcons } from './model.js';
import { iconStampOf, Key, placeOf } from './DeckGrid.js';
import { PageGround } from './PageGround.js';
import { Checkbox, Row, Segmented } from './inspector/controls.js';
import { controlKind, type ControlKind } from '../../../src/value-controls.js';

/**
 * Edit layout mode (scope §7, round 2a; boards 21–23): the page's controls
 * moved, resized and reshaped on the canvas, a control added from the
 * Controls palette, and the layout inspector. **Only layout**: nothing here
 * changes an action, an icon or a label. Everything is in the panel's canvas
 * pixels. App.tsx owns the mode and saves; this draws it.
 */

/** A drag in progress: the boxes as they were picked up, and the pointer then. */
interface Drag {
  /** The controls moving: one with a handle, or every selected one. */
  ids: string[];
  /** null: the controls themselves move; a handle: that edge or corner of the one. */
  handle: Handle | null;
  pointer: number;
  from: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  start: { x: number; y: number };
  /** Screen pixels per canvas pixel when it began (the canvas's zoom included). */
  scale: number;
  moved: boolean;
  /** What a move can snap to, from the controls not moving: worked out once, when the drag begins. */
  targets: ReturnType<typeof snapTargets>;
}

/** A marquee being dragged over empty canvas (22c): where it began, in canvas pixels; Ctrl adds to the selection. */
interface Marquee {
  pointer: number;
  start: { x: number; y: number };
  at: { x: number; y: number };
  add: boolean;
  before: string[];
  moved: boolean;
}

/** A press that moves less than this, on screen, is a click. */
const DRAG_START_PX = 3;

const SHAPE_LABELS: Record<ShapeName, string> = { rectangle: 'Rectangle', round: 'Round', hexagon: 'Hexagon' };

export function LayoutCanvas({
  config,
  serial,
  panel,
  page,
  box,
  screen,
  selected,
  guides,
  iconStamps,
  appIcons,
  onSelect,
  onChange,
  background,
}: {
  config: Config;
  serial: string;
  /** The page's background, kept visible behind the controls in the mode (21c, 24b), over the whole screen. */
  background?: PageBackgroundDef;
  /** The layout as the mode holds it: empty while a Blank page has no control yet. */
  panel: PanelDef;
  page: PageDef;
  /** The room in the deck's frame, in pixels at 100%. */
  box: { width: number; height: number };
  /**
   * The screen's pixels, when known. A layout made for another size (a
   * template from another screen) is drawn as the deck shows it: the screen
   * whole, the layout scaled to fit and centred, its own area dashed (24c).
   */
  screen?: { width: number; height: number } | null;
  /** The selected controls, in the order they were selected. */
  selected: string[];
  /** Grid, its pitch, and Snap (22g). */
  guides: Guides;
  iconStamps: Record<string, string>;
  appIcons: AppIcons;
  onSelect: (ids: string[]) => void;
  /** A change made: saved by App as it is made (a drag on its release). */
  onChange: (panel: PanelDef) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  // While a drag is in progress, the layout as drawn: saved when it ends. The
  // ref is what the release reads: a release can come before React has drawn
  // the last move, and the state it closed over would be a move behind.
  const [live, setLiveState] = useState<PanelDef | null>(null);
  const liveRef = useRef<PanelDef | null>(null);
  const setLive = (next: PanelDef | null) => {
    liveRef.current = next;
    setLiveState(next);
  };
  /** The lines snapped to, drawn while a drag holds them (22a). */
  const [snapped, setSnapped] = useState<SnapGuide[]>([]);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const shown = live ?? panel;
  const size = shown.size;
  const other = madeForAnother(size, screen) ? screen! : null;
  // On another screen size: the screen fitted to the room, then the layout at the one scale the deck uses.
  const screenScale = other ? Math.min(box.width / other.width, box.height / other.height) : 0;
  const scale = layoutScale(size, box, screen);
  const style: CSSProperties = { width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) };
  const geometry = geometryOfPanel(shown, '');
  const names = controlNames(shown);
  const layered = overlaps(shown);
  const control = (id: string | null) => (id === null ? undefined : shown.controls.find((c) => c.id === id));
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  /** A pointer's place in canvas pixels. */
  const canvasAt = (clientX: number, clientY: number) => {
    const r = surface.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * size.width, y: ((clientY - r.top) / r.height) * size.height };
  };

  const begin = (id: string, handle: Handle | null) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = control(id);
    const el = surface.current;
    if (!c || !el) return;
    // Ctrl-click adds a control to the selection, or takes it out (22c); it does not move anything.
    if (e.ctrlKey && handle === null) {
      onSelect(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
      return;
    }
    // A control already among several selected moves them all; any other is selected alone.
    const ids = handle === null && selected.includes(id) && selected.length > 1 ? selected.filter((s) => shown.controls.some((k) => k.id === s)) : [id];
    if (ids.length === 1) onSelect([id]);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (the checks) has nothing to capture.
    }
    dragRef.current = {
      ids,
      handle,
      pointer: e.pointerId,
      from: ids.map((k) => ({ ...shown.controls.find((x) => x.id === k)! })).map(({ id: k, x, y, w, h }) => ({ id: k, x, y, w, h })),
      start: { x: e.clientX, y: e.clientY },
      scale: el.getBoundingClientRect().width / size.width,
      moved: false,
      targets: snapTargets(shown, new Set(ids)),
    };
  };

  const move = (e: ReactPointerEvent) => {
    const m = marqueeRef.current;
    if (m && m.pointer === e.pointerId) {
      const at = canvasAt(e.clientX, e.clientY);
      const scaleNow = surface.current!.getBoundingClientRect().width / size.width;
      if (!m.moved && Math.hypot((at.x - m.start.x) * scaleNow, (at.y - m.start.y) * scaleNow) < DRAG_START_PX) return;
      const next = { ...m, at, moved: true };
      marqueeRef.current = next;
      setMarquee(next);
      const hits = inMarquee(shown, marqueeBox(next));
      onSelect(next.add ? [...next.before, ...hits.filter((h) => !next.before.includes(h))] : hits);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const sx = e.clientX - drag.start.x;
    const sy = e.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(sx, sy) < DRAG_START_PX) return;
    drag.moved = true;
    const dx = sx / drag.scale;
    const dy = sy / drag.scale;
    // Shift held: free to the pixel, the grid and snapping both ignored (22a).
    const how: Placing = { grid: guides.grid && !e.shiftKey, pitch: guides.pitch, snap: guides.snap && !e.shiftKey, reach: SNAP_SCREEN_PX / drag.scale, targets: drag.targets };
    if (drag.ids.length > 1) {
      const placed = placeGroup(panel, drag.ids, drag.from, dx, dy, how);
      setSnapped(placed.guides);
      setLive(placed.panel);
      return;
    }
    const id = drag.ids[0];
    const c = panel.controls.find((k) => k.id === id);
    if (!c) return;
    const from = drag.from[0];
    const placed = drag.handle === null ? placeMoved({ ...from, x: from.x + dx, y: from.y + dy }, size, how) : placeResized(from, drag.handle, dx, dy, size, !!c.keepRatio, how);
    setSnapped(placed.guides);
    setLive(withControl(panel, id, placed.box));
  };

  const end = (e: ReactPointerEvent) => {
    const m = marqueeRef.current;
    if (m && m.pointer === e.pointerId) {
      marqueeRef.current = null;
      setMarquee(null);
      // A click on empty canvas, not a marquee: nothing selected (Ctrl-click there changes nothing).
      if (!m.moved && !m.add) onSelect([]);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    dragRef.current = null;
    const result = liveRef.current;
    setLive(null);
    setSnapped([]);
    if (drag.moved && result) onChange(result);
  };

  // A new layout from App (saved, or a change elsewhere) ends any drag's picture.
  useEffect(() => {
    if (!dragRef.current) setLive(null);
  }, [panel]);

  const dragging = dragRef.current?.moved && dragRef.current.ids.length === 1 ? control(dragRef.current.ids[0]) : undefined;
  const chosen = selected.map((id) => control(id)).filter((c): c is PanelControlDef => c !== undefined);

  const canvas = (
    <div
      ref={surface}
      className={other ? 'layout-canvas layout-canvas-other' : 'layout-canvas'}
      style={style}
      data-layout-box={serial}
      data-layout-size={`${size.width}x${size.height}`}
      onPointerDown={(e) => {
        // Empty canvas: a marquee begins, or a click selects nothing (on release).
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        e.preventDefault();
        try {
          surface.current?.setPointerCapture(e.pointerId);
        } catch {
          // A synthetic pointer (the checks) has nothing to capture.
        }
        const at = canvasAt(e.clientX, e.clientY);
        marqueeRef.current = { pointer: e.pointerId, start: at, at, add: e.ctrlKey, before: selected, moved: false };
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => {
        dragRef.current = null;
        marqueeRef.current = null;
        setMarquee(null);
        setSnapped([]);
        setLive(null);
      }}
    >
      {/* The page's background behind everything: on the screen around a layout made for another size, else here. */}
      {!other && <PageGround background={background} stamp={iconStampOf(iconStamps, background)} />}
      {/* The grid's lines, drawn only in the editor (22g): behind the controls. */}
      {guides.grid && (
        <div
          className="layout-grid"
          aria-hidden="true"
          data-layout-grid={guides.pitch}
          style={{ backgroundSize: `${pct(guides.pitch, size.width)} ${pct(guides.pitch, size.height)}` }}
        />
      )}
      {geometry.keys.map((k, i) => {
        const place = placeOf(k, size);
        return (
          <Key
            key={k.id}
            serial={serial}
            config={config}
            id={k.id}
            number={i + 1}
            row={k.row}
            column={k.column}
            place={place}
            hasScreen
            iconSize={null}
            button={page.buttons[k.id]}
            iconStamps={iconStamps}
            appIcons={appIcons}
            failure={undefined}
            unset={false}
            latched={false}
            live={null}
            selected={selected.includes(k.id)}
            onClick={() => {}}
            onMenu={() => {}}
            onPointerDown={(_occupied, e) => begin(k.id, null)(e)}
            dragging={false}
            dropTarget={false}
          />
        );
      })}
      {/* Above every control: the marker, the selection's frames and handles, the guides and the marquee. */}
      <div className="layout-overlay">
        {shown.controls.map((c) => {
          const over = layered.get(c.id)?.under ?? [];
          if (over.length === 0) return null;
          return (
            <span
              key={c.id}
              className="layout-overlap-marker"
              style={{ left: pct(c.x + c.w, size.width), top: pct(c.y + c.h, size.height) }}
              title={`${names.get(c.id)} has ${over.map((id) => names.get(id)).join(' and ')} on top of it`}
              data-overlapped={c.id}
            />
          );
        })}
        {chosen.length === 1 && <Selection c={chosen[0]} size={size} onHandle={(h) => begin(chosen[0].id, h)} />}
        {chosen.length > 1 &&
          chosen.map((c) => (
            <span key={c.id} className="layout-selection layout-selection-several" style={{ left: pct(c.x, size.width), top: pct(c.y, size.height), width: pct(c.w, size.width), height: pct(c.h, size.height) }} data-selected-control={c.id} />
          ))}
        {snapped.map((g, i) => (
          <span key={i} className={`layout-snap layout-snap-${g.axis}`} style={g.axis === 'x' ? { left: pct(g.at, size.width) } : { top: pct(g.at, size.height) }} data-snap-guide={g.label}>
            <span className="layout-snap-label">snap · {g.label}</span>
          </span>
        ))}
        {marquee && marquee.moved && (() => {
          const b = marqueeBox(marquee);
          return <span className="layout-marquee" style={{ left: pct(b.x, size.width), top: pct(b.y, size.height), width: pct(b.w, size.width), height: pct(b.h, size.height) }} data-marquee="" />;
        })()}
        {dragging && (
          <span className="layout-readout" style={{ left: pct(dragging.x + dragging.w, size.width), top: pct(dragging.y, size.height) }}>
            {dragRef.current?.handle === null ? `${dragging.x}, ${dragging.y}` : `${dragging.w} × ${dragging.h}`}
          </span>
        )}
      </div>
      {shown.controls.length === 0 && <p className="layout-empty muted">Drag a control here</p>}
    </div>
  );
  if (!other) return canvas;
  return (
    <div className="layout-screen" style={{ width: Math.floor(other.width * screenScale), height: Math.floor(other.height * screenScale) }} data-layout-screen={`${other.width}x${other.height}`}>
      <PageGround background={background} stamp={iconStampOf(iconStamps, background)} />
      {canvas}
    </div>
  );
}

/**
 * A slider turned the other way: its box turned about its centre too, so a
 * tall one becomes a wide one (Claude's call), kept on the canvas. Vertical is
 * stored as nothing.
 */
function turned(c: PanelControlDef, direction: 'vertical' | 'horizontal', size: { width: number; height: number }): Partial<PanelControlDef> {
  const now = c.direction ?? 'vertical';
  const out: Partial<PanelControlDef> = { direction: direction === 'vertical' ? undefined : direction };
  if (now === direction) return out;
  const longFirst = direction === 'horizontal' ? c.w < c.h : c.h < c.w;
  if (!longFirst) return out;
  const w = Math.min(c.h, size.width);
  const h = Math.min(c.w, size.height);
  return { ...out, w, h, x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2 };
}

/** A marquee's rectangle in canvas pixels, whichever way it was dragged. */
function marqueeBox(m: Marquee): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(m.start.x, m.at.x), y: Math.min(m.start.y, m.at.y), w: Math.abs(m.at.x - m.start.x), h: Math.abs(m.at.y - m.start.y) };
}

/** The selected control's frame and its eight handles. */
function Selection({ c, size, onHandle }: { c: PanelControlDef; size: { width: number; height: number }; onHandle: (h: Handle) => (e: ReactPointerEvent) => void }) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <span className="layout-selection" style={{ left: pct(c.x, size.width), top: pct(c.y, size.height), width: pct(c.w, size.width), height: pct(c.h, size.height) }} data-selected-control={c.id}>
      {HANDLES.map((h) => (
        <span key={h} className={`layout-handle layout-handle-${h}`} data-handle={h} onPointerDown={onHandle(h)} />
      ))}
    </span>
  );
}

/** The palette's controls, in its order (21a): a Button, a Slider and a Dial (round 5). */
const PALETTE: ReadonlyArray<{ kind: ControlKind; label: string }> = [
  { kind: 'button', label: 'Button' },
  { kind: 'slider', label: 'Slider' },
  { kind: 'dial', label: 'Dial' },
];

/**
 * The library pane in Edit layout: the Controls palette (21a) — Button, Slider
 * and Dial. A control is dragged onto the panel; a click adds it in the middle
 * — Claude's call, so it can be added without a drag.
 */
export function ControlsPalette({ onDrop, onAdd }: { onDrop: (kind: ControlKind, clientX: number, clientY: number) => void; onAdd: (kind: ControlKind) => void }) {
  const [drag, setDrag] = useState<{ x: number; y: number; kind: ControlKind } | null>(null);
  const press = useRef<{ pointer: number; x: number; y: number; moved: boolean; kind: ControlKind } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointer !== e.pointerId) return;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
      p.moved = true;
      setDrag({ x: e.clientX, y: e.clientY, kind: p.kind });
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointer !== e.pointerId) return;
      press.current = null;
      setDrag(null);
      if (p.moved) onDrop(p.kind, e.clientX, e.clientY);
      else onAdd(p.kind);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && press.current) {
        press.current = null;
        setDrag(null);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDrop, onAdd]);
  return (
    <aside className="library glass controls-palette" aria-label="Controls" data-controls-palette="">
      <div className="library-header">
        <h2 className="library-heading">Controls</h2>
      </div>
      <ul className="palette-list">
        {PALETTE.map(({ kind, label }) => (
          <li key={kind}>
            <button
              className="palette-entry"
              data-palette={kind}
              title="Drag onto the panel, or click to add one in the middle"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                press.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false, kind };
              }}
            >
              <span className={`palette-glyph palette-glyph-${kind}`} aria-hidden="true" />
              {label}
            </button>
          </li>
        ))}
      </ul>
      {drag &&
        createPortal(
          <div className="action-drag" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
            {PALETTE.find((p) => p.kind === drag.kind)?.label}
          </div>,
          document.body,
        )}
    </aside>
  );
}

/**
 * The inspector in Edit layout (21a, 21c, 22e, 22f): with nothing selected it
 * names the deck; with one control, its position, size, shape and order,
 * Duplicate and Delete. Typed values are saved on Enter or leaving the field,
 * and stop at the canvas's edge.
 */
export function LayoutInspector({
  deckName,
  panel,
  page,
  selected,
  screen,
  onChange,
  onDuplicate,
  onDelete,
}: {
  deckName: string;
  panel: PanelDef;
  page: PageDef;
  /** The selected controls, in the order they were selected. */
  selected: string[];
  screen: ScreenSize | null;
  onChange: (panel: PanelDef) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const size = `${panel.size.width} × ${panel.size.height}`;
  if (selected.length > 1) return <SeveralInspector panel={panel} selected={selected} onChange={onChange} onDuplicate={onDuplicate} onDelete={onDelete} />;
  const c = selected.length === 0 ? undefined : panel.controls.find((k) => k.id === selected[0]);
  if (!c) {
    return (
      <aside className="inspector glass" aria-label="Inspector" data-layout-inspector="none">
        <h2 className="inspector-title">{deckName}</h2>
        <p className="muted">{panel.controls.length === 0 ? `${size} · no controls yet` : `${size} · ${panel.controls.length} ${panel.controls.length === 1 ? 'control' : 'controls'}`}</p>
      </aside>
    );
  }
  const names = controlNames(panel);
  const layered = overlaps(panel).get(c.id) ?? { over: [], under: [] };
  const small = verySmallMm(screen, panel, c);
  const shape = shapeName(c.shape);
  const set = (change: Partial<PanelControlDef>) => onChange(withControl(panel, c.id, change));
  const list = (ids: string[]) => ids.map((id) => names.get(id)).join(' and ');
  const kind = controlKind(c);
  return (
    <aside className="inspector glass" aria-label="Inspector" data-layout-inspector={c.id}>
      <h2 className="inspector-title">{kind === 'slider' ? 'Slider' : kind === 'dial' ? 'Dial' : 'Button'}</h2>
      <p className="muted inspector-sub">{names.get(c.id)}</p>

      {kind === 'slider' && (
        // A slider's own settings (26b): part of the layout, so a template keeps them.
        <section className="inspector-section" data-inspector-section="slider">
          <h3 className="section-heading">Slider</h3>
          <Segmented
            label="Direction"
            options={[
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
            ]}
            value={c.direction ?? 'vertical'}
            disabled={false}
            onChoose={(direction) => onChange(withControl(panel, c.id, turned(c, direction as 'vertical' | 'horizontal', panel.size)))}
          />
          <Segmented
            label="Touch"
            options={[
              { value: 'drag', label: 'Drag only' },
              { value: 'jump', label: 'Jump to touch' },
            ]}
            value={c.touch ?? 'drag'}
            disabled={false}
            onChoose={(touch) => set(touch === 'drag' ? { touch: undefined } : { touch: 'jump' })}
          />
          <p className="muted small" data-touch-note="">
            {(c.touch ?? 'drag') === 'drag' ? 'A tap changes nothing: the level moves by how far your finger moves.' : 'The level goes to your finger at once, then follows it.'}
          </p>
        </section>
      )}

      <section className="inspector-section">
        <h3 className="section-heading">Position</h3>
        <div className="layout-fields">
          <NumberField label="X" value={c.x} onSave={(x) => set({ x })} />
          <NumberField label="Y" value={c.y} onSave={(y) => set({ y })} />
        </div>
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">Size</h3>
        <div className="layout-fields">
          <NumberField label="W" value={c.w} onSave={(w) => set(typedSize(c, 'w', w, panel.size))} />
          <NumberField label="H" value={c.h} onSave={(h) => set(typedSize(c, 'h', h, panel.size))} />
        </div>
        <Checkbox label="Lock proportions" checked={!!c.keepRatio} disabled={false} onChange={(on) => set(on ? { keepRatio: true } : { keepRatio: undefined })} />
        {small && (
          <p className="muted small vd-warning" data-very-small={c.id}>
            {small.mm === null ? 'Very small. Hard to press.' : `Very small · about ${small.mm} mm. Hard to press.`}
          </p>
        )}
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">{kind === 'button' ? 'Shape' : 'Corners'}</h3>
        {/* A slider or dial is a rectangle (Ryan, 2026-11-22): round and hexagon cut off a dial's ring and label. Its corners stay. */}
        {kind === 'button' && (
          <Segmented
            label="Shape"
            options={SHAPE_NAMES.map((s) => ({ value: s, label: SHAPE_LABELS[s] }))}
            value={shape}
            disabled={false}
            onChoose={(s) => onChange(setShape(panel, c.id, s))}
          />
        )}
        {shape === 'rectangle' && (
          <Row name="Corners">
            <span className="layout-corners">
              <input
                type="range"
                aria-label="Corners"
                min={0}
                max={Math.floor(Math.min(c.w, c.h) / 2)}
                value={Math.round(cornerRadius(c))}
                onChange={(e) => set({ radius: Number(e.target.value) || undefined })}
              />
              <span className="mono small">{Math.round(cornerRadius(c))} px</span>
            </span>
          </Row>
        )}
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">Order</h3>
        <div className="button-row">
          <button onClick={() => onChange(bringToFront(panel, c.id))} disabled={panel.controls[panel.controls.length - 1]?.id === c.id}>
            Bring to front
          </button>
          <button onClick={() => onChange(sendToBack(panel, c.id))} disabled={panel.controls[0]?.id === c.id}>
            Send to back
          </button>
        </div>
        {(layered.over.length > 0 || layered.under.length > 0) && (
          <p className="muted small" data-overlap-line={c.id}>
            {layered.over.length > 0 && `On top of ${list(layered.over)}. `}
            {layered.under.length > 0 && `Under ${list(layered.under)}.`}
          </p>
        )}
      </section>

      <div className="button-row">
        <button onClick={onDuplicate} title="Ctrl+D">
          Duplicate
        </button>
        <button className="danger" onClick={onDelete} title={keyKind(page.buttons[c.id]) === 'empty' ? 'Delete' : `Delete — its key goes with it: ${describeAction(page.buttons[c.id])}`}>
          Delete…
        </button>
      </div>
    </aside>
  );
}

const ALIGN_LABELS: Record<Alignment, string> = { left: 'Align left edges', centre: 'Align centres', right: 'Align right edges', top: 'Align top edges', middle: 'Align middles', bottom: 'Align bottom edges' };

/**
 * The inspector with several controls selected (22c, 22d): the tools in place
 * of shape and order — align six ways against the selection's own bounds,
 * distribute across or down (three or more), match width or height to the
 * first one selected — then the selection's position, Duplicate and Delete.
 */
function SeveralInspector({ panel, selected, onChange, onDuplicate, onDelete }: { panel: PanelDef; selected: string[]; onChange: (panel: PanelDef) => void; onDuplicate: () => void; onDelete: () => void }) {
  const at = groupPosition(panel, selected) ?? { x: 0, y: 0 };
  const names = controlNames(panel);
  const first = names.get(selected[0]) ?? '';
  const apply = (next: PanelDef) => {
    if (next !== panel) onChange(next);
  };
  return (
    <aside className="inspector glass" aria-label="Inspector" data-layout-inspector="several">
      <h2 className="inspector-title">{selected.length} controls</h2>
      <p className="muted inspector-sub">Buttons</p>

      <section className="inspector-section">
        <h3 className="section-heading">Align</h3>
        <div className="layout-align" role="group" aria-label="Align">
          {ALIGNMENTS.map((a) => (
            <button key={a} className="layout-tool" title={ALIGN_LABELS[a]} aria-label={ALIGN_LABELS[a]} data-align={a} onClick={() => apply(align(panel, selected, a))}>
              <AlignGlyph how={a} />
            </button>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">Distribute</h3>
        <div className="button-row">
          <button disabled={selected.length < 3} title={selected.length < 3 ? 'Select three or more' : 'Equal gaps from left to right'} data-distribute="across" onClick={() => apply(distribute(panel, selected, 'across'))}>
            Across
          </button>
          <button disabled={selected.length < 3} title={selected.length < 3 ? 'Select three or more' : 'Equal gaps from top to bottom'} data-distribute="down" onClick={() => apply(distribute(panel, selected, 'down'))}>
            Down
          </button>
        </div>
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">Match</h3>
        <div className="button-row">
          <button title={`The width of ${first}, the first selected`} data-match="w" onClick={() => apply(match(panel, selected, 'w'))}>
            Width
          </button>
          <button title={`The height of ${first}, the first selected`} data-match="h" onClick={() => apply(match(panel, selected, 'h'))}>
            Height
          </button>
        </div>
        <p className="muted small">To {first}, the first selected.</p>
      </section>

      <section className="inspector-section">
        <h3 className="section-heading">Position</h3>
        <div className="layout-fields">
          <NumberField label="X" value={at.x} onSave={(x) => apply(moveGroupTo(panel, selected, { x }))} />
          <NumberField label="Y" value={at.y} onSave={(y) => apply(moveGroupTo(panel, selected, { y }))} />
        </div>
      </section>

      <div className="button-row">
        <button onClick={onDuplicate} title="Ctrl+D">
          Duplicate
        </button>
        <button className="danger" onClick={onDelete} title="Delete">
          Delete…
        </button>
      </div>
    </aside>
  );
}

/** A small drawing of each alignment: a line, and two bars set against it. */
function AlignGlyph({ how }: { how: Alignment }) {
  const vertical = how === 'left' || how === 'centre' || how === 'right';
  const line = how === 'left' || how === 'top' ? 2 : how === 'right' || how === 'bottom' ? 14 : 8;
  const bars = vertical
    ? [{ x: how === 'left' ? 3 : how === 'right' ? 13 - 9 : 8 - 4.5, y: 3, w: 9, h: 4 }, { x: how === 'left' ? 3 : how === 'right' ? 13 - 6 : 8 - 3, y: 9, w: 6, h: 4 }]
    : [{ x: 3, y: how === 'top' ? 3 : how === 'bottom' ? 13 - 9 : 8 - 4.5, w: 4, h: 9 }, { x: 9, y: how === 'top' ? 3 : how === 'bottom' ? 13 - 6 : 8 - 3, w: 4, h: 6 }];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {vertical ? <line x1={line} y1="1" x2={line} y2="15" stroke="currentColor" strokeWidth="1.4" /> : <line x1="1" y1={line} x2="15" y2={line} stroke="currentColor" strokeWidth="1.4" />}
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill="currentColor" opacity="0.7" />
      ))}
    </svg>
  );
}

/**
 * Grid and Snap at the foot of the canvas (22g): two separate switches, and
 * the grid's pitch in the shared dropdown, with Other… for any pitch. Holding
 * Shift while dragging ignores both.
 */
export function GuidesBar({ guides, onChange }: { guides: Guides; onChange: (next: Guides) => void }) {
  const listed = GRID_PITCHES.includes(guides.pitch);
  const [other, setOther] = useState(!listed);
  const [text, setText] = useState(String(guides.pitch));
  useEffect(() => setText(String(guides.pitch)), [guides.pitch]);
  const saveOther = () => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n >= MIN_PITCH && n <= MAX_PITCH) onChange({ ...guides, pitch: n });
    else setText(String(guides.pitch));
  };
  return (
    <div className="layout-guides glass" role="toolbar" aria-label="Grid and snapping" data-guides-bar="" title="Hold Shift while dragging to ignore the grid and snapping">
      <label className="layout-guides-item">
        Grid
        <Switch id="layout-grid" checked={guides.grid} onChange={(grid) => onChange({ ...guides, grid })} />
      </label>
      <Dropdown
        aria-label="Grid pitch"
        value={other ? 'other' : String(guides.pitch)}
        options={[...GRID_PITCHES.map((p) => ({ value: String(p), label: `${p} px` })), { value: 'other', label: 'Other…' }]}
        onChange={(v) => {
          if (v === 'other') setOther(true);
          else {
            setOther(false);
            onChange({ ...guides, pitch: Number(v) });
          }
        }}
      />
      {other && (
        <input
          className="sp-input layout-guides-pitch"
          type="number"
          min={MIN_PITCH}
          max={MAX_PITCH}
          aria-label="Grid pitch in pixels"
          value={text}
          data-guides-pitch=""
          onChange={(e) => setText(e.target.value)}
          onBlur={saveOther}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveOther();
            if (e.key === 'Escape') setText(String(guides.pitch));
          }}
        />
      )}
      <span className="layout-guides-sep" aria-hidden="true" />
      <label className="layout-guides-item">
        Snap
        <Switch id="layout-snap" checked={guides.snap} onChange={(snap) => onChange({ ...guides, snap })} />
      </label>
    </div>
  );
}

/** A whole number of canvas pixels: saved on Enter or leaving the field, put back on Escape. */
function NumberField({ label, value, onSave }: { label: string; value: number; onSave: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const save = () => {
    const n = Math.round(Number(text));
    if (text.trim() === '' || !Number.isFinite(n)) setText(String(value));
    else if (n !== value) onSave(n);
  };
  return (
    <label className="layout-field">
      <span className="layout-field-label">{label}</span>
      <input
        className="sp-input"
        type="number"
        aria-label={label}
        value={text}
        data-layout-field={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
    </label>
  );
}

/**
 * The mode bar (21a), in place of the toolbar's crumbs and page tabs: the
 * deck and its size, the profile and the page being edited, then Save as
 * template (21g). Discard changes and Done are on the deck's own header,
 * beside the lit Edit layout (Ryan, 2026-11-20), not here.
 */
export function ModeBar({ deck, size, profile, page, children }: { deck: string; size: string; profile: string; page: string; children?: ReactNode }) {
  return (
    <div className="mode-bar" data-mode-bar="">
      <span className="mode-bar-tag">Edit layout</span>
      <span className="mode-bar-where">
        <strong>{deck}</strong> <span className="muted">· {size}</span> <span className="crumb-sep">›</span> {profile} <span className="crumb-sep">›</span> <strong>{page}</strong>
      </span>
      <span className="toolbar-spacer" />
      {children}
    </div>
  );
}

/**
 * The Delete warning (23a): names every key lost with the controls. Empty
 * controls are deleted without asking (App.tsx); with several selected, it
 * asks once if any of them has a key.
 */
export function DeleteControl({ keys, count, onConfirm, onCancel }: { keys: Array<{ name: string; button: ButtonDef }>; count: number; onConfirm: () => void; onCancel: () => void }) {
  const one = count === 1;
  return (
    <div className="confirm-card glass" role="alertdialog" aria-label={one ? 'Delete this control' : `Delete ${count} controls`} data-delete-control="">
      <p>
        <strong>{one ? 'Delete this control?' : `Delete ${count} controls?`}</strong> {keys.length === 1 ? 'Its key goes with it:' : 'Their keys go with them:'}
      </p>
      <ul className="link-list">
        {keys.map(({ name, button }) => (
          <li key={name}>
            {button.label ? `${button.label.replace(/\n/g, ' ')} — ` : `${name} — `}
            {describeAction(button)}
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button onClick={onCancel}>Cancel</button>
        <button className="danger" onClick={onConfirm} data-delete-control-confirm="">
          {one ? 'Delete control' : `Delete ${count} controls`}
        </button>
      </div>
    </div>
  );
}

/** Discard changes (23c): the layout only, put back as the mode found it; deleted controls come back with their keys. */
export function DiscardChanges({ page, changes, onConfirm, onCancel }: { page: string; changes: { added: number; moved: number; deleted: number; reordered: boolean }; onConfirm: () => void; onCancel: () => void }) {
  const n = (count: number) => `${count} ${count === 1 ? 'control' : 'controls'}`;
  return (
    <div className="confirm-card glass" role="alertdialog" aria-label="Discard changes" data-discard-card="">
      <p>
        <strong>Discard changes to {page}?</strong> Every layout change made since you opened Edit layout is discarded.
      </p>
      <dl className="facts">
        {changes.added > 0 && (
          <>
            <dt>Added</dt>
            <dd>{n(changes.added)}, removed</dd>
          </>
        )}
        {(changes.moved > 0 || changes.reordered) && (
          <>
            <dt>Moved or resized</dt>
            <dd>{changes.moved > 0 ? `${n(changes.moved)}, put back` : 'their order, put back'}</dd>
          </>
        )}
        {changes.deleted > 0 && (
          <>
            <dt>Deleted</dt>
            <dd>
              {n(changes.deleted)}, {changes.deleted === 1 ? 'returns with its key' : 'return with their keys'}
            </dd>
          </>
        )}
      </dl>
      <div className="button-row">
        <button onClick={onCancel}>Keep editing</button>
        <button className="danger" onClick={onConfirm} data-discard-confirm="">
          Discard changes
        </button>
      </div>
    </div>
  );
}
