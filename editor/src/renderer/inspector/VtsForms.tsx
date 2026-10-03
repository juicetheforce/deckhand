import { useEffect, useState } from 'react';
import type { VtsList } from '../../../../src/control/protocol.js';
import { actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The VTube Studio keys (scope §7, "Streaming integrations"). What a key acts
 * on is **picked from VTube Studio's own lists, never typed**, as OBS's are:
 * a mistyped ID would only fail later, on the deck. With VTS not running
 * there is nothing to pick from — "Start VTube Studio to choose" — and a saved
 * choice is always kept and shown.
 *
 * Stored by ID, never by name (scope §7): a model's hotkeys are its own, and
 * a name can repeat, or be empty. The names are written beside the IDs only
 * to show here and in what the key says when it fails.
 */

/** VTS's list for a picker, asked when the form opens, when its model changes, and on Refresh. Null while asking. */
function useVtsList(kind: 'models' | 'hotkeys' | 'expressions', model: string | null, ask: number): VtsList | null {
  const [list, setList] = useState<VtsList | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    if (kind !== 'models' && !model) return;
    void window.deckhand.vtsList(kind, model ?? undefined).then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, [kind, model, ask]);
  return list;
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * One item from VTS's list, by ID. A saved one VTS does not list — deleted
 * there — is kept, shown first by its saved name and marked; with VTS not
 * reachable, the saved one is still shown, and nothing else can be picked.
 */
function IdPicker({
  list,
  stored,
  storedName,
  what,
  disabled,
  onChoose,
  onRefresh,
}: {
  list: VtsList | null;
  stored: string | null;
  storedName: string | null;
  /** "model", "hotkey": for the words. */
  what: string;
  disabled: boolean;
  onChoose: (item: { id: string; name: string }) => void;
  onRefresh: () => void;
}) {
  const items = list?.ok ? list.items : [];
  const storedMissing = stored !== null && list?.ok === true && !items.some((i) => i.id === stored);
  const kept = stored !== null && (list === null || !list.ok || storedMissing);
  return (
    <>
      <ul className="target-list" data-vts-picker={what}>
        {kept && (
          <li>
            <button className="target target-selected" disabled data-vts-id={stored}>
              <span className="target-name">{storedName ?? stored}</span>
              {storedMissing && <span className="target-note">not in VTube Studio now</span>}
            </button>
          </li>
        )}
        {items.map((item) => (
          <li key={item.id}>
            <button className={stored === item.id ? 'target target-selected' : 'target'} disabled={disabled} onClick={() => onChoose(item)} data-vts-id={item.id}>
              <span className="target-name">{item.name}</span>
              {item.type && <span className="target-note">{hotkeyKind(item.type)}</span>}
              {item.note && <span className="target-note">{item.note}</span>}
            </button>
          </li>
        ))}
      </ul>
      {list === null && <p className="muted small">Asking VTube Studio…</p>}
      {list?.ok === false && (
        <p className="warning-text" data-vts-list={list.reason}>
          {list.reason === 'unavailable' ? 'Start VTube Studio to choose.' : list.message}
        </p>
      )}
      {list?.ok === true && items.length === 0 && <p className="muted small">VTube Studio has no {what}s to choose from here.</p>}
      {storedMissing && (
        <p className="warning-text">
          VTube Studio has no {what} “{storedName ?? stored}” now: deleted there? The key does nothing until it is back, or pick another.
        </p>
      )}
      {stored === null && list?.ok === true && items.length > 0 && <p className="muted small">Pick the {what} for this key.</p>}
      <button className="link-button" onClick={onRefresh} data-vts-refresh={what}>
        Ask VTube Studio again
      </button>
    </>
  );
}

/** VTS's hotkey types (Files/HotkeyAction.cs), as words; one not listed is shown as VTS names it. */
function hotkeyKind(type: string): string {
  const words: Record<string, string> = {
    ToggleExpression: 'expression',
    RemoveAllExpressions: 'clear expressions',
    TriggerAnimation: 'animation',
    ChangeIdleAnimation: 'idle animation',
    ChangeBackground: 'background',
    ChangeVTSModel: 'model',
    MoveModel: 'move model',
    ScreenColorOverlay: 'screen colour',
    ToggleItemScene: 'item scene',
    RemoveAllItems: 'remove items',
    TakeScreenshot: 'screenshot',
    LoadEffectPreset: 'effect preset',
    CalibrateCam: 'calibrate',
  };
  return words[type] ?? type;
}

/** vts.hotkey: fire one of a model's hotkeys — the model first, then its hotkeys. */
export function VtsHotkeyForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('vts.hotkey', button);
  const storedModel = text(action?.model);
  const storedHotkey = text(action?.hotkey);
  // A model picked, not yet written: the hotkey list follows it until a hotkey is chosen.
  const [model, setModel] = useState<{ id: string; name: string } | null>(storedModel ? { id: storedModel, name: text(action?.modelName) ?? storedModel } : null);
  const models = useVtsList('models', null, ask);
  const hotkeys = useVtsList('hotkeys', model?.id ?? null, ask);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Trigger hotkey</h3>
      <p className="muted small">
        Fires one of a model’s hotkeys in VTube Studio — an expression, an animation, a background, whatever the hotkey does there. Hotkeys belong to a model:
        while another model is loaded the key is drawn dashed, and a press does nothing but say why.
      </p>
      <h4 className="form-subheading">Model</h4>
      <IdPicker
        list={models}
        stored={model?.id ?? null}
        storedName={model?.name ?? null}
        what="model"
        disabled={disabled}
        onChoose={setModel}
        onRefresh={() => setAsk((n) => n + 1)}
      />
      {model !== null && (
        <>
          <h4 className="form-subheading">Hotkey</h4>
          <IdPicker
            list={hotkeys}
            stored={model.id === storedModel ? storedHotkey : null}
            storedName={model.id === storedModel ? text(action?.hotkeyName) : null}
            what="hotkey"
            disabled={disabled}
            onChoose={(hotkey) =>
              void run({
                kind: 'setAction',
                at,
                action: nextAction('vts.hotkey', button, { model: model.id, modelName: model.name, hotkey: hotkey.id, hotkeyName: hotkey.name }),
              })
            }
            onRefresh={() => setAsk((n) => n + 1)}
          />
        </>
      )}
    </section>
  );
}

/** vts.model: load a model in VTube Studio — one picker. */
export function VtsModelForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('vts.model', button);
  const models = useVtsList('models', null, ask);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Model</h3>
      <p className="muted small">
        Loads a model in VTube Studio. The key is lit while that model is loaded; pressed then, it does nothing, since VTube Studio would reload the model.
      </p>
      <IdPicker
        list={models}
        stored={text(action?.model)}
        storedName={text(action?.modelName)}
        what="model"
        disabled={disabled}
        onChoose={(model) => void run({ kind: 'setAction', at, action: nextAction('vts.model', button, { model: model.id, modelName: model.name }) })}
        onRefresh={() => setAsk((n) => n + 1)}
      />
    </section>
  );
}

/**
 * vts.expression: turn one of a model's expressions on or off — the model
 * first, then its expressions. VTS lists only the loaded model's (scope §7,
 * built around the model in use): for another, the picker says to load it.
 */
export function VtsExpressionForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('vts.expression', button);
  const storedModel = text(action?.model);
  // A model picked, not yet written: the expression list follows it until an expression is chosen.
  const [model, setModel] = useState<{ id: string; name: string } | null>(storedModel ? { id: storedModel, name: text(action?.modelName) ?? storedModel } : null);
  const models = useVtsList('models', null, ask);
  const expressions = useVtsList('expressions', model?.id ?? null, ask);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Toggle expression</h3>
      <p className="muted small">
        Turns one of a model’s expressions on or off in VTube Studio, and is lit while it is on. Its model has to be the one loaded: with another loaded, a press
        does nothing but say why.
      </p>
      <p className="muted small" data-vts-gap="stable">
        On VTube Studio’s stable version, an expression changed without a hotkey — by another plugin, say — is not shown here until the next model load or
        expression hotkey. Changes through a hotkey, in VTube Studio or from a deck, always show. The beta version reports every change.
      </p>
      <h4 className="form-subheading">Model</h4>
      <IdPicker
        list={models}
        stored={model?.id ?? null}
        storedName={model?.name ?? null}
        what="model"
        disabled={disabled}
        onChoose={setModel}
        onRefresh={() => setAsk((n) => n + 1)}
      />
      {model !== null && (
        <>
          <h4 className="form-subheading">Expression</h4>
          <IdPicker
            list={expressions}
            stored={model.id === storedModel ? text(action?.expression) : null}
            storedName={model.id === storedModel ? text(action?.expressionName) : null}
            what="expression"
            disabled={disabled}
            onChoose={(expression) =>
              void run({
                kind: 'setAction',
                at,
                action: nextAction('vts.expression', button, { model: model.id, modelName: model.name, expression: expression.id, expressionName: expression.name }),
              })
            }
            onRefresh={() => setAsk((n) => n + 1)}
          />
        </>
      )}
    </section>
  );
}
