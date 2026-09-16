import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ButtonDef } from '../../../src/types.js';
import type { SystemShortcut } from '../shared/bridge.js';
import type { ButtonLocation, Edit, IconChoice } from '../shared/edits.js';
import { LAYOUT_REMAPPED_KEYS, MODIFIER_ORDER, canonicalCombo, captureKey, keycaps, type Modifier } from '../shared/keys.js';
import { actionName } from './catalogue.js';
import { EMPTY_PLACE, IconPicker, type PickerPlace } from './IconPicker.js';
import { actionEditable, describeAction, keyKind, type Choice } from './model.js';

interface Props {
  at: ButtonLocation | null;
  button: ButtonDef | undefined;
  editingBlocked: boolean;
  /** Bumped when a library entry is clicked: configure the key as that action. */
  pick: { type: string; token: number } | null;
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
export function Inspector({ at, button, editingBlocked, pick, pages, profiles, coverage, labelDefaults, canPreview, apply }: Props) {
  // Kept here, outside the per-key component, so the tab and the picker's
  // folder stay put while moving from key to key in a setup burst.
  const [tab, setTab] = useState<Tab>('key');
  const [place, setPlace] = useState<PickerPlace>(EMPTY_PLACE);
  // Picking an action from the library means the Key tab.
  const firstToken = useRef(pick?.token ?? 0);
  useEffect(() => {
    if ((pick?.token ?? 0) !== firstToken.current) setTab('key');
  }, [pick?.token]);

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
      pick={pick}
      pages={pages}
      profiles={profiles}
      coverage={coverage}
      labelDefaults={labelDefaults}
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

function KeyInspector({ at, button, editingBlocked, pick, pages, profiles, coverage, labelDefaults, canPreview, apply, tab, onTab, place, onPlace }: KeyInspectorProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
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
  const combo = button?.action?.type === 'hotkey' && typeof button.action.keys === 'string' ? button.action.keys : null;

  // A library pick configures the key as that action (not on first render).
  const firstToken = useRef(pick?.token ?? 0);
  useEffect(() => {
    if (pick === null || pick.token === firstToken.current || editingBlocked) return;
    if (!actionEditable(button, pick.type)) return;
    setChosen(pick.type);
    // Hotkey is the one that starts doing something at once: it listens.
    if (pick.type === 'hotkey') setMode({ kind: 'listening', held: [], message: null });
  }, [pick?.token]);

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

      {tab === 'key' && editable && type === 'page' && (
        <PageAction at={at} action={button?.action} pages={pages} disabled={editingBlocked} run={run} />
      )}

      {tab === 'key' && editable && type === 'profile' && (
        <ProfileAction at={at} action={button?.action} profiles={profiles} coverage={coverage} disabled={editingBlocked} run={run} />
      )}

      {tab === 'key' && (editable && type === 'hotkey' ? (
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
      ) : editable && (type === 'page' || type === 'profile') ? null : (
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

/**
 * "Go to page" (scope §10): a plain list of page names in this deck's layout,
 * not the mockups' thumbnails, plus Back. The target is written as the page's
 * ID, so renaming a page never breaks the link (scope §5) — but a link
 * hand-written as a name is still recognised here, since that is how the
 * daemon resolves it.
 */
function PageAction({
  at,
  action,
  pages,
  disabled,
  run,
}: {
  at: ButtonLocation;
  action: ButtonDef['action'];
  pages: Choice[];
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const back = action?.type === 'page' && action.back === true;
  const to = action?.type === 'page' && typeof action.to === 'string' ? action.to : null;
  const target = to === null ? null : (pages.find((p) => p.id === to) ?? pages.find((p) => p.label === to))?.id ?? null;
  const missing = to !== null && target === null;

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Go to page</h3>
      <div className="button-row">
        <button
          className={back ? '' : 'primary'}
          disabled={disabled || !back}
          onClick={() => void run({ kind: 'removeAction', at })}
        >
          A page
        </button>
        <button
          className={back ? 'primary' : ''}
          disabled={disabled || back}
          onClick={() => void run({ kind: 'setAction', at, action: { type: 'page', back: true } })}
        >
          Back
        </button>
      </div>

      {back ? (
        <p className="muted small">Returns to whatever page this deck came from. Nothing to choose.</p>
      ) : (
        <>
          {pages.length === 0 && <p className="muted small">This deck has no other pages in this profile yet.</p>}
          <ul className="target-list">
            {pages.map((p) => (
              <li key={p.id}>
                <button
                  className={p.id === target ? 'target target-selected' : 'target'}
                  disabled={disabled}
                  onClick={() => void run({ kind: 'setAction', at, action: { type: 'page', to: p.id } })}
                >
                  {p.label}
                  {p.id === at.page ? ' — this page' : ''}
                </button>
              </li>
            ))}
          </ul>
          {missing && (
            <p className="warning-text">
              This key points at “{to}”, which is not a page on this deck. Pressing it does nothing.
            </p>
          )}
          {target === null && !missing && <p className="muted small">Pick the page this key should show.</p>}
        </>
      )}
    </section>
  );
}

/**
 * "Switch profile": a list of profiles, each saying which decks it changes.
 * §2 records that the maintainer never discovered profiles in StreamController, so the
 * key that switches them has to state plainly that it moves both decks — and
 * warn when one it does not cover is plugged in, which keeps its old layout
 * (scope §3).
 */
function ProfileAction({
  at,
  action,
  profiles,
  coverage,
  disabled,
  run,
}: {
  at: ButtonLocation;
  action: ButtonDef['action'];
  profiles: Choice[];
  coverage: (profile: string) => { covered: string[]; uncoveredConnected: string[] };
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const to = action?.type === 'profile' && typeof action.to === 'string' ? action.to : null;
  const target = to === null ? null : (profiles.find((p) => p.id === to) ?? profiles.find((p) => p.label === to))?.id ?? null;
  const uncovered = target === null ? [] : coverage(target).uncoveredConnected;

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Switch profile</h3>
      <ul className="target-list">
        {profiles.map((p) => {
          const { covered } = coverage(p.id);
          return (
            <li key={p.id}>
              <button
                className={p.id === target ? 'target target-selected' : 'target'}
                disabled={disabled}
                onClick={() => void run({ kind: 'setAction', at, action: { type: 'profile', to: p.id } })}
              >
                <span className="target-name">
                  {p.label}
                  {p.id === at.profile ? ' — the one you are editing' : ''}
                </span>
                <span className="target-note">
                  {covered.length === 0 ? 'covers no deck' : `changes ${covered.join(' and ')}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {to !== null && target === null && (
        <p className="warning-text">This key points at “{to}”, which is not a profile. Pressing it does nothing.</p>
      )}
      {uncovered.length > 0 && (
        <p className="warning-text">
          {uncovered.join(' and ')} {uncovered.length === 1 ? 'is' : 'are'} plugged in but not covered by this profile, so{' '}
          {uncovered.length === 1 ? 'it keeps' : 'they keep'} whatever {uncovered.length === 1 ? 'layout it has' : 'layouts they have'}.
        </p>
      )}
      {target === null && to === null && <p className="muted small">Pick the profile this key should switch to.</p>}
    </section>
  );
}

const POSITIONS: ReadonlyArray<{ value: 'top' | 'center' | 'bottom'; label: string }> = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom', label: 'Bottom' },
];

/**
 * Where the label sits, what colour it is and how big — all three already
 * supported by `src/render.ts` and the v0.1 schema; this is the UI that was
 * missing. A field the key does not set is shown as inherited from `defaults`
 * in config, and "Reset" removes it again rather than writing the default
 * value in, so the config diff stays small and a later change to `defaults`
 * still reaches the key.
 */
function LabelStyle({
  at,
  button,
  defaults,
  disabled,
  run,
}: {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  defaults: { labelPosition: 'top' | 'bottom' | 'center'; labelColor: string; labelSize: number };
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const position = button?.labelPosition ?? defaults.labelPosition;
  const colour = button?.labelColor ?? defaults.labelColor;
  const size = button?.labelSize ?? defaults.labelSize;
  const set = (field: 'labelPosition' | 'labelColor' | 'labelSize', value: string | number | null) =>
    void run({ kind: 'setLabelStyle', at, field, value });
  const inherited = (field: 'labelPosition' | 'labelColor' | 'labelSize') => button?.[field] === undefined;

  return (
    <div className="label-style">
      <div className="label-style-row">
        <span className="label-style-name">Position</span>
        <div className="segmented" role="group" aria-label="Label position">
          {POSITIONS.map((p) => (
            <button
              key={p.value}
              className={p.value === position ? 'segment segment-selected' : 'segment'}
              disabled={disabled}
              aria-pressed={p.value === position}
              onClick={() => set('labelPosition', p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="label-style-row">
        <span className="label-style-name">Colour</span>
        <input
          type="color"
          aria-label="Label colour"
          className="colour-well"
          value={/^#[0-9a-fA-F]{6}$/.test(colour) ? colour : '#ffffff'}
          disabled={disabled}
          onChange={(e) => set('labelColor', e.target.value)}
        />
        <span className="label-style-value">{colour}</span>
      </div>

      <div className="label-style-row">
        <span className="label-style-name">Size</span>
        <input
          type="number"
          aria-label="Label size"
          className="size-input"
          min={6}
          max={72}
          value={size}
          disabled={disabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next > 0) set('labelSize', next);
          }}
        />
        <span className="label-style-value">px</span>
      </div>

      <div className="label-style-row">
        <button
          className="link-button"
          disabled={disabled || (inherited('labelPosition') && inherited('labelColor') && inherited('labelSize'))}
          title="Remove these from the key, so it follows the defaults in config.json again"
          onClick={() => {
            set('labelPosition', null);
            set('labelColor', null);
            set('labelSize', null);
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

/**
 * A button's icon has three states and they are not interchangeable
 * (scope §10): absent means "use the action's built-in default", null means
 * "deliberately none — label only", and a string is that file. They are shown
 * as one segmented control rather than two buttons, because **the state has to
 * be visible rather than inferred from which control was pressed last** (the maintainer,
 * 2026-09-16) — and until phase C's defaults land, Default and None draw the
 * same blank key on the hardware, so the sub-line is the only thing telling
 * them apart.
 *
 * No segment is ever disabled (the maintainer, 2026-09-16): going from a file to
 * "deliberately none" must be one click, not clear-then-tick. Choosing None
 * with a file set discards the path, which is what was asked for.
 */
function IconState({
  button,
  disabled,
  onChoose,
  onBrowse,
}: {
  button: ButtonDef | undefined;
  disabled: boolean;
  onChoose: (icon: IconChoice) => void;
  onBrowse: () => void;
}) {
  // Absent, null and a string are three different things; `in` distinguishes
  // the first two, which `?.` and `??` cannot.
  const hasKey = button !== undefined && 'icon' in button;
  const path = typeof button?.icon === 'string' ? button.icon : null;
  const state: IconChoice['kind'] = path !== null ? 'file' : hasKey ? 'none' : 'default';

  return (
    <div className="icon-state">
      <div className="segmented" role="group" aria-label="Icon">
        <button
          className={state === 'default' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'default'}
          disabled={disabled}
          onClick={() => onChoose({ kind: 'default' })}
        >
          Default
        </button>
        <button
          className={state === 'none' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'none'}
          disabled={disabled}
          onClick={() => onChoose({ kind: 'none' })}
        >
          None
        </button>
        <button
          className={state === 'file' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'file'}
          disabled={disabled}
          onClick={onBrowse}
        >
          This file
        </button>
      </div>

      {state === 'default' && (
        <p className="muted small">
          {/* Honest about the gap rather than implying an icon will appear. */}
          No icon chosen. Nothing renders yet — built-in default icons arrive in phase C.
        </p>
      )}
      {state === 'none' && <p className="muted small">Label only — no icon, now or after phase C.</p>}
      {state === 'file' && (
        <>
          <p className="path">{path}</p>
          <button className="link-button" disabled={disabled} onClick={onBrowse}>
            Choose a different icon…
          </button>
        </>
      )}
    </div>
  );
}
