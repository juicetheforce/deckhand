import { useEffect, useRef, useState, type ReactNode } from 'react';
import { iconUrl } from '../shared/icons.js';
import type { Dot } from './integration-status.js';

/**
 * The settings window's building blocks, as the design mockups draw them: a page title, groups (a small heading over a card), rows in a card
 * with dividers between, switches, status dots, banners and disclosures.
 * Layout only — every behaviour stays in the page that uses them.
 */

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="sp-title">{children}</h1>;
}

/** A small heading over a card. `extra` sits at the heading's right: an info tip, a link. */
export function Group({ heading, extra, children, ...data }: { heading?: string; extra?: ReactNode; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className="sp-group" {...data}>
      {(heading || extra) && (
        <div className="sp-group-head">
          {heading && <span className="sp-group-heading">{heading.toUpperCase()}</span>}
          <span className="sp-spacer" />
          {extra}
        </div>
      )}
      <div className="sp-card">{children}</div>
    </section>
  );
}

/** One row of a card: a title and its detail on the left, a control on the right. */
export function Row({ title, detail, htmlFor, children }: { title: ReactNode; detail?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="sp-row">
      <div className="sp-row-text">
        {htmlFor ? (
          <label className="sp-row-title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <span className="sp-row-title">{title}</span>
        )}
        {detail && <span className="sp-row-detail">{detail}</span>}
      </div>
      {children}
    </div>
  );
}

export function Divider() {
  return <div className="sp-divider" />;
}

/** An on/off switch: a checkbox underneath, so it is a checkbox to keyboards, screen readers and the checks. */
export function Switch({ id, checked, disabled, onChange }: { id: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="sp-switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="sp-switch-track" aria-hidden="true" />
    </span>
  );
}

export function StatusDot({ dot }: { dot: Dot }) {
  return <span className={`sp-dot sp-dot-${dot}`} data-dot={dot} aria-hidden="true" />;
}

/** A line across the page that says how something went. */
export function Banner({ kind, children, action, ...data }: { kind: 'ok' | 'error' | 'warn' | 'info' | 'discord'; children: ReactNode; action?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={`sp-banner sp-banner-${kind}`} role="status" {...data}>
      <span className={`sp-dot sp-dot-banner-${kind}`} aria-hidden="true" />
      <span className="sp-banner-text">{children}</span>
      {action}
    </div>
  );
}

/** The ⓘ beside a heading or a field: its text is the tooltip, and what a screen reader reads. */
export function InfoTip({ text, ...data }: { text: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <span className="sp-info" title={text} aria-label={text} role="img" {...data}>
      i
    </span>
  );
}

/** A link-styled button. */
export function LinkButton({ children, title, onClick, disabled, ...data }: { children: ReactNode; title?: string; onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <button className="sp-link" title={title} disabled={disabled} onClick={onClick} {...data}>
      {children}
    </button>
  );
}

/** A disclosure: a ▸ line that opens a box of text. Open at first when `initiallyOpen`; the person decides after. */
export function Disclosure({ summary, initiallyOpen, children }: { summary: string; initiallyOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="sp-disclosure" data-open={open}>
      <button className="sp-disclosure-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sp-disclosure-mark" aria-hidden="true">
          ▶
        </span>
        {summary}
      </button>
      {open && <div className="sp-disclosure-body">{children}</div>}
    </div>
  );
}

/** An integration's built-in icon, on its tinted tile: the sidebar's and the page header's. */
export function IntegrationIcon({ icon, tint, size }: { icon: string; tint: 'obs' | 'vts' | 'twitch' | 'discord'; size: 'nav' | 'page' }) {
  return (
    <span className={`sp-tile sp-tile-${tint} sp-tile-${size}`} aria-hidden="true">
      <img src={iconUrl(`builtin:${icon}`)} alt="" />
    </span>
  );
}

/** An integration page's header: its icon, name and status line, and its buttons at the right. */
export function IntegrationHeader({
  icon,
  tint,
  name,
  dot,
  status,
  children,
  ...data
}: { icon: string; tint: 'obs' | 'vts' | 'twitch' | 'discord'; name: string; dot: Dot; status: string; children?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="sp-int-head">
      <IntegrationIcon icon={icon} tint={tint} size="page" />
      <div className="sp-int-name">
        <h1 className="sp-title">{name}</h1>
        <span className={`sp-int-status${dot === 'failed' ? ' sp-int-status-failed' : ''}`} {...data}>
          <StatusDot dot={dot} />
          {status}
        </span>
      </div>
      {children && <div className="sp-int-actions">{children}</div>}
    </div>
  );
}

/**
 * **The settings slider — the pattern for every slider in Settings** (Claude
 * Design's 16b; scope §10): on the right of a row, like a switch, the label
 * and sub-line staying on the left. A fixed 168 px track, 4 px tall, filled in
 * the accent from the minimum to the thumb; a 16 px white thumb, no value
 * bubble; the value always shown to its right, in mono with its unit, at a
 * fixed width so the row never shifts. It snaps to the step while dragging,
 * never between, with tick marks only for 12 steps or fewer. ← → or ↓ ↑ one
 * step, Page Up / Down two, Home / End the ends.
 *
 * **`onPreview` follows every move; `onCommit` only the release** — the end
 * of a drag, or a key let go — which is when the value is saved, as every
 * other change is: no Apply button. A visual setting may show a live sample
 * (`children`) right of the value. Reset is the footer's Reset to defaults;
 * no slider has one of its own.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onPreview,
  onCommit,
  children,
}: {
  /** Its accessible name: the row's title. */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
  onPreview?: (value: number) => void;
  onCommit: (value: number) => void;
  /** A live sample, right of the value. */
  children?: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  /** What the slider shows while it is being moved; null when it shows `value`. */
  const [moving, setMoving] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const shown = moving ?? value;
  const snap = (v: number) => Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
  const steps = Math.round((max - min) / step);
  const at = ((shown - min) / (max - min)) * 100;

  const move = (v: number) => {
    const next = snap(v);
    if (next === shown) return;
    setMoving(next);
    onPreview?.(next);
  };
  const fromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    move(min + ((clientX - rect.left) / rect.width) * (max - min));
  };
  const release = () => {
    setDragging(false);
    // Saved: it goes on showing what was chosen until the saved value comes back.
    if (moving !== null && moving !== value) onCommit(moving);
    else setMoving(null);
  };
  useEffect(() => setMoving(null), [value]);

  return (
    <div className="sp-slider-row">
      <div
        ref={track}
        className={`sp-slider${dragging ? ' sp-slider-dragging' : ''}${disabled ? ' sp-slider-disabled' : ''}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={`${shown}${unit}`}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // a synthetic pointer (the checks) has none to capture
          }
          setDragging(true);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging && fromPointer(e.clientX)}
        onPointerUp={() => dragging && release()}
        onPointerCancel={() => dragging && release()}
        onKeyDown={(e) => {
          if (disabled) return;
          const by: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 2 * step, PageDown: -2 * step };
          if (e.key in by) move(shown + by[e.key]);
          else if (e.key === 'Home') move(min);
          else if (e.key === 'End') move(max);
          else return;
          e.preventDefault();
        }}
        // Saved when the key is let go: a held arrow key is one change, not one per repeat.
        onKeyUp={() => !dragging && release()}
        onBlur={() => !dragging && release()}
      >
        <span className="sp-slider-track" />
        {steps <= 12 &&
          Array.from({ length: steps + 1 }, (_, i) => <span key={i} className="sp-slider-tick" style={{ left: `${(i / steps) * 100}%` }} />)}
        <span className="sp-slider-fill" style={{ width: `${at}%` }} />
        <span className="sp-slider-thumb" style={{ left: `${at}%` }} />
      </div>
      <span className="sp-slider-value">
        {shown}
        {unit}
      </span>
      {children}
    </div>
  );
}
