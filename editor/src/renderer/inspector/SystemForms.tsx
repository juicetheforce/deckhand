import { Checkbox, NumberSetting, Row, Segmented, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The small System forms: Clock, Nothing and Brightness. Grouped
 * by the library section they sit in, since each is a few controls.
 */

/** clock: the time is the key's face, so the grid does not draw it. */
export function ClockForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('clock', button);
  const format = action?.format === 'HH:mm:ss' ? 'HH:mm:ss' : 'HH:mm';
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Clock</h3>
      <Row name="Shows">
        <Segmented
          label="Clock format"
          options={[
            { value: 'HH:mm', label: '14:05' },
            { value: 'HH:mm:ss', label: '14:05:09' },
          ]}
          value={format}
          disabled={disabled}
          // HH:mm is the daemon's default, so choosing it removes the setting.
          onChoose={(v) => void run({ kind: 'setAction', at, action: nextAction('clock', button, { format: v === 'HH:mm' ? undefined : v }) })}
        />
      </Row>
      <p className="muted small">The time is drawn on the deck; the grid here does not show it.</p>
    </section>
  );
}

/** noop: a deliberate spacer — no default icon either. */
export function NoopForm() {
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Nothing</h3>
      <p className="muted small">Does nothing when pressed, and draws no default icon: a spacer. It can still have a label or an icon of its own.</p>
    </section>
  );
}

type BrightnessMode = 'up' | 'down' | 'set';

/** brightness: nudge by a step, or set a level, on the deck the key is on. */
export function BrightnessForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('brightness', button);
  const value = typeof action?.value === 'number' ? action.value : null;
  const delta = typeof action?.delta === 'number' ? action.delta : null;
  const mode: BrightnessMode | null = value !== null ? 'set' : delta !== null ? (delta < 0 ? 'down' : 'up') : null;
  const step = Math.abs(delta ?? 10);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('brightness', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Brightness</h3>
      <Segmented<BrightnessMode>
        label="Brightness"
        options={[
          { value: 'up', label: 'Brighter' },
          { value: 'down', label: 'Dimmer' },
          { value: 'set', label: 'Set to' },
        ]}
        value={mode}
        disabled={disabled}
        onChoose={(m) => write(m === 'set' ? { value: value ?? 50, delta: undefined } : { delta: m === 'up' ? step : -step, value: undefined })}
      />
      {mode === null && <p className="muted small">Choose whether the key nudges this deck's brightness or sets it.</p>}
      {(mode === 'up' || mode === 'down') && (
        <Row name="By">
          <NumberSetting label="Brightness step" value={step} min={1} max={100} disabled={disabled} onSave={(n) => write({ delta: mode === 'up' ? n : -n })} />
          <span className="form-value">%</span>
        </Row>
      )}
      {mode === 'set' && (
        <Row name="Level">
          <NumberSetting label="Brightness level" value={value ?? 50} min={5} max={100} disabled={disabled} onSave={(n) => write({ value: n })} />
          <span className="form-value">%</span>
        </Row>
      )}
      {mode !== null && (
        <Checkbox label="Show the level on the key" checked={action?.showLevel === true} disabled={disabled} onChange={(on) => write({ showLevel: on ? true : undefined })} />
      )}
    </section>
  );
}
