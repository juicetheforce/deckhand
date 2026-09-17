import { useEffect, useRef, useState } from 'react';
import type { ButtonDef } from '../../../src/types.js';
import type { ButtonLocation, Edit } from '../shared/edits.js';
import { actionName } from './catalogue.js';
import { EMPTY_PLACE, IconPicker, type PickerPlace } from './IconPicker.js';
import { HotkeyForm, PressReleaseForm } from './inspector/HotkeyForm.js';
import { CommandForm, TextForm } from './inspector/TextCommandForms.js';
import { IconState } from './inspector/IconState.js';
import { LabelField, LabelStyle } from './inspector/LabelFields.js';
import { PageAction } from './inspector/PageAction.js';
import { ProfileAction } from './inspector/ProfileAction.js';
import { pairIconFields, type PairIconField } from '../shared/icons.js';
import { MuteForm, VolumeForm } from './inspector/AudioForms.js';
import { CycleForm, InputForm, OutputForm, type AudioLists } from './inspector/DeviceForms.js';
import { pairLabel } from './inspector/controls.js';
import { MediaControlForm, MediaInfoForm } from './inspector/MediaForms.js';
import { BrightnessForm, ClockForm, NoopForm } from './inspector/SystemForms.js';
import { actionEditable, actionIncomplete, clipboardSummary, describeAction, hasForm, keyKind, type Choice } from './model.js';
import type { Bulk } from './useBulk.js';

interface Props {
  /** How many keys are selected. With more than one, the inspector offers the bulk operations instead of one key's fields. */
  selectedCount: number;
  bulk: Bulk;
  at: ButtonLocation | null;
  button: ButtonDef | undefined;
  editingBlocked: boolean;
  /** Bumped when a library entry is clicked: configure the key as that action. */
  pick: Pick | null;
  /** Pages in the layout being edited, as "Go to page" targets. */
  pages: Choice[];
  /** Every profile, as "Switch profile" targets. */
  profiles: Choice[];
  /** Which decks a profile covers, and which connected decks it leaves out. */
  coverage: (profile: string) => { covered: string[]; uncoveredConnected: string[] };
  /** What the label inherits when the key sets nothing: config `defaults`, then the daemon's. */
  labelDefaults: { labelPosition: 'top' | 'bottom' | 'center'; labelColor: string; labelSize: number };
  /** The daemon is connected and the deck attached, so the icon picker can preview on it. */
  canPreview: boolean;
  /** The daemon's live audio device lists, for the device forms. */
  audio: AudioLists;
  apply: (edit: Edit) => Promise<string | null>;
}

type Tab = 'key' | 'icon';

/**
 * An action taken from the library for the selected key: a click, or a drop,
 * which has already written the action and only needs its form shown.
 */
export interface Pick {
  type: string;
  token: number;
  /** A click: a Hotkey pick starts recording, and an action needing no setting is written at once. */
  click: boolean;
}

/**
 * The selected key (scope §10): a form for its action (one file per action in
 * inspector/), its label and icon state, and Clear button. An action with no
 * form, or carrying settings its form has no control for, is shown read-only.
 */
export function Inspector({ selectedCount, bulk, at, button, editingBlocked, pick, pages, profiles, coverage, labelDefaults, canPreview, audio, apply }: Props) {
  // Kept here, outside the per-key component, so the tab and the picker's
  // folder stay put while moving from key to key in a setup burst.
  const [tab, setTab] = useState<Tab>('key');
  const [place, setPlace] = useState<PickerPlace>(EMPTY_PLACE);
  // Picking an action from the library means the Key tab.
  const firstToken = useRef(pick?.token ?? 0);
  useEffect(() => {
    if ((pick?.token ?? 0) !== firstToken.current) setTab('key');
  }, [pick?.token]);

  if (selectedCount > 1) {
    return <SeveralKeys count={selectedCount} bulk={bulk} editingBlocked={editingBlocked} />;
  }
  if (at === null) {
    return (
      <aside className="inspector glass">
        <p className="muted">Select a key to see what it does.</p>
        <p className="muted small">{SELECTING_SEVERAL}</p>
      </aside>
    );
  }
  // Keyed by location so every piece of state resets when another key is selected.
  return (
    <KeyInspector
      key={`${at.profile}/${at.serial}/${at.page}/${at.index}`}
      at={at}
      button={button}
      editingBlocked={editingBlocked}
      pick={pick}
      pages={pages}
      profiles={profiles}
      coverage={coverage}
      labelDefaults={labelDefaults}
      canPreview={canPreview}
      audio={audio}
      apply={apply}
      tab={tab}
      onTab={setTab}
      place={place}
      onPlace={setPlace}
    />
  );
}

/**
 * How to select several keys, said where someone looking at the inspector will
 * read it. Multi-select is a gesture, so it is written down rather than left
 * for someone to already know (scope §10: capabilities cannot hide).
 */
const SELECTING_SEVERAL = 'Ctrl+click adds a key to the selection, Shift+click selects a run of keys, and right-click shows what you can do with them.';

/**
 * Several keys selected (M4 phase B3). No fields: editing one label across ten
 * keys is not a B3 operation. The same operations as the right-click menu,
 * with their shortcuts, so they can be found without right-clicking.
 */
function SeveralKeys({ count, bulk, editingBlocked }: { count: number; bulk: Bulk; editingBlocked: boolean }) {
  return (
    <aside className="inspector glass" aria-label="Inspector">
      <h2 className="inspector-title">{count} keys selected</h2>
      <p className="muted small">{SELECTING_SEVERAL}</p>
      <div className="bulk-actions">
        <button disabled={editingBlocked} onClick={() => void bulk.duplicate()}>
          Duplicate <kbd>Ctrl+D</kbd>
        </button>
        <button disabled={editingBlocked} onClick={bulk.copy}>
          Copy <kbd>Ctrl+C</kbd>
        </button>
        <button
          disabled={editingBlocked || bulk.clipboard === null}
          title={bulk.clipboard === null ? 'Nothing copied yet' : `Paste ${clipboardSummary(bulk.clipboard)}`}
          onClick={() => void bulk.paste()}
        >
          Paste <kbd>Ctrl+V</kbd>
        </button>
        <button className="danger" disabled={editingBlocked} onClick={() => void bulk.clear()}>
          Clear {count} buttons <kbd>Del</kbd>
        </button>
      </div>
    </aside>
  );
}

interface KeyInspectorProps extends Omit<Props, 'selectedCount' | 'bulk'> {
  at: ButtonLocation;
  tab: Tab;
  onTab: (tab: Tab) => void;
  place: PickerPlace;
  onPlace: (place: PickerPlace) => void;
}

function KeyInspector({ at, button, editingBlocked, pick, pages, profiles, coverage, labelDefaults, canPreview, audio, apply, tab, onTab, place, onPlace }: KeyInspectorProps) {
  const [error, setError] = useState<string | null>(null);
  const kind = keyKind(button);
  // The action type being configured: the one picked from the library, else
  // whatever the key already has. A key with no action shows the hotkey
  // editor, as it did in phase A.
  // Seeded from the key's own action, not left null, so an edit that
  // momentarily removes the action — switching "Back" to "A page" — does not
  // drop the editor back to Hotkey underneath the user. Per key: the component
  // is keyed by location.
  const [chosen, setChosen] = useState<string | null>(() => button?.action?.type ?? null);
  const type = chosen ?? button?.action?.type ?? 'hotkey';
  const editable = actionEditable(button, type);
  // A library pick of Hotkey asks the hotkey form to start listening.
  const [listenRequest, setListenRequest] = useState(false);
  // Which icon the Icon tab chooses: the key's own (null), or one of its
  // action's state pair (C2 call 4). A pair field the action no longer has
  // falls back to the key's own.
  const pairFields = pairIconFields(button?.action);
  const [slotChosen, setSlot] = useState<PairIconField | null>(null);
  const slot = slotChosen !== null && pairFields.includes(slotChosen) ? slotChosen : null;
  const chooseIcon = (field: PairIconField) => {
    setSlot(field);
    onTab('icon');
  };

  // A library pick configures the key as that action (not on first render).
  const firstToken = useRef(pick?.token ?? 0);
  useEffect(() => {
    if (pick === null || pick.token === firstToken.current || editingBlocked) return;
    if (!actionEditable(button, pick.type)) return;
    setChosen(pick.type);
    if (!pick.click) return;
    // Hotkey and Press/Release start doing something at once: they listen.
    if (pick.type === 'hotkey' || pick.type === 'keyHold') setListenRequest(true);
    // An action with nothing to choose (Clock, Mic mute, …) is complete as it
    // is, so a click writes it — keeping icon and label (C2 call 3). One that
    // needs a setting is written when the setting is chosen.
    else if (button?.action?.type !== pick.type && !actionIncomplete({ type: pick.type })) {
      void run({ kind: 'setAction', at, action: { type: pick.type } });
    }
  }, [pick?.token]);

  const run = async (edit: Edit) => {
    const failure = await apply(edit);
    setError(failure);
    return failure === null;
  };

  return (
    <aside className="inspector glass" aria-label="Inspector">
      <h2 className="inspector-title">Key {at.index + 1}</h2>
      <div className="inspector-tabs" role="tablist">
        <button role="tab" className={`inspector-tab ${tab === 'key' ? 'inspector-tab-selected' : ''}`} aria-selected={tab === 'key'} onClick={() => onTab('key')}>
          Key
        </button>
        <button role="tab" className={`inspector-tab ${tab === 'icon' ? 'inspector-tab-selected' : ''}`} aria-selected={tab === 'icon'} onClick={() => onTab('icon')}>
          Icon
        </button>
      </div>

      {tab === 'icon' && pairFields.length > 0 && (
        <div className="icon-slots">
          <div className="segmented segmented-wrap" role="group" aria-label="Which icon">
            {[null, ...pairFields].map((field) => (
              <button
                key={field ?? 'key'}
                className={field === slot ? 'segment segment-selected' : 'segment'}
                aria-pressed={field === slot}
                onClick={() => setSlot(field)}
              >
                {field === null ? 'Key icon' : pairLabel(field)}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'icon' && (
        // Keyed by slot: the picker's saving state belongs to one icon.
        <IconPicker key={slot ?? 'key'} at={at} button={button} slot={slot} editingBlocked={editingBlocked} canPreview={canPreview} place={place} onPlace={onPlace} />
      )}

      {tab === 'key' && editable && type === 'page' && (
        <PageAction at={at} action={button?.action} pages={pages} disabled={editingBlocked} run={run} />
      )}

      {tab === 'key' && editable && type === 'profile' && (
        <ProfileAction at={at} action={button?.action} profiles={profiles} coverage={coverage} disabled={editingBlocked} run={run} />
      )}

      {tab === 'key' && editable && type === 'hotkey' && (
        <HotkeyForm at={at} button={button} editingBlocked={editingBlocked} run={run} listenRequest={listenRequest} onListening={() => setListenRequest(false)} />
      )}

      {tab === 'key' && editable && type === 'keyHold' && (
        <PressReleaseForm at={at} button={button} editingBlocked={editingBlocked} run={run} listenRequest={listenRequest} onListening={() => setListenRequest(false)} />
      )}
      {tab === 'key' && editable && type === 'text' && <TextForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && type === 'command' && <CommandForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && type === 'clock' && <ClockForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && type === 'noop' && <NoopForm />}
      {tab === 'key' && editable && type === 'brightness' && <BrightnessForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && type === 'media.control' && (
        <MediaControlForm at={at} button={button} disabled={editingBlocked} run={run} onChooseIcon={chooseIcon} />
      )}
      {tab === 'key' && editable && type === 'media.info' && <MediaInfoForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && type === 'audio.volume' && <VolumeForm at={at} button={button} disabled={editingBlocked} run={run} />}
      {tab === 'key' && editable && (type === 'audio.micMute' || type === 'audio.mute') && (
        <MuteForm type={type} at={at} button={button} disabled={editingBlocked} run={run} onChooseIcon={chooseIcon} />
      )}

      {tab === 'key' && editable && type === 'audio.sink' && <OutputForm at={at} button={button} disabled={editingBlocked} run={run} audio={audio} />}
      {tab === 'key' && editable && type === 'audio.source' && <InputForm at={at} button={button} disabled={editingBlocked} run={run} audio={audio} />}
      {tab === 'key' && editable && type === 'audio.cycle' && <CycleForm at={at} button={button} disabled={editingBlocked} run={run} audio={audio} />}

      {tab === 'key' && !(editable && hasForm(type)) && (
        <section className="inspector-section">
          <h3 className="section-heading">Action</h3>
          <dl className="facts">
            <dt>Action</dt>
            <dd>{button?.action ? actionName(button.action.type) : 'none'}</dd>
            <dt>Does</dt>
            <dd>{describeAction(button)}</dd>
          </dl>
          <p className="muted">Not configurable in the editor yet. As saved:</p>
          <pre className="json">{JSON.stringify({ action: button?.action, onRelease: button?.onRelease }, null, 2)}</pre>
        </section>
      )}

      {tab === 'key' && (
        <section className="inspector-section">
          <h3 className="section-heading">Label</h3>
          <LabelField label={button?.label ?? ''} disabled={editingBlocked} onSave={(label) => void run({ kind: 'setLabel', at, label })} />
          {/* A label with no icon is a finished button, not a placeholder
              (scope §2), so these are worth having whether or not an icon is
              set. All three have been in the schema and the renderer since
              v0.1; only the UI was missing. */}
          <LabelStyle at={at} button={button} defaults={labelDefaults} disabled={editingBlocked} run={run} />
        </section>
      )}

      {tab === 'key' && (
        <section className="inspector-section">
          <h3 className="section-heading">Icon</h3>
          <IconState button={button} disabled={editingBlocked} onChoose={(icon) => void run({ kind: 'setIcon', at, icon })} onBrowse={() => onTab('icon')} />
        </section>
      )}

      {error && <p className="field-error">{error}</p>}

      {tab === 'key' && kind !== 'empty' && (
        <div className="button-row danger-row">
          <button className="danger" disabled={editingBlocked} onClick={() => void run({ kind: 'clearButton', at })}>
            Clear button
          </button>
        </div>
      )}
    </aside>
  );
}

