import { useState, type ReactNode } from 'react';
import { iconUrl } from '../shared/icons.js';
import type { Dot } from './integration-status.js';

/**
 * The settings window's building blocks, as Claude Design's section 14 draws
 * them: a page title, groups (a small heading over a card), rows in a card
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
export function Banner({ kind, children, action, ...data }: { kind: 'ok' | 'error' | 'warn' | 'info'; children: ReactNode; action?: ReactNode } & Record<`data-${string}`, string | undefined>) {
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
export function IntegrationIcon({ icon, tint, size }: { icon: string; tint: 'obs' | 'vts' | 'twitch'; size: 'nav' | 'page' }) {
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
}: { icon: string; tint: 'obs' | 'vts' | 'twitch'; name: string; dot: Dot; status: string; children?: ReactNode } & Record<`data-${string}`, string | undefined>) {
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
