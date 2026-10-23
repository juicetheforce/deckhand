import { useEffect, useRef, useState } from 'react';
import { defaultIconFor, type IconState } from '../../../../src/default-icons.js';
import type { ActionDef, ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import { builtinName, KEY_STATES, keyStates, pairIconFields, type PairIconField } from '../../shared/icons.js';

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

/** A state icon's name in the inspector, for the key's action: "While muted", "On push-to-talk"… */
export function pairLabel(_field: PairIconField, type?: string): string {
  return (type !== undefined ? KEY_STATES[type]?.active : undefined) ?? 'Active state';
}

/** How a stored icon reads in the inspector: a built-in by name, a file by its path. */
export function iconText(icon: string): string {
  const name = builtinName(icon);
  return name === null ? icon : `Built-in: ${name}`;
}

/**
 * A key's two icons, as the form lists them (src/state-icons.ts): its
 * Default icon — its own, else the built-in for its default state — and its
 * active state's, else, as the daemon draws it, the default icon when that is
 * the person's own (no switching: their call), or the built-in for the state.
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
  /** Open the Icon tab on an icon: the default (null) or the active state's. */
  onChoose: (field: PairIconField | null) => void;
}) {
  const action = button?.action;
  const states = keyStates(action);
  if (fields.length === 0 || !states) return null;
  const own = typeof button?.icon === 'string' ? button.icon : null;
  const builtin = (state: IconState) => `built-in (${defaultIconFor(action, state) ?? 'none'})`;
  const active = typeof action?.iconActive === 'string' ? action.iconActive : null;
  const defaultText = own !== null ? iconText(own) : button?.icon === null ? 'none' : builtin(states.defaultState);
  const activeText = active !== null ? iconText(active) : own !== null ? `the default icon, unchanged (${iconText(own)})` : builtin(states.activeState);
  return (
    <div className="pair-icons">
      <Row name="Default icon">
        <span className="form-value" data-pair="default">
          {defaultText}
        </span>
        <button className="link-button" disabled={disabled} onClick={() => onChoose(null)}>
          Choose…
        </button>
      </Row>
      <Row name={states.active}>
        <span className="form-value" data-pair="iconActive">
          {activeText}
        </span>
        <button className="link-button" disabled={disabled} onClick={() => onChoose('iconActive')}>
          Choose…
        </button>
      </Row>
    </div>
  );
}

/**
 * A key with states: its Default icon and its active state's icon
 * (src/state-icons.ts), listed in its form; each "Choose…" opens the Icon tab on that state. Absent
 * for a Multi step, which has no face.
 */
export function StateIcons({ type, button, disabled, onChooseIcon }: { type: string; button: ButtonDef | undefined; disabled: boolean; onChooseIcon?: (field: PairIconField | null) => void }) {
  if (!onChooseIcon) return null;
  return <PairIcons fields={pairIconFields(button?.action ?? { type })} button={button} disabled={disabled} onChoose={onChooseIcon} />;
}
