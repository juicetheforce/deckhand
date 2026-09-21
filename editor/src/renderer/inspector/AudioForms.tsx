import { pairIconFields, type PairIconField } from '../../shared/icons.js';
import { Checkbox, NumberSetting, PairIcons, Row, Segmented, TextSetting, actionOf, nextAction, type FormProps } from './controls.js';

/** The Audio forms that need no device: Volume, Mic mute and Mute output. The device pickers are in DeviceForms.tsx. */

export function VolumeForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('audio.volume', button);
  // The daemon's default is +5.
  const delta = typeof action?.delta === 'number' ? action.delta : 5;
  const step = Math.abs(delta);
  const up = delta >= 0;
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('audio.volume', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Volume</h3>
      <Segmented
        label="Volume"
        options={[
          { value: 'up', label: 'Louder' },
          { value: 'down', label: 'Quieter' },
        ]}
        value={up ? 'up' : 'down'}
        disabled={disabled}
        onChoose={(v) => write({ delta: v === 'up' ? step : -step })}
      />
      <Row name="By">
        <NumberSetting label="Volume step" value={step} min={1} max={100} disabled={disabled} onSave={(n) => write({ delta: up ? n : -n })} />
        <span className="form-value">%</span>
      </Row>
      <Checkbox label="Show the level on the key" checked={action?.showLevel === true} disabled={disabled} onChange={(on) => write({ showLevel: on ? true : undefined })} />
      <p className="muted small">Changes the default output.</p>
    </section>
  );
}

/** audio.micMute and audio.mute: the same settings; mic mute also turns the key red while muted. */
export function MuteForm({ type, at, button, disabled, run, onChooseIcon }: FormProps & { type: 'audio.micMute' | 'audio.mute'; onChooseIcon?: (field: PairIconField) => void }) {
  const action = actionOf(type, button);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction(type, button, patch) });
  const text = (field: 'labelMuted' | 'labelUnmuted') => (typeof action?.[field] === 'string' ? (action[field] as string) : '');
  return (
    <section className="inspector-section">
      <h3 className="section-heading">{type === 'audio.micMute' ? 'Mic mute' : 'Mute output'}</h3>
      <p className="muted small">
        {type === 'audio.micMute'
          ? 'Toggles the default input. The key shows whether it is muted, and turns red while it is.'
          : 'Toggles the default output. The key shows whether it is muted.'}
      </p>
      {onChooseIcon && <PairIcons fields={pairIconFields(button?.action ?? { type })} button={button} disabled={disabled} onChoose={onChooseIcon} />}
      <Row name="Muted label">
        <TextSetting label="Label while muted" value={text('labelMuted')} placeholder="The key's label" disabled={disabled} onSave={(v) => write({ labelMuted: v === '' ? undefined : v })} />
      </Row>
      <Row name="Unmuted label">
        <TextSetting label="Label while unmuted" value={text('labelUnmuted')} placeholder="The key's label" disabled={disabled} onSave={(v) => write({ labelUnmuted: v === '' ? undefined : v })} />
      </Row>
    </section>
  );
}
