import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TemplateDef } from '../../../src/types.js';
import { cornerRadius, shapeName } from '../../../src/shapes.js';
import { fitScale, madeForAnother } from '../shared/templates.js';

/**
 * Templates in the main window (scope §7, round 2b; boards 20a–20g, 21g,
 * 24c): their rows in New page's picker, Save as template in the mode bar,
 * and the chip saying a layout was made for another screen size.
 */

/** The hexagon's corners as a clip-path, point-up (DeckGrid's, at preview size). */
const HEXAGON = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

/**
 * A template drawn small at this screen's proportions (20g: "controls drawn
 * plain"): its layout scaled to fit, centred, as the deck would show it.
 */
export function TemplatePreview({ panel, screen }: { panel: TemplateDef['panel']; screen: { width: number; height: number } }) {
  const scale = fitScale(panel.size, screen);
  const ox = (screen.width - panel.size.width * scale) / 2;
  const oy = (screen.height - panel.size.height * scale) / 2;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <span className="template-preview" style={{ aspectRatio: `${screen.width} / ${screen.height}` }} aria-hidden="true">
      {panel.controls.map((c) => {
        const shape = shapeName(c.shape);
        const r = cornerRadius(c);
        const style: CSSProperties = {
          left: pct(ox + c.x * scale, screen.width),
          top: pct(oy + c.y * scale, screen.height),
          width: pct(c.w * scale, screen.width),
          height: pct(c.h * scale, screen.height),
          borderRadius: shape === 'round' ? '50%' : shape === 'rectangle' && r > 0 ? `${(r / c.w) * 100}% / ${(r / c.h) * 100}%` : undefined,
          clipPath: shape === 'hexagon' ? HEXAGON : undefined,
        };
        return <span key={c.id} className="template-preview-control" style={style} />;
      })}
    </span>
  );
}

/**
 * The picker's templates (20a, 20f, 20g): newest first, after Blank, in the
 * same radio group. Each shows its preview, its name, and its number of
 * controls — or "Made for W × H" when saved on a screen of another size — and
 * a … menu with Rename (in place: Enter saves, Esc cancels) and Delete…
 * (asks once; pages made from it are not changed).
 */
export function TemplateRows({
  group,
  templates,
  screen,
  chosen,
  onChoose,
  onRename,
  onDelete,
}: {
  group: string;
  templates: TemplateDef[];
  screen: { width: number; height: number };
  chosen: string | null;
  onChoose: (name: string) => void;
  onRename: (name: string, to: string) => Promise<string | null>;
  onDelete: (name: string) => Promise<string | null>;
}) {
  return (
    <div className="vd-templates" data-templates="">
      <span className="vd-templates-heading">Templates</span>
      {templates.length === 0 ? (
        <span className="muted small" data-no-templates="">
          None yet. Save one from Edit layout.
        </span>
      ) : (
        templates.map((t) => <TemplateRow key={t.name} group={group} template={t} screen={screen} chosen={chosen !== null && chosen === t.name} onChoose={() => onChoose(t.name)} onRename={(to) => onRename(t.name, to)} onDelete={() => onDelete(t.name)} />)
      )}
    </div>
  );
}

function TemplateRow({
  group,
  template,
  screen,
  chosen,
  onChoose,
  onRename,
  onDelete,
}: {
  group: string;
  template: TemplateDef;
  screen: { width: number; height: number };
  chosen: boolean;
  onChoose: () => void;
  onRename: (to: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [menu]);
  const { width, height } = template.panel.size;
  const sub = madeForAnother(template.panel.size, screen) ? `Made for ${width} × ${height}` : `${template.panel.controls.length} ${template.panel.controls.length === 1 ? 'control' : 'controls'}`;
  const rename = async () => {
    if (renaming === null) return;
    if (renaming.trim() === template.name) {
      setRenaming(null);
      return;
    }
    const failure = await onRename(renaming);
    if (failure === null) {
      setRenaming(null);
      setError(null);
    } else setError(failure);
  };
  return (
    <div className="vd-template" ref={wrap} data-template={template.name}>
      <label className="vd-size vd-template-choice">
        <input type="radio" name={group} checked={chosen} onChange={onChoose} />
        <TemplatePreview panel={template.panel} screen={screen} />
        {renaming === null ? (
          <span className="vd-size-name">{template.name}</span>
        ) : (
          <input
            className="sp-input vd-template-rename"
            autoFocus
            aria-label="Template name"
            value={renaming}
            maxLength={64}
            data-template-rename=""
            onClick={(e) => e.preventDefault()}
            onChange={(e) => {
              setRenaming(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void rename();
              if (e.key === 'Escape') {
                setRenaming(null);
                setError(null);
              }
            }}
          />
        )}
        <span className="muted small">{sub}</span>
      </label>
      <button className="vd-template-more" aria-label={`More for ${template.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)} data-template-more="">
        …
      </button>
      {menu && (
        <ul className="tab-menu vd-template-menu" role="menu">
          <li>
            <button
              role="menuitem"
              className="tab-menu-item"
              onClick={() => {
                setMenu(false);
                setRenaming(template.name);
              }}
            >
              Rename
            </button>
          </li>
          <li>
            <button
              role="menuitem"
              className="tab-menu-item danger"
              onClick={() => {
                setMenu(false);
                setDeleting(true);
              }}
            >
              Delete…
            </button>
          </li>
        </ul>
      )}
      {deleting && (
        <div className="vd-template-delete" role="alertdialog" aria-label={`Delete ${template.name}`} data-template-delete="">
          <span>
            Delete <strong>{template.name}</strong>? Pages made from it are not changed.
          </span>
          <span className="button-row">
            <button onClick={() => setDeleting(false)}>Cancel</button>
            <button
              className="danger"
              data-template-delete-confirm=""
              onClick={async () => {
                const failure = await onDelete();
                if (failure === null) setDeleting(false);
                else setError(failure);
              }}
            >
              Delete
            </button>
          </span>
        </div>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/**
 * Save as template, in the mode bar (21g): asks only for a name. A name in use
 * offers to replace that template (decided 2026-11-17). Saved, the button says
 * so for a moment and the mode stays open; Discard changes does not undo it.
 * Dimmed while the page has no controls.
 */
export function SaveAsTemplate({ hasControls, existing, onSave }: { hasControls: boolean; existing: (name: string) => string | null; onSave: (name: string, replace: boolean) => Promise<string | null> }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [clash, setClash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // "Saved" for a moment: a one-shot timer in the window, cleared if the bar goes.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);
  const close = () => {
    setNaming(false);
    setName('');
    setClash(null);
    setError(null);
  };
  const save = async (replace: boolean) => {
    if (name.trim() === '') return;
    const inUse = existing(name);
    if (inUse !== null && !replace) {
      setClash(inUse);
      return;
    }
    const failure = await onSave(name, replace);
    if (failure !== null) {
      setError(failure);
      return;
    }
    close();
    setSaved(true);
  };
  if (!naming) {
    return (
      <button className="mode-bar-template" disabled={!hasControls} title={hasControls ? 'Save this layout to start other pages from' : 'Add a control first'} onClick={() => setNaming(true)} data-save-template={saved ? 'saved' : ''}>
        {saved ? 'Saved' : 'Save as template'}
      </button>
    );
  }
  return (
    <span className="mode-bar-template-form" data-save-template-form="">
      <label className="mode-bar-template-field">
        <span className="muted">Template name</span>
        <input
          className="sp-input"
          autoFocus
          maxLength={64}
          value={name}
          aria-label="Template name"
          data-template-name=""
          onChange={(e) => {
            setName(e.target.value);
            setClash(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void save(clash !== null);
            if (e.key === 'Escape') close();
          }}
        />
      </label>
      {clash !== null && (
        <span className="mode-bar-template-clash" data-template-clash="">
          There is already a template called {clash}.
        </span>
      )}
      {error && <span className="field-error">{error}</span>}
      <button onClick={close}>Cancel</button>
      <button className="mode-bar-template-save" disabled={name.trim() === ''} onClick={() => void save(clash !== null)} data-template-save="">
        {clash !== null ? 'Replace it' : 'Save'}
      </button>
    </span>
  );
}

/** 24c: the chip at the canvas's top-left when a layout was made for another screen size. */
export function MadeForChip({ layout, screen }: { layout: { width: number; height: number }; screen: { width: number; height: number } }) {
  const percent = Math.round(fitScale(layout, screen) * 100);
  return (
    <div className="made-for glass" data-made-for={`${layout.width}x${layout.height}`}>
      Made for <b>{`${layout.width} × ${layout.height}`}</b>
      <span className="muted">shown at {percent}%, centred</span>
    </div>
  );
}
