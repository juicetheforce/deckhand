import { useEffect, useRef, useState } from 'react';
import type { ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';

/** Saves when typing pauses, on Enter, and on leaving the field. An empty label removes it. */
export function LabelField({ label, disabled, onSave }: { label: string; disabled: boolean; onSave: (label: string) => void }) {
  const [text, setText] = useState(label);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  // A label changed elsewhere (a reload, an outside edit) shows here — but not
  // while typing, when the saved value is just this field's own autosave.
  useEffect(() => {
    if (!focused.current) setText(label);
  }, [label]);
  const save = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value !== label) onSave(value);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <input
      className="label-input"
      aria-label="Label"
      placeholder="No label"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const value = e.target.value;
        setText(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(value), 400);
      }}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        save(text);
      }}
      onKeyDown={(e) => e.key === 'Enter' && save(text)}
    />
  );
}

const POSITIONS: ReadonlyArray<{ value: 'top' | 'center' | 'bottom'; label: string }> = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom', label: 'Bottom' },
];

/**
 * Where the label sits, what colour it is and how big — all three already
 * supported by `src/render.ts` and the v0.1 schema; this is the UI that was
 * missing. A field the key does not set is shown as inherited from `defaults`
 * in config, and "Reset" removes it again rather than writing the default
 * value in, so the config diff stays small and a later change to `defaults`
 * still reaches the key.
 */
export function LabelStyle({
  at,
  button,
  defaults,
  disabled,
  run,
}: {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  defaults: { labelPosition: 'top' | 'bottom' | 'center'; labelColor: string; labelSize: number };
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const position = button?.labelPosition ?? defaults.labelPosition;
  const colour = button?.labelColor ?? defaults.labelColor;
  const size = button?.labelSize ?? defaults.labelSize;
  const set = (field: 'labelPosition' | 'labelColor' | 'labelSize', value: string | number | null) =>
    void run({ kind: 'setLabelStyle', at, field, value });
  const inherited = (field: 'labelPosition' | 'labelColor' | 'labelSize') => button?.[field] === undefined;

  return (
    <div className="label-style">
      <div className="label-style-row">
        <span className="label-style-name">Position</span>
        <div className="segmented" role="group" aria-label="Label position">
          {POSITIONS.map((p) => (
            <button
              key={p.value}
              className={p.value === position ? 'segment segment-selected' : 'segment'}
              disabled={disabled}
              aria-pressed={p.value === position}
              onClick={() => set('labelPosition', p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="label-style-row">
        <span className="label-style-name">Colour</span>
        <input
          type="color"
          aria-label="Label colour"
          className="colour-well"
          value={/^#[0-9a-fA-F]{6}$/.test(colour) ? colour : '#ffffff'}
          disabled={disabled}
          onChange={(e) => set('labelColor', e.target.value)}
        />
        <span className="label-style-value">{colour}</span>
      </div>

      <div className="label-style-row">
        <span className="label-style-name">Size</span>
        <input
          type="number"
          aria-label="Label size"
          className="size-input"
          min={6}
          max={72}
          value={size}
          disabled={disabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next > 0) set('labelSize', next);
          }}
        />
        <span className="label-style-value">px</span>
      </div>

      <div className="label-style-row">
        <button
          className="link-button"
          disabled={disabled || (inherited('labelPosition') && inherited('labelColor') && inherited('labelSize'))}
          title="Remove these from the key, so it follows the defaults in config.json again"
          onClick={() => {
            set('labelPosition', null);
            set('labelColor', null);
            set('labelSize', null);
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
