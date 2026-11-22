import { useEffect, useState } from 'react';
import type { ButtonDef, Config } from '../../../../src/types.js';
import { anglesOf, ANGLE_LIMIT, builtinLayerSvg, DEFAULT_ANGLES, LAYER_LABELS, LAYERS, MIN_SWEEP, takesValue, type LayerName } from '../../../../src/value-controls.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import { iconUrl } from '../../shared/icons.js';
import { actionName } from '../catalogue.js';
import { ColourPicker } from '../ColourPicker.js';
import { IconPicker, type PickerPlace } from '../IconPicker.js';
import { describeAction, keyKind } from '../model.js';
import type { AudioLists } from './DeviceForms.js';
import { LabelField, LabelStyle } from './LabelFields.js';
import { ValueActionForm } from './ValueForms.js';

/**
 * The inspector for a slider or dial (round 5; boards 26d, 26f): the Key tab
 * names what it sets and on what, its label, and its background, which is
 * None unless set — the page shows around its art; the Icon tab picks each
 * of its image layers like an icon. One Clear empties it.
 */
export function ValueInspector({
  kind,
  at,
  keyNumber,
  button,
  failure,
  editingBlocked,
  config,
  labelDefaults,
  audio,
  decks,
  canPreview,
  place,
  onPlace,
  apply,
}: {
  kind: 'slider' | 'dial';
  at: ButtonLocation;
  keyNumber: string;
  button: ButtonDef | undefined;
  failure: string | undefined;
  editingBlocked: boolean;
  config: Config;
  labelDefaults: { labelPosition: 'top' | 'bottom' | 'center'; labelColor: string; labelSize: number };
  audio: AudioLists;
  decks: ReadonlyArray<{ id: string; label: string }>;
  canPreview: boolean;
  place: PickerPlace;
  onPlace: (place: PickerPlace) => void;
  apply: (edit: Edit) => Promise<string | null>;
}) {
  const [tab, setTab] = useState<'key' | 'icon'>('key');
  const [layer, setLayer] = useState<LayerName>(LAYERS[kind][2]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setLayer(LAYERS[kind][2]), [kind]);
  const run = async (edit: Edit) => {
    const failed = await apply(edit);
    setError(failed);
    return failed === null;
  };
  const what = kind === 'slider' ? 'Slider' : 'Dial';
  const type = button?.action?.type;
  const valued = takesValue(type);
  return (
    <aside className="inspector glass" aria-label="Inspector" data-value-inspector={kind}>
      <h2 className="inspector-title">
        {what} · Key {keyNumber}
      </h2>
      {failure !== undefined && (
        <div className="key-callout key-failure" role="status">
          <p className="key-callout-text">
            <strong className="key-callout-title">Its last change failed.</strong> {failure}
          </p>
          <div className="key-callout-actions">
            <button className="key-failure-clear" title="Clear the badge, here and on the deck" onClick={() => void window.deckhand.clearFailure(at)}>
              Clear
            </button>
          </div>
        </div>
      )}
      <div className="inspector-tabs" role="tablist">
        <button role="tab" className={`inspector-tab ${tab === 'key' ? 'inspector-tab-selected' : ''}`} aria-selected={tab === 'key'} onClick={() => setTab('key')}>
          Key
        </button>
        <button role="tab" className={`inspector-tab ${tab === 'icon' ? 'inspector-tab-selected' : ''}`} aria-selected={tab === 'icon'} onClick={() => setTab('icon')}>
          Icon
        </button>
      </div>

      {tab === 'key' && !type && (
        <section className="inspector-section" data-value-form="none">
          <h3 className="section-heading">Action</h3>
          <p className="muted">Nothing yet. A {kind} takes an action that sets a level: Volume, Brightness or User volume. Drag one from the library onto it, or click one there.</p>
        </section>
      )}
      {tab === 'key' && type && !valued && (
        <section className="inspector-section" data-value-form="refused">
          <h3 className="section-heading">Action</h3>
          <p className="field-error">
            {actionName(type)} sets no level, so this {kind} does nothing with it. {describeAction(button)}
          </p>
        </section>
      )}
      {tab === 'key' && type && valued && <ValueActionForm type={type} at={at} button={button} disabled={editingBlocked} run={run} audio={audio} decks={decks} />}

      {tab === 'key' && (
        <section className="inspector-section">
          <h3 className="section-heading">Label</h3>
          <LabelField label={button?.label ?? ''} disabled={editingBlocked} onSave={(label) => void run({ kind: 'setLabel', at, label })} />
          <p className="muted small">Under the {kind === 'slider' ? 'track' : 'dial'}, inside its box.</p>
          <LabelStyle at={at} button={button} defaults={labelDefaults} disabled={editingBlocked} run={run} />
        </section>
      )}

      {tab === 'key' && (
        <section className="inspector-section" data-inspector-section="background">
          <h3 className="section-heading">Background</h3>
          <ColourPicker
            name="key-background"
            label="Background"
            value={button?.background ?? null}
            defaultColor="transparent"
            defaultName="None"
            defaultTitle={`the page shows around the ${kind}'s art`}
            disabled={editingBlocked}
            onChange={(color) => void run({ kind: 'setKeyBackground', at, color })}
          />
        </section>
      )}

      {tab === 'icon' && (
        <>
          {/* One chip per layer (26f): the open one tinted, each with its image and name, "Built-in" or "None". */}
          <div className="layer-chips" role="group" aria-label="Layers">
            {LAYERS[kind].map((name) => (
              <LayerChip key={name} name={name} kind={kind} button={button} config={config} open={name === layer} onOpen={() => setLayer(name)} />
            ))}
          </div>
          <IconPicker key={layer} at={at} button={button} slot={null} layer={layer} editingBlocked={editingBlocked} canPreview={canPreview} place={place} onPlace={onPlace} />
          {layer === 'knob' && <KnobAngles at={at} button={button} disabled={editingBlocked} run={run} />}
          <p className="muted small">Each layer is drawn to the control's box. Icon scale is a button's alone.</p>
        </>
      )}

      {error && <p className="field-error">{error}</p>}

      {tab === 'key' && keyKind(button) !== 'empty' && (
        <div className="button-row danger-row">
          <button className="danger" disabled={editingBlocked} onClick={() => void run({ kind: 'clearButton', at })} data-clear-value="">
            Clear {kind}
          </button>
        </div>
      )}
    </aside>
  );
}

/** A layer's chip: its picture and what it is — a file's name, Built-in, or None. */
function LayerChip({ name, kind, button, config: _config, open, onOpen }: { name: LayerName; kind: 'slider' | 'dial'; button: ButtonDef | undefined; config: Config; open: boolean; onOpen: () => void }) {
  const ref = button?.layers?.[name];
  const said = ref === null ? 'None' : typeof ref === 'string' ? (ref.split('/').pop() ?? ref) : 'Built-in';
  const box = kind === 'slider' ? { w: 46, h: 130 } : { w: 76, h: 76 };
  return (
    <button className={`layer-chip${open ? ' layer-chip-open' : ''}`} aria-pressed={open} onClick={onOpen} data-layer-chip={name} title={typeof ref === 'string' ? ref : said}>
      <span className="layer-chip-picture" aria-hidden="true">
        {typeof ref === 'string' ? (
          <img src={iconUrl(ref)} alt="" draggable={false} />
        ) : ref === null ? (
          <span className="layer-chip-none">∅</span>
        ) : (
          <span dangerouslySetInnerHTML={{ __html: builtinLayerSvg(name, box, { type: button?.action?.type, angles: anglesOf(button) }).replace('<svg ', '<svg style="width:100%;height:100%" ') }} />
        )}
      </span>
      <span className="layer-chip-text">
        <span className="layer-chip-name">{LAYER_LABELS[name]}</span>
        <span className="layer-chip-file muted small">{said}</span>
      </span>
    </button>
  );
}

/** The knob turns from Start to End (26f), degrees from straight up, clockwise: kept with the knob's art. */
function KnobAngles({ at, button, disabled, run }: { at: ButtonLocation; button: ButtonDef | undefined; disabled: boolean; run: (edit: Edit) => Promise<boolean> }) {
  const angles = anglesOf(button);
  const [start, setStart] = useState(String(angles.start));
  const [end, setEnd] = useState(String(angles.end));
  useEffect(() => {
    setStart(String(angles.start));
    setEnd(String(angles.end));
  }, [angles.start, angles.end]);
  const save = () => {
    const s = Math.round(Number(start));
    const e = Math.round(Number(end));
    const ok = Number.isFinite(s) && Number.isFinite(e) && Math.abs(s) <= ANGLE_LIMIT && Math.abs(e) <= ANGLE_LIMIT && e - s >= MIN_SWEEP && e - s <= 360;
    if (!ok) {
      setStart(String(angles.start));
      setEnd(String(angles.end));
      return;
    }
    if (s === angles.start && e === angles.end) return;
    void run({ kind: 'setAngles', at, angles: s === DEFAULT_ANGLES.start && e === DEFAULT_ANGLES.end ? null : { start: s, end: e } });
  };
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="layout-field">
      <span className="layout-field-label">{label}</span>
      <input
        className="sp-input"
        type="number"
        aria-label={`Knob turns from: ${label}`}
        value={value}
        disabled={disabled}
        data-knob-angle={label.toLowerCase()}
        onChange={(e) => set(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
      />
      <span className="form-value">°</span>
    </label>
  );
  return (
    <section className="inspector-section" data-knob-angles="">
      <h3 className="section-heading">Knob turns from</h3>
      <div className="layout-fields">
        {field('Start', start, setStart)}
        {field('End', end, setEnd)}
      </div>
      <p className="muted small">Degrees from straight up, clockwise. They go with the knob's art: where its pointer rests depends on the image.</p>
    </section>
  );
}
