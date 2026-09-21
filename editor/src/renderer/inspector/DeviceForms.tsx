import type { AudioList, PickableDevice } from '../../../../src/control/protocol.js';
import { Checkbox, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The audio device forms: Output device, Input device, Cycle outputs and
 * Cycle inputs. The rule they follow: **the user picks from the daemon's live list,
 * and the editor writes that exact node with its description as `label`** —
 * never a match string, and no logic about which device was meant. A headset's
 * stereo and mono sinks are both listed; choosing is the user's call.
 *
 * A stored device that is not in the list now (unplugged) stays chosen and
 * says so: the key keeps pointing at it, and does nothing until it is back.
 */

export type AudioLists = { sinks: AudioList; sources: AudioList } | null | undefined;

interface DeviceRef {
  node: string;
  label: string;
}

function refOf(value: unknown): DeviceRef | null {
  const v = value as { node?: unknown; label?: unknown } | null;
  if (!v || typeof v.node !== 'string' || v.node === '') return null;
  return { node: v.node, label: typeof v.label === 'string' ? v.label : '' };
}

function NotRead() {
  return <p className="warning-text">The daemon has not listed the audio devices yet, so there is nothing to pick from. Is it running?</p>;
}

/** One device as a choice: its description, its node underneath, and what the daemon knows about it. */
function DeviceButton({
  device,
  selected,
  isDefault,
  missing,
  disabled,
  onClick,
}: {
  device: DeviceRef & { available?: PickableDevice['available'] };
  selected: boolean;
  isDefault: boolean;
  missing: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const notes = [isDefault ? 'in use now' : '', device.available === 'no' ? 'nothing plugged in' : '', missing ? 'not present now' : ''].filter(Boolean);
  return (
    <button className={selected ? 'target target-selected' : 'target'} disabled={disabled} onClick={onClick} data-node={device.node}>
      <span className="target-name">{device.label || device.node}</span>
      <span className="target-note">
        {device.node}
        {notes.length > 0 ? ` — ${notes.join(', ')}` : ''}
      </span>
    </button>
  );
}

/** audio.sink and audio.source: one device from the list. */
function SingleDeviceForm({
  type,
  list,
  heading,
  intro,
  moveStreamsLabel,
  at,
  button,
  disabled,
  run,
}: FormProps & { type: 'audio.sink' | 'audio.source'; list: AudioList | undefined; heading: string; intro: string; moveStreamsLabel: string }) {
  const action = actionOf(type, button);
  const stored = refOf(action);
  const listed = list?.devices ?? [];
  const storedMissing = stored !== null && list !== undefined && !listed.some((d) => d.node === stored.node);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction(type, button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">{heading}</h3>
      <p className="muted small">{intro}</p>
      {list === undefined ? (
        <NotRead />
      ) : (
        <ul className="target-list">
          {storedMissing && (
            <li>
              <DeviceButton device={stored} selected isDefault={false} missing disabled onClick={() => {}} />
            </li>
          )}
          {listed.map((d) => (
            <li key={d.node}>
              <DeviceButton
                device={d}
                selected={stored?.node === d.node}
                isDefault={list.default === d.node}
                missing={false}
                disabled={disabled}
                onClick={() => write({ node: d.node, label: d.label })}
              />
            </li>
          ))}
        </ul>
      )}
      {storedMissing && <p className="warning-text">“{stored.label || stored.node}” is not present now. The key does nothing until it is back, or pick another.</p>}
      {stored === null && list !== undefined && <p className="muted small">Pick the device this key switches to.</p>}
      {stored !== null && (
        <Checkbox label={moveStreamsLabel} checked={action?.moveStreams !== false} disabled={disabled} onChange={(on) => write({ moveStreams: on ? undefined : false })} />
      )}
    </section>
  );
}

export function OutputForm(props: FormProps & { audio: AudioLists }) {
  return <SingleDeviceForm {...props} type="audio.sink" list={props.audio?.sinks} heading="Output device" intro="Makes this the default output. The key is highlighted while it is." moveStreamsLabel="Move sound that is playing to it" />;
}

export function InputForm(props: FormProps & { audio: AudioLists }) {
  return <SingleDeviceForm {...props} type="audio.source" list={props.audio?.sources} heading="Input device" intro="Makes this the default input. The key is highlighted while it is." moveStreamsLabel="Move what is already recording to it" />;
}

/**
 * audio.cycle and audio.cycleSource: an ordered list of devices, stepped
 * through on each press. Parameterised over the two exactly as
 * SingleDeviceForm is over audio.sink and audio.source — the stored shape is
 * identical, only the list it draws from and the words differ.
 */
function CycleDeviceForm({
  type,
  list,
  heading,
  intro,
  noun,
  showCurrentLabel,
  moveStreamsLabel,
  at,
  button,
  disabled,
  run,
}: FormProps & {
  type: 'audio.cycle' | 'audio.cycleSource';
  list: AudioList | undefined;
  heading: string;
  intro: string;
  noun: string;
  showCurrentLabel: string;
  moveStreamsLabel: string;
}) {
  const action = actionOf(type, button);
  const entries: DeviceRef[] = Array.isArray(action?.devices) ? action.devices.map(refOf).filter((d): d is DeviceRef => d !== null) : [];
  const listed = list?.devices ?? [];
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction(type, button, patch) });
  const writeDevices = (next: DeviceRef[]) => write({ devices: next.map((d) => ({ node: d.node, label: d.label })) });
  const move = (i: number, by: number) => {
    const next = [...entries];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    writeDevices(next);
  };
  const unused = listed.filter((d) => !entries.some((e) => e.node === d.node));
  return (
    <section className="inspector-section">
      <h3 className="section-heading">{heading}</h3>
      <p className="muted small">{intro}</p>
      {entries.length > 0 && (
        <ol className="cycle-list">
          {entries.map((e, i) => {
            const present = list === undefined || listed.some((d) => d.node === e.node);
            return (
              <li key={`${e.node}-${i}`} className="cycle-entry" data-node={e.node}>
                <span className="target-name">{e.label || e.node}</span>
                <span className="target-note">
                  {e.node}
                  {present ? '' : ' — not present now, skipped'}
                  {list?.default === e.node ? ' — in use now' : ''}
                </span>
                <span className="cycle-controls">
                  <button disabled={disabled || i === 0} aria-label={`Move ${e.label || e.node} up`} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button disabled={disabled || i === entries.length - 1} aria-label={`Move ${e.label || e.node} down`} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button disabled={disabled} aria-label={`Remove ${e.label || e.node}`} onClick={() => writeDevices(entries.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {entries.length < 2 && <p className="muted small">Add at least two {noun}s.</p>}
      {list === undefined ? (
        <NotRead />
      ) : (
        unused.length > 0 && (
          <>
            <p className="form-subheading">Add an {noun}</p>
            <ul className="target-list">
              {unused.map((d) => (
                <li key={d.node}>
                  <DeviceButton device={d} selected={false} isDefault={list.default === d.node} missing={false} disabled={disabled} onClick={() => writeDevices([...entries, { node: d.node, label: d.label }])} />
                </li>
              ))}
            </ul>
          </>
        )
      )}
      {entries.length > 0 && (
        <>
          <Checkbox label={showCurrentLabel} checked={action?.showCurrent !== false} disabled={disabled} onChange={(on) => write({ showCurrent: on ? undefined : false })} />
          <Checkbox label={moveStreamsLabel} checked={action?.moveStreams !== false} disabled={disabled} onChange={(on) => write({ moveStreams: on ? undefined : false })} />
        </>
      )}
    </section>
  );
}

export function CycleForm(props: FormProps & { audio: AudioLists }) {
  return (
    <CycleDeviceForm
      {...props}
      type="audio.cycle"
      list={props.audio?.sinks}
      heading="Cycle outputs"
      intro="Each press switches to the next output in this list, wrapping round; two make a toggle. The key shows the active one's name."
      noun="output"
      showCurrentLabel="Show the active output's name on the key"
      moveStreamsLabel="Move sound that is playing to it"
    />
  );
}

export function CycleInputsForm(props: FormProps & { audio: AudioLists }) {
  return (
    <CycleDeviceForm
      {...props}
      type="audio.cycleSource"
      list={props.audio?.sources}
      heading="Cycle inputs"
      intro="Each press switches to the next input in this list, wrapping round; two make a toggle. The key shows the active one's name."
      noun="input"
      showCurrentLabel="Show the active input's name on the key"
      moveStreamsLabel="Move what is already recording to it"
    />
  );
}
