import { useState } from 'react';
import { SoundPicker } from '../SoundPicker.js';
import { DeviceButton, type AudioLists } from './DeviceForms.js';
import type { PairIconField } from '../../shared/icons.js';
import { NumberSetting, Row, Segmented, StateIcons, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The soundboard's forms: Play sound and Stop all sounds (src/actions/sound.ts).
 * The output is picked from the daemon's list as Output device's is, stored
 * the same way (`node` and `label`); none chosen plays on the system default.
 */

type Mode = 'playStop' | 'playRestart' | 'playOverlap' | 'loopStop' | 'hold';

/** Elgato's names for the press behaviours, and what each does. */
const MODES: ReadonlyArray<{ value: Mode; label: string; says: string }> = [
  { value: 'playStop', label: 'Play/Stop', says: 'A press plays it; a press while it plays stops it.' },
  { value: 'playRestart', label: 'Play/Restart', says: 'A press while it plays starts it again from the beginning.' },
  { value: 'playOverlap', label: 'Play/Overlap', says: 'Every press plays it once more, over any still playing.' },
  { value: 'loopStop', label: 'Loop/Stop', says: 'A press plays it over and over; the next press stops it.' },
  { value: 'hold', label: 'Hold to play', says: 'Plays while the key is held, and stops when it is let go.' },
];

function modeOf(value: unknown): Mode {
  return MODES.some((m) => m.value === value) ? (value as Mode) : 'playStop';
}

export function SoundForm({ at, button, disabled, run, audio, inStep, onChooseIcon }: FormProps & { audio: AudioLists; inStep: boolean; onChooseIcon?: (field: PairIconField) => void }) {
  const action = actionOf('sound.play', button);
  const file = typeof action?.file === 'string' ? action.file : '';
  const node = typeof action?.node === 'string' && action.node !== '' ? action.node : null;
  const label = typeof action?.label === 'string' ? action.label : '';
  const volume = typeof action?.volume === 'number' ? action.volume : 100;
  const mode = modeOf(action?.mode);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('sound.play', button, patch) });
  const list = audio?.sinks;
  const listed = list?.devices ?? [];
  const nodeMissing = node !== null && list !== undefined && !listed.some((d) => d.node === node);
  // The picker is open until a file is chosen, and again from Change….
  const [browsing, setBrowsing] = useState(false);
  const picking = browsing || file === '';

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Play sound</h3>
      {file !== '' && (
        <Row name="File">
          <span className="form-value path" data-sound="file">
            {file}
          </span>
          {!browsing && (
            <button className="link-button" disabled={disabled} data-sound="change" onClick={() => setBrowsing(true)}>
              Change…
            </button>
          )}
        </Row>
      )}
      {picking && (
        <>
          <SoundPicker current={file === '' ? null : file} output={{ node: node ?? undefined, label: label || undefined, volume }} disabled={disabled} onChoose={(chosen) => write({ file: chosen })} />
          {file !== '' && (
            <button className="link-button" data-sound="done" onClick={() => setBrowsing(false)}>
              Done
            </button>
          )}
        </>
      )}
      <p className="muted small">WAV, MP3, Ogg or FLAC. ▶ plays one first. The key plays the file where it is, by its path; nothing is copied. A file gone from there marks the key when it is pressed.</p>

      <h4 className="form-subheading">Press</h4>
      <Segmented label="Press behaviour" options={MODES} value={mode} disabled={disabled} onChoose={(v) => write({ mode: v === 'playStop' ? undefined : v })} />
      <p className="muted small" data-sound="mode-says">
        {MODES.find((m) => m.value === mode)?.says}
        {inStep && mode === 'hold' ? ' In a Multi action there is no key to let go, so it plays to the end.' : ''}
      </p>

      <Row name="Volume">
        <NumberSetting label="Sound volume" value={volume} min={0} max={100} disabled={disabled} onSave={(n) => write({ volume: n === 100 ? undefined : n })} />
        <span className="form-value">%</span>
      </Row>

      <h4 className="form-subheading">Output</h4>
      {list === undefined ? (
        <p className="warning-text">The daemon has not listed the audio outputs yet. Is it running?</p>
      ) : (
        <ul className="target-list">
          <li>
            <button className={node === null ? 'target target-selected' : 'target'} disabled={disabled} data-node="" onClick={() => write({ node: undefined, label: undefined })}>
              <span className="target-name">System default</span>
              <span className="target-note">whichever output is the default when it plays</span>
            </button>
          </li>
          {nodeMissing && (
            <li>
              <DeviceButton device={{ node, label }} selected isDefault={false} missing disabled onClick={() => {}} />
            </li>
          )}
          {listed.map((d) => (
            <li key={d.node}>
              <DeviceButton device={d} selected={node === d.node} isDefault={list.default === d.node} missing={false} disabled={disabled} onClick={() => write({ node: d.node, label: d.label })} />
            </li>
          ))}
        </ul>
      )}
      {nodeMissing && <p className="warning-text">“{label || node}” is not present now. The key does nothing until it is back, or pick another.</p>}
      <p className="muted small">A virtual output you have made yourself is listed here too.</p>
      <StateIcons type="sound.play" button={button} disabled={disabled} onChooseIcon={onChooseIcon} />
    </section>
  );
}

export function StopAllSoundsForm() {
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Stop all sounds</h3>
      <p className="muted small">Stops every sound Deckhand is playing, on every deck, loops included.</p>
    </section>
  );
}
