import { useEffect, useRef, useState } from 'react';
import { defaultIconFor, type IconState } from '../../../../src/default-icons.js';
import type { ActionDef, ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import { builtinName, type PairIconField } from '../../shared/icons.js';

/** What every action form is given. */
export interface FormProps {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}

/**
 * The action a form writes: the key's action if it is already of this type,
 * else a new one (a library pick retargeting the key), with `patch`
 * applied. A patch value of `undefined` removes that setting, so a choice that
 * matches the daemon's default leaves nothing behind in config.json.
 */
export function nextAction(type: string, button: ButtonDef | undefined, patch: Record<string, unknown>): ActionDef {
  const current = button?.action?.type === type ? button.action : { type };
  const next: ActionDef = { ...current, type };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next;
}

/** The key's action if it is of this type, for reading its settings. */
export function actionOf(type: string, button: ButtonDef | undefined): ActionDef | undefined {
  return button?.action?.type === type ? button.action : undefined;
}

/** One row of a form: a name on the left, the control on the right. */
export function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <span className="form-name">{name}</span>
      {children}
    </div>
  );
}

/** A segmented choice; `value` null when nothing is chosen yet. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  disabled,
  onChoose,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  disabled: boolean;
  onChoose: (value: T) => void;
}) {
  return (
    <div className="segmented segmented-wrap" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'segment segment-selected' : 'segment'}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => o.value !== value && onChoose(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="form-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** A whole number within bounds. Saved as it is typed, when it is valid; an invalid entry is not saved. */
export function NumberSetting({
  label,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const valid = (n: number) => Number.isInteger(n) && n >= min && n <= max;
  return (
    <>
      <input
        type="number"
        aria-label={label}
        className="size-input"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && valid(n) && n !== value) onSave(n);
        }}
        onBlur={() => setText(String(value))}
      />
      {!valid(Number(text)) && <span className="field-error">{min}–{max}</span>}
    </>
  );
}

/** Text saved when typing pauses, on Enter, and on leaving the field; empty removes it. As the key's label field. */
export function TextSetting({ label, value, placeholder, disabled, onSave }: { label: string; value: string; placeholder: string; disabled: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const save = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (next !== value) onSave(next);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        const next = e.target.value;
        timer.current = setTimeout(() => save(next), 400);
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

const PAIR_LABELS: Record<PairIconField, string> = {
  iconMuted: 'While muted',
  iconUnmuted: 'While unmuted',
  iconPlaying: 'While playing',
  iconPaused: 'While paused',
  iconOn: 'While held down',
  iconOff: 'While up',
};

const PAIR_STATES: Record<PairIconField, IconState> = {
  iconMuted: { muted: true },
  iconUnmuted: { muted: false },
  iconPlaying: { playing: true },
  iconPaused: { playing: false },
  iconOn: { latched: true },
  iconOff: { latched: false },
};

export function pairLabel(field: PairIconField): string {
  return PAIR_LABELS[field];
}

/** How a stored icon reads in the inspector: a built-in by name, a file by its path. */
export function iconText(icon: string): string {
  const name = builtinName(icon);
  return name === null ? icon : `Built-in: ${name}`;
}

/**
 * The icon each state shows, in the daemon's order (src/deck.ts): the state's
 * own icon, else the key's own icon, else the built-in default. Said per state
 * because the middle case surprises — a key with its own icon stops swapping.
 */
export function PairIcons({
  fields,
  button,
  disabled,
  onChoose,
}: {
  fields: readonly PairIconField[];
  button: ButtonDef | undefined;
  disabled: boolean;
  onChoose: (field: PairIconField) => void;
}) {
  if (fields.length === 0) return null;
  const action = button?.action;
  const own = typeof button?.icon === 'string' ? button.icon : null;
  return (
    <div className="pair-icons">
      {fields.map((field) => {
        const set = typeof action?.[field] === 'string' ? (action[field] as string) : null;
        const fallback = own !== null ? `the key's own icon (${iconText(own)})` : `default (${defaultIconFor(action, PAIR_STATES[field]) ?? 'none'})`;
        return (
          <Row key={field} name={pairLabel(field)}>
            <span className="form-value" data-pair={field}>
              {set !== null ? iconText(set) : fallback}
            </span>
            <button className="link-button" disabled={disabled} onClick={() => onChoose(field)}>
              Choose…
            </button>
          </Row>
        );
      })}
      {own !== null && fields.some((f) => typeof action?.[f] !== 'string') && (
        <p className="muted small">The key has its own icon, so a state with no icon of its own shows that instead of swapping.</p>
      )}
    </div>
  );
}
