import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ButtonDef } from '../../../src/types.js';
import type { SystemShortcut } from '../shared/bridge.js';
import type { ButtonLocation, Edit } from '../shared/edits.js';
import { LAYOUT_REMAPPED_KEYS, MODIFIER_ORDER, canonicalCombo, captureKey, keycaps, type Modifier } from '../shared/keys.js';
import { actionName } from './catalogue.js';
import { EMPTY_PLACE, IconPicker, type PickerPlace } from './IconPicker.js';
import { describeAction, hotkeyEditable, keyKind } from './model.js';

interface Props {
  at: ButtonLocation | null;
  button: ButtonDef | undefined;
  editingBlocked: boolean;
  /** Changes when the library's Hotkey entry is clicked: start listening. */
  listenToken: number;
  /** The daemon is connected and the deck attached, so the icon picker can preview on it. */
  canPreview: boolean;
  apply: (edit: Edit) => Promise<string | null>;
}

type Tab = 'key' | 'icon';

type Mode =
  | { kind: 'view' }
  | { kind: 'listening'; held: Modifier[]; message: string | null }
  | { kind: 'typing'; text: string; error: string | null }
  | { kind: 'confirm'; combo: string; shortcut: SystemShortcut };

/**
 * The selected key (scope §10): the hotkey inspector — record by pressing
 * the combo, Type manually, Re-record / Clear hotkey / Clear button — and the
 * label. Other action types are shown read-only in phase A, label still
 * editable.
 */
export function Inspector({ at, button, editingBlocked, listenToken, canPreview, apply }: Props) {
  // Kept here, outside the per-key component, so the tab and the picker's
  // folder stay put while moving from key to key in a setup burst.
  const [tab, setTab] = useState<Tab>('key');
  const [place, setPlace] = useState<PickerPlace>(EMPTY_PLACE);
  // The library's Hotkey entry means the Key tab.
  const firstToken = useRef(listenToken);
  useEffect(() => {
    if (listenToken !== firstToken.current) setTab('key');
  }, [listenToken]);

  if (at === null) {
    return (
      <aside className="inspector glass">
        <p className="muted">Select a key to see what it does.</p>
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
      listenToken={listenToken}
      canPreview={canPreview}
      apply={apply}
      tab={tab}
      onTab={setTab}
      place={place}
      onPlace={setPlace}
    />
  );
}

interface KeyInspectorProps extends Props {
  at: ButtonLocation;
  tab: Tab;
  onTab: (tab: Tab) => void;
  place: PickerPlace;
  onPlace: (place: PickerPlace) => void;
}

function KeyInspector({ at, button, editingBlocked, listenToken, canPreview, apply, tab, onTab, place, onPlace }: KeyInspectorProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [error, setError] = useState<string | null>(null);
  const kind = keyKind(button);
  const editable = hotkeyEditable(button);
  const combo = button?.action?.type === 'hotkey' && typeof button.action.keys === 'string' ? button.action.keys : null;

  // Start listening when the library's Hotkey entry is clicked (not on first render).
  const firstToken = useRef(listenToken);
  useEffect(() => {
    if (listenToken !== firstToken.current && editable && !editingBlocked) setMode({ kind: 'listening', held: [], message: null });
  }, [listenToken, editable, editingBlocked]);

  // Listening swallows every key; it must never carry on out of sight on another tab.
  useEffect(() => {
    if (tab !== 'key') setMode({ kind: 'view' });
  }, [tab]);

  // Is the saved combo a KDE shortcut? Checked whenever it changes.
  const [savedShortcut, setSavedShortcut] = useState<SystemShortcut | null>(null);
  useEffect(() => {
    let alive = true;
    setSavedShortcut(null);
    if (combo) void window.deckhand.findSystemShortcut(combo).then((s) => alive && setSavedShortcut(s));
    return () => {
      alive = false;
    };
  }, [combo]);

  const run = async (edit: Edit) => {
    const failure = await apply(edit);
    setError(failure);
    return failure === null;
  };

  /** Save a combo, unless it is a KDE shortcut and has not been confirmed. */
  const offer = async (next: string, confirmed = false) => {
    if (!confirmed) {
      const shortcut = await window.deckhand.findSystemShortcut(next);
      if (shortcut) {
        setMode({ kind: 'confirm', combo: next, shortcut });
        return;
      }
    }
    if (await run({ kind: 'setAction', at, action: { type: 'hotkey', keys: next } })) setMode({ kind: 'view' });
  };

  // Listening: every key event is read and swallowed before anything else sees it.
  useEffect(() => {
    if (mode.kind !== 'listening') return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keyup') {
        const released = captureKey(event);
        if (released.kind === 'modifier') {
          setMode((m) => (m.kind === 'listening' ? { ...m, held: m.held.filter((h) => h !== released.modifier) } : m));
        }
        return;
      }
      if (event.repeat) return;
      // Every key records, Esc included — it is a real binding (close a
      // window, open a menu). Only the Cancel button stops listening (the maintainer,
      // 2026-09-15).
      const captured = captureKey(event);
      if (captured.kind === 'modifier') {
        // Shown by code: a modifier's own keydown may not carry its flag (Meta's does not, scope §10).
        setMode((m) => (m.kind === 'listening' && !m.held.includes(captured.modifier) ? { ...m, held: [...m.held, captured.modifier] } : m));
      } else if (captured.kind === 'unknown') {
        setMode((m) => (m.kind === 'listening' ? { ...m, message: `That key (${captured.code}) has no name Deckhand can send. Use Type manually.` } : m));
      } else {
        void offer(captured.combo);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
    // Re-subscribed only when the mode changes. `offer` from this render is
    // enough: it reads `at`, which cannot change — the component is keyed by it.
  }, [mode.kind]);

  const submitTyped = () => {
    if (mode.kind !== 'typing') return;
    try {
      void offer(canonicalCombo(mode.text));
    } catch (err) {
      setMode({ ...mode, error: (err as Error).message });
    }
  };

  const remapped = (c: string) => LAYOUT_REMAPPED_KEYS.has(c.split('+').pop()!);

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

      {tab === 'icon' && (
        <IconPicker at={at} button={button} editingBlocked={editingBlocked} canPreview={canPreview} place={place} onPlace={onPlace} />
      )}

      {tab === 'key' && (editable ? (
        <section className="inspector-section">
          <h3 className="section-heading">Hotkey</h3>

          {mode.kind === 'view' && (
            <>
              {combo ? <Keycaps combo={combo} /> : <p className="muted">No hotkey.</p>}
              {combo && savedShortcut && (
                <p className="warning-text">
                  {keycaps(combo).join('+')} is a system shortcut ({savedShortcut.component}).
                </p>
              )}
              {combo && remapped(combo) && <RemapNote combo={combo} />}
              <div className="button-row">
                <button className="primary" disabled={editingBlocked} onClick={() => setMode({ kind: 'listening', held: [], message: null })}>
                  {combo ? 'Re-record' : 'Record hotkey'}
                </button>
                <button disabled={editingBlocked} onClick={() => setMode({ kind: 'typing', text: combo ?? '', error: null })}>
                  Type manually
                </button>
                {combo && (
                  <button disabled={editingBlocked} onClick={() => void run({ kind: 'removeAction', at })}>
                    Clear hotkey
                  </button>
                )}
              </div>
            </>
          )}

          {mode.kind === 'listening' && (
            <div className="listening" role="status">
              <p>Press the key combination…</p>
              <div className="keycaps">
                {MODIFIER_ORDER.filter((m) => mode.held.includes(m)).map((m) => (
                  <kbd key={m}>{keycaps(m)[0]}</kbd>
                ))}
                <span className="listening-dot">listening</span>
              </div>
              {mode.message && <p className="warning-text">{mode.message}</p>}
              <p className="muted small">Every key records, Esc included — click Cancel to stop. Combos KDE uses for itself never arrive here — use Type manually.</p>
              <div className="button-row">
                <button onClick={() => setMode({ kind: 'typing', text: '', error: null })}>Type manually</button>
                <button onClick={() => setMode({ kind: 'view' })}>Cancel</button>
              </div>
            </div>
          )}

          {mode.kind === 'typing' && (
            <div className="typing">
              <input
                autoFocus
                aria-label="Key combination"
                placeholder="e.g. ctrl+1"
                value={mode.text}
                onChange={(e) => setMode({ kind: 'typing', text: e.target.value, error: null })}
                onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') submitTyped();
                  if (e.key === 'Escape') setMode({ kind: 'view' });
                }}
              />
              {mode.error && <p className="field-error">{mode.error}</p>}
              <p className="muted small">Names like ctrl, shift, alt, meta, f1–f24, a–z, 0–9, - = [ ] ; ' ` , . /, space, enter, esc, up, pageup, kp1, mute, playpause — joined with +.</p>
              <div className="button-row">
                <button className="primary" onClick={submitTyped}>
                  Save
                </button>
                <button onClick={() => setMode({ kind: 'view' })}>Cancel</button>
              </div>
            </div>
          )}

          {mode.kind === 'confirm' && (
            <div className="confirm" role="alertdialog" aria-label="System shortcut">
              <p>
                {keycaps(mode.combo).join('+')} is a system shortcut ({mode.shortcut.component}). Use it anyway?
              </p>
              <div className="button-row">
                <button className="primary" onClick={() => void offer(mode.combo, true)}>
                  Use it anyway
                </button>
                <button onClick={() => setMode({ kind: 'listening', held: [], message: null })}>Choose another</button>
              </div>
            </div>
          )}
        </section>
      ) : (
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
      ))}

      {tab === 'key' && (
        <section className="inspector-section">
          <h3 className="section-heading">Label</h3>
          <LabelField label={button?.label ?? ''} disabled={editingBlocked} onSave={(label) => void run({ kind: 'setLabel', at, label })} />
        </section>
      )}

      {tab === 'key' && button?.icon !== undefined && (
        <section className="inspector-section">
          <h3 className="section-heading">Icon</h3>
          <p className="path">{button.icon}</p>
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

function Keycaps({ combo }: { combo: string }) {
  return (
    <div className="keycaps">
      {keycaps(combo).map((cap, i) => (
        <kbd key={i}>{cap}</kbd>
      ))}
    </div>
  );
}

function RemapNote({ combo }: { combo: string }) {
  const key = keycaps(combo).pop();
  return <p className="muted small">{key} may not reach the game: the keyboard layout can turn it into another key.</p>;
}

/** Saves when typing pauses, on Enter, and on leaving the field. An empty label removes it. */
function LabelField({ label, disabled, onSave }: { label: string; disabled: boolean; onSave: (label: string) => void }) {
  const [text, setText] = useState(label);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  // A label changed elsewhere (a reload, an outside edit) shows here — but not
  // while typing, when the saved value is just this field's own autosave.
  useEffect(() => {
    if (!focused.current) setText(label);
  }, [label]);
  const save = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value !== label) onSave(value);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <input
      className="label-input"
      aria-label="Label"
      placeholder="No label"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const value = e.target.value;
        setText(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(value), 400);
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
