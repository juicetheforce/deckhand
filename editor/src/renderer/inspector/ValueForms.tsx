import { useState } from 'react';
import { Dropdown } from '../Dropdown.js';
import { actionName } from '../catalogue.js';
import { actionOf, nextAction, type FormProps } from './controls.js';
import type { AudioLists } from './DeviceForms.js';
import { IdPicker, Needs, useDiscordList } from './DiscordForms.js';

/**
 * A slider's or dial's action (round 5, src/value-controls.ts): the three
 * that carry a value, each choosing only *what* it sets — the level is the
 * finger's. A button's forms (a step, a level, show the level) are not here:
 * a slider has no step, and shows its level by itself.
 */
export function ValueActionForm({ type, ...props }: FormProps & { type: string; audio: AudioLists; decks: ReadonlyArray<{ id: string; label: string }> }) {
  if (type === 'audio.volume') return <VolumeDeviceForm {...props} />;
  if (type === 'brightness') return <BrightnessTargetForm {...props} />;
  if (type === 'discord.userVolume') return <UserVolumePersonForm {...props} />;
  return null;
}

const DEFAULT_OUTPUT = '';
const DEFAULT_INPUT = 'in:';

/**
 * Volume: which device — Default output or Default input (whichever is the
 * default, following it), or any local output or input, as the daemon lists
 * them (Ryan, 2026-11-18, answer 5; Default input 2026-11-22). Stored as the
 * node and its label, `input` for an input; Default output stores nothing,
 * Default input only `input`.
 */
function VolumeDeviceForm({ at, button, disabled, run, audio }: FormProps & { audio: AudioLists }) {
  const action = actionOf('audio.volume', button);
  const node = typeof action?.node === 'string' ? action.node : DEFAULT_OUTPUT;
  const input = action?.input === true;
  const stored = node === DEFAULT_OUTPUT ? (input ? DEFAULT_INPUT : DEFAULT_OUTPUT) : `${input ? 'in' : 'out'}:${node}`;
  const outputs = audio?.sinks.devices ?? [];
  const inputs = audio?.sources.devices ?? [];
  const listed = node === DEFAULT_OUTPUT || (input ? inputs : outputs).some((d) => d.node === node);
  const label = typeof action?.label === 'string' && action.label !== '' ? action.label : node;
  const options = [
    { value: DEFAULT_OUTPUT, label: 'Default output', note: 'follows the default' },
    { value: DEFAULT_INPUT, label: 'Default input', note: 'follows the default' },
    ...outputs.map((d) => ({ value: `out:${d.node}`, label: d.label, note: d.available === 'no' ? 'output · unplugged' : 'output' })),
    ...inputs.map((d) => ({ value: `in:${d.node}`, label: d.label, note: d.available === 'no' ? 'input · unplugged' : 'input' })),
    ...(listed ? [] : [{ value: stored, label, note: 'not connected' }]),
  ];
  const choose = (value: string) => {
    if (value === DEFAULT_OUTPUT || value === DEFAULT_INPUT) {
      return void run({ kind: 'setAction', at, action: nextAction('audio.volume', button, { node: undefined, label: undefined, input: value === DEFAULT_INPUT ? true : undefined, delta: undefined, showLevel: undefined }) });
    }
    const isInput = value.startsWith('in:');
    const chosen = value.slice(value.indexOf(':') + 1);
    const device = (isInput ? inputs : outputs).find((d) => d.node === chosen);
    void run({ kind: 'setAction', at, action: nextAction('audio.volume', button, { node: chosen, label: device?.label ?? chosen, input: isInput ? true : undefined, delta: undefined, showLevel: undefined }) });
  };
  return (
    <section className="inspector-section" data-value-form="audio.volume">
      <h3 className="section-heading">{actionName('audio.volume')}</h3>
      <p className="muted small">Sets a level: the device's volume, from 0 to 100 %.</p>
      <div className="form-row">
        <span className="form-name">Device</span>
        <Dropdown aria-label="Device" value={stored} options={options} disabled={disabled || audio === null || audio === undefined} onChange={choose} />
      </div>
      {!listed && <p className="field-error small">{label} is not connected: the slider does nothing until it is.</p>}
      {(audio === null || audio === undefined) && <p className="muted small">The device list comes from Deckhand, which is not running.</p>}
    </section>
  );
}

/** Brightness: which deck — this one, or any connected deck, with the target picker Brightness keys have (answer 6). 5 to 100, as a key's. */
function BrightnessTargetForm({ at, button, disabled, run, decks }: FormProps & { decks: ReadonlyArray<{ id: string; label: string }> }) {
  const action = actionOf('brightness', button);
  const target = typeof action?.deck === 'string' && action.deck !== '' ? action.deck : null;
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('brightness', button, { ...patch, delta: undefined, value: undefined, showLevel: undefined }) });
  return (
    <section className="inspector-section" data-value-form="brightness">
      <h3 className="section-heading">{actionName('brightness')}</h3>
      <p className="muted small">Sets a level: the deck's brightness, from 5 to 100 %, as a Brightness key's — never dark.</p>
      <h4 className="form-subheading">Deck</h4>
      <ul className="target-list" data-brightness-target>
        <li>
          <button className={target === null ? 'target target-selected' : 'target'} disabled={disabled} data-deck="" onClick={() => write({ deck: undefined })}>
            <span className="target-name">This deck</span>
          </button>
        </li>
        {target !== null && !decks.some((d) => d.id === target) && (
          <li>
            <button className="target target-selected" disabled data-deck={target}>
              <span className="target-name">{target}</span>
              <span className="target-note">not connected</span>
            </button>
          </li>
        )}
        {decks.map((d) => (
          <li key={d.id}>
            <button className={target === d.id ? 'target target-selected' : 'target'} disabled={disabled} data-deck={d.id} onClick={() => write({ deck: d.id })}>
              <span className="target-name">{d.label}</span>
              <span className="target-note">{d.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** User volume: which person, picked from your voice channel, as a User volume key picks; 0–200 %. */
function UserVolumePersonForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('discord.userVolume', button);
  const users = useDiscordList('users', null, ask);
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('discord.userVolume', button, { ...patch, delta: undefined, showLevel: undefined }) });
  return (
    <section className="inspector-section" data-value-form="discord.userVolume">
      <h3 className="section-heading">{actionName('discord.userVolume')}</h3>
      <p className="muted small">Sets a level: how loud you hear one person, from 0 to 200 %, only for you. They have to be in the voice channel you are in.</p>
      <h4 className="form-subheading">Person</h4>
      <IdPicker
        list={users}
        stored={text(action?.user)}
        storedName={text(action?.userName)}
        what="person"
        missing="not in your voice channel now"
        disabled={disabled}
        onChoose={(user) => write({ user: user.id, userName: user.name })}
        onRefresh={() => setAsk((n) => n + 1)}
      />
      <Needs />
    </section>
  );
}
