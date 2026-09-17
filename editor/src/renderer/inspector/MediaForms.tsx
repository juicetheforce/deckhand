import { pairIconFields, type PairIconField } from '../../shared/icons.js';
import { Checkbox, PairIcons, Row, Segmented, TextSetting, actionOf, nextAction, type FormProps } from './controls.js';

/** The Media forms (scope §6): Media control and Now playing. Both follow whichever player is playing. */

const METHODS = [
  { value: 'playpause', label: 'Play / pause' },
  { value: 'play', label: 'Play' },
  { value: 'pause', label: 'Pause' },
  { value: 'next', label: 'Next' },
  { value: 'previous', label: 'Previous' },
  { value: 'stop', label: 'Stop' },
] as const;

type Method = (typeof METHODS)[number]['value'];

export function MediaControlForm({ at, button, disabled, run, onChooseIcon }: FormProps & { onChooseIcon?: (field: PairIconField) => void }) {
  const action = actionOf('media.control', button);
  const raw = String(action?.method ?? 'playpause').toLowerCase();
  const method = (raw === 'prev' ? 'previous' : raw) as Method;
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Media control</h3>
      <Segmented<Method>
        label="Media control"
        options={METHODS}
        value={method}
        disabled={disabled}
        // playpause is the daemon's default, so choosing it removes the setting.
        onChoose={(m) => void run({ kind: 'setAction', at, action: nextAction('media.control', button, { method: m === 'playpause' ? undefined : m }) })}
      />
      <p className="muted small">Sent to whichever player is playing.</p>
      {/* Only play/pause has a pair; pairIconFields decides. A Multi step has no face, so no icons. */}
      {onChooseIcon && <PairIcons fields={pairIconFields(button?.action)} button={button} disabled={disabled} onChoose={onChooseIcon} />}
    </section>
  );
}

type Show = 'title+artist' | 'title' | 'artist';

export function MediaInfoForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('media.info', button);
  const show = (['title', 'artist'].includes(String(action?.show)) ? action?.show : 'title+artist') as Show;
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('media.info', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Now playing</h3>
      <Row name="Shows">
        <Segmented<Show>
          label="Now playing shows"
          options={[
            { value: 'title+artist', label: 'Title and artist' },
            { value: 'title', label: 'Title' },
            { value: 'artist', label: 'Artist' },
          ]}
          value={show}
          disabled={disabled}
          onChoose={(v) => write({ show: v === 'title+artist' ? undefined : v })}
        />
      </Row>
      <Checkbox label="Album art as the key's picture" checked={action?.showArt !== false} disabled={disabled} onChange={(on) => write({ showArt: on ? undefined : false })} />
      <Row name="Pressing">
        <Segmented
          label="Pressing it"
          options={[
            { value: 'toggle', label: 'Plays / pauses' },
            { value: 'none', label: 'Does nothing' },
          ]}
          value={action?.pressAction === 'none' ? 'none' : 'toggle'}
          disabled={disabled}
          onChoose={(v) => write({ pressAction: v === 'none' ? 'none' : undefined })}
        />
      </Row>
      <Row name="When idle">
        <TextSetting label="Label when nothing plays" value={typeof action?.idleLabel === 'string' ? action.idleLabel : ''} placeholder="No label" disabled={disabled} onSave={(v) => write({ idleLabel: v === '' ? undefined : v })} />
      </Row>
      <p className="muted small">The track is drawn on the deck; the grid shows the now-playing icon.</p>
    </section>
  );
}
