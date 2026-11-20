import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { geometryOfPanel } from '../../../src/geometry.js';
import type { ScreenSize } from '../../../src/panel-presets.js';
import { cornerRadius, shapeName, SHAPE_NAMES, type ShapeName } from '../../../src/shapes.js';
import type { ButtonDef, Config, PageDef, PanelControlDef, PanelDef } from '../../../src/types.js';
import { bringToFront, clampBox, controlNames, HANDLES, overlaps, resizeBox, sendToBack, setShape, typedSize, verySmallMm, withControl, type Handle } from '../shared/layout-edit.js';
import { describeAction, keyKind, type AppIcons } from './model.js';
import { Key, placeOf } from './DeckGrid.js';
import { Checkbox, Row, Segmented } from './inspector/controls.js';

/**
 * Edit layout mode (scope §7, round 2a; boards 21–23): the page's controls
 * moved, resized and reshaped on the canvas, a control added from the
 * Controls palette, and the layout inspector. **Only layout**: nothing here
 * changes an action, an icon or a label. Everything is in the panel's canvas
 * pixels. App.tsx owns the mode and saves; this draws it.
 */

/** A drag in progress: the box as it was picked up, and the pointer then. */
interface Drag {
  id: string;
  /** null: the control itself moves; a handle: that edge or corner. */
  handle: Handle | null;
  pointer: number;
  from: { x: number; y: number; w: number; h: number };
  start: { x: number; y: number };
  /** Screen pixels per canvas pixel when it began (the canvas's zoom included). */
  scale: number;
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
  selected,
  iconStamps,
  appIcons,
  onSelect,
  onChange,
}: {
  config: Config;
  serial: string;
  /** The layout as the mode holds it: empty while a Blank page has no control yet. */
  panel: PanelDef;
  page: PageDef;
  /** The room in the deck's frame, in pixels at 100%. */
  box: { width: number; height: number };
  selected: string | null;
  iconStamps: Record<string, string>;
  appIcons: AppIcons;
  onSelect: (id: string | null) => void;
  /** A change made: saved by App as it is made (a drag on its release). */
  onChange: (panel: PanelDef) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  // While a drag is in progress, the layout as drawn: saved when it ends. The
  // ref is what the release reads: a release can come before React has drawn
  // the last move, and the state it closed over would be a move behind.
  const [live, setLiveState] = useState<PanelDef | null>(null);
  const liveRef = useRef<PanelDef | null>(null);
  const setLive = (next: PanelDef | null) => {
    liveRef.current = next;
    setLiveState(next);
  };
  const shown = live ?? panel;
  const size = shown.size;
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const style: CSSProperties = { width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) };
  const geometry = geometryOfPanel(shown, '');
  const names = controlNames(shown);
  const layered = overlaps(shown);
  const control = (id: string | null) => (id === null ? undefined : shown.controls.find((c) => c.id === id));

  const begin = (id: string, handle: Handle | null) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = control(id);
    const el = surface.current;
    if (!c || !el) return;
    onSelect(id);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (the checks) has nothing to capture.
    }
    dragRef.current = { id, handle, pointer: e.pointerId, from: { x: c.x, y: c.y, w: c.w, h: c.h }, start: { x: e.clientX, y: e.clientY }, scale: el.getBoundingClientRect().width / size.width, moved: false };
  };

  const move = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const sx = e.clientX - drag.start.x;
    const sy = e.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(sx, sy) < DRAG_START_PX) return;
    drag.moved = true;
    const dx = sx / drag.scale;
    const dy = sy / drag.scale;
    const c = control(drag.id) ?? panel.controls.find((k) => k.id === drag.id);
    if (!c) return;
    const next = drag.handle === null ? clampBox({ ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy }, size) : resizeBox(drag.from, drag.handle, dx, dy, size, !!c.keepRatio);
    setLive(withControl(panel, drag.id, next));
  };

  const end = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    dragRef.current = null;
    const result = liveRef.current;
    setLive(null);
    if (drag.moved && result) onChange(result);
  };

  // A new layout from App (saved, or a change elsewhere) ends any drag's picture.
  useEffect(() => {
    if (!dragRef.current) setLive(null);
  }, [panel]);

  const dragging = dragRef.current?.moved ? control(dragRef.current.id) : undefined;

  return (
    <div
      ref={surface}
      className="layout-canvas"
      style={style}
      data-layout-box={serial}
      data-layout-size={`${size.width}x${size.height}`}
      onPointerDown={(e) => {
        // Empty canvas: nothing selected.
        if (e.button === 0 && e.target === e.currentTarget) onSelect(null);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => {
        dragRef.current = null;
        setLive(null);
      }}
    >
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
            selected={k.id === selected}
            onClick={() => {}}
            onMenu={() => {}}
            onPointerDown={(_occupied, e) => begin(k.id, null)(e)}
            dragging={false}
            dropTarget={false}
          />
        );
      })}
      {/* Above every control: the marker, the selected one's frame and its handles. */}
      <div className="layout-overlay">
        {shown.controls.map((c) => {
          const over = layered.get(c.id)?.under ?? [];
          if (over.length === 0) return null;
          return (
            <span
              key={c.id}
              className="layout-overlap-marker"
              style={{ left: `${((c.x + c.w) / size.width) * 100}%`, top: `${((c.y + c.h) / size.height) * 100}%` }}
              title={`${names.get(c.id)} has ${over.map((id) => names.get(id)).join(' and ')} on top of it`}
              data-overlapped={c.id}
            />
          );
        })}
        {control(selected) && <Selection c={control(selected)!} size={size} onHandle={(h) => begin(selected!, h)} />}
        {dragging && (
          <span className="layout-readout" style={{ left: `${((dragging.x + dragging.w) / size.width) * 100}%`, top: `${(dragging.y / size.height) * 100}%` }}>
            {dragRef.current?.handle === null ? `${dragging.x}, ${dragging.y}` : `${dragging.w} × ${dragging.h}`}
          </span>
        )}
      </div>
      {shown.controls.length === 0 && <p className="layout-empty muted">Drag a control here</p>}
    </div>
  );
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

/**
 * The library pane in Edit layout: the Controls palette (21a). Button only in
 * this round; Slider and Dial come with round 5. A control is dragged onto the
 * panel; a click adds it in the middle — Claude's call, so it can be added
 * without a drag.
 */
export function ControlsPalette({ onDrop, onAdd }: { onDrop: (clientX: number, clientY: number) => void; onAdd: () => void }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ pointer: number; x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointer !== e.pointerId) return;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
      p.moved = true;
      setDrag({ x: e.clientX, y: e.clientY });
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointer !== e.pointerId) return;
      press.current = null;
      setDrag(null);
      if (p.moved) onDrop(e.clientX, e.clientY);
      else onAdd();
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
        <li>
          <button
            className="palette-entry"
            data-palette="button"
            title="Drag onto the panel, or click to add one in the middle"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              press.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
            }}
          >
            <span className="palette-glyph" aria-hidden="true" />
            Button
          </button>
        </li>
      </ul>
      {drag &&
        createPortal(
          <div className="action-drag" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
            Button
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
  selected: string | null;
  screen: ScreenSize | null;
  onChange: (panel: PanelDef) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const c = selected === null ? undefined : panel.controls.find((k) => k.id === selected);
  const size = `${panel.size.width} × ${panel.size.height}`;
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
  return (
    <aside className="inspector glass" aria-label="Inspector" data-layout-inspector={c.id}>
      <h2 className="inspector-title">Button</h2>
      <p className="muted inspector-sub">{names.get(c.id)}</p>

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
        <h3 className="section-heading">Shape</h3>
        <Segmented
          label="Shape"
          options={SHAPE_NAMES.map((s) => ({ value: s, label: SHAPE_LABELS[s] }))}
          value={shape}
          disabled={false}
          onChoose={(s) => onChange(setShape(panel, c.id, s))}
        />
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
 * deck and its size, the profile and the page being edited. Discard changes
 * and Done are on the deck's own header, beside the lit Edit layout (Ryan,
 * 2026-11-20), not here.
 */
export function ModeBar({ deck, size, profile, page }: { deck: string; size: string; profile: string; page: string }) {
  return (
    <div className="mode-bar" data-mode-bar="">
      <span className="mode-bar-tag">Edit layout</span>
      <span className="mode-bar-where">
        <strong>{deck}</strong> <span className="muted">· {size}</span> <span className="crumb-sep">›</span> {profile} <span className="crumb-sep">›</span> <strong>{page}</strong>
      </span>
      <span className="toolbar-spacer" />
    </div>
  );
}

/** The Delete warning (23a): names the key lost with the control. An empty control is deleted without asking (App.tsx). */
export function DeleteControl({ name, button, onConfirm, onCancel }: { name: string; button: ButtonDef; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="confirm-card glass" role="alertdialog" aria-label="Delete this control" data-delete-control="">
      <p>
        <strong>Delete this control?</strong> Its key goes with it:
      </p>
      <ul className="link-list">
        <li>
          {button.label ? `${button.label.replace(/\n/g, ' ')} — ` : `${name} — `}
          {describeAction(button)}
        </li>
      </ul>
      <div className="button-row">
        <button onClick={onCancel}>Cancel</button>
        <button className="danger" onClick={onConfirm} data-delete-control-confirm="">
          Delete control
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
