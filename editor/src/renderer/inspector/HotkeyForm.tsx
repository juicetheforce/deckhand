import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ButtonDef } from '../../../../src/types.js';
import type { SystemShortcut } from '../../shared/bridge.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import { NumberSetting, Row, nextAction } from './controls.js';
import { LAYOUT_REMAPPED_KEYS, MODIFIER_ORDER, canonicalCombo, captureKey, keycaps, loneModifierCombo, type Modifier } from '../../shared/keys.js';
import { keyCapture } from '../key-capture.js';

type Mode =
  | { kind: 'view' }
  | { kind: 'listening'; held: Modifier[]; message: string | null }
  | { kind: 'typing'; text: string; error: string | null }
  | { kind: 'confirm'; combo: string; shortcut: SystemShortcut };

interface ListenProps {
  /** Start listening: set by a library pick, handed back with `onListening` once taken. */
  listenRequest: boolean;
  onListening: () => void;
}

/**
 * The hotkey inspector: record by pressing the combo, Type
 * manually, Re-record and Clear hotkey — plus hold and repeat. A hotkey
 * sequence (`keys` as a list) and `gapMs` stay read-only: Multi action does
 * sequences.
 */
export function HotkeyForm({ at, button, editingBlocked, run, listenRequest, onListening }: { at: ButtonLocation; button: ButtonDef | undefined; editingBlocked: boolean; run: (edit: Edit) => Promise<boolean> } & ListenProps) {
  const action = button?.action?.type === 'hotkey' ? button.action : undefined;
  const combo = typeof action?.keys === 'string' ? action.keys : null;
  const write = (patch: Record<string, unknown>) => run({ kind: 'setAction', at, action: nextAction('hotkey', button, patch) });
  return (
    <ComboCapture
      heading="Hotkey"
      combo={combo}
      editingBlocked={editingBlocked}
      save={(keys) => write({ keys })}
      clear={() => void run({ kind: 'removeAction', at })}
      clearLabel="Clear hotkey"
      listenRequest={listenRequest}
      onListening={onListening}
    >
      {combo && (
        <>
          <Row name="Hold for">
            <NumberSetting label="Hold for" value={typeof action?.holdMs === 'number' ? action.holdMs : 0} min={0} max={10000} disabled={editingBlocked} onSave={(n) => void write({ holdMs: n === 0 ? undefined : n })} />
            <span className="form-value">ms (0: a normal press)</span>
          </Row>
          <Row name="Repeat">
            <NumberSetting label="Repeat" value={typeof action?.repeat === 'number' ? action.repeat : 1} min={1} max={50} disabled={editingBlocked} onSave={(n) => void write({ repeat: n === 1 ? undefined : n })} />
            <span className="form-value">times</span>
          </Row>
        </>
      )}
    </ComboCapture>
  );
}

/**
 * Recording one key combo: press it, or Type manually; KDE-shortcut and layout
 * warnings. Used by the hotkey and Press/Release forms, which say what saving
 * and clearing write.
 *
 * Mounted only while the Key tab shows, so listening — which swallows every
 * key — can never carry on out of sight on another tab: leaving the tab
 * unmounts this, and the listening effect's cleanup stands the capture down.
 * `listenRequest` is handed back once taken, so remounting (coming back from
 * the Icon tab) does not start listening again.
 */
export function ComboCapture({
  heading,
  combo,
  editingBlocked,
  save,
  clear,
  clearLabel,
  recordLoneModifiers = false,
  listenRequest,
  onListening,
  children,
}: {
  heading: string;
  combo: string | null;
  editingBlocked: boolean;
  /** Write the combo; resolves false if the edit was refused. */
  save: (combo: string) => Promise<boolean>;
  clear: () => void;
  clearLabel: string;
  /**
   * Modifiers pressed and let go with no other key between them are recorded
   * as the combo (keys.ts loneModifierCombo). Press/Release only: holding
   * Shift alone is a real binding there, while for a hotkey a modifier going
   * down is the start of a combo.
   */
  recordLoneModifiers?: boolean;
  /** Shown under the buttons while not recording. */
  children?: ReactNode;
} & ListenProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'view' });

  useEffect(() => {
    if (!listenRequest) return;
    setMode({ kind: 'listening', held: [], message: null });
    onListening();
  }, [listenRequest]);

  const [savedShortcut, setSavedShortcut] = useState<SystemShortcut | null>(null);
  useEffect(() => {
    let alive = true;
    setSavedShortcut(null);
    if (combo) void window.deckhand.findSystemShortcut(combo).then((s) => alive && setSavedShortcut(s));
    return () => {
      alive = false;
    };
  }, [combo]);

  /** Save a combo, unless it is a KDE shortcut and has not been confirmed. */
  const offer = async (next: string, confirmed = false) => {
    if (!confirmed) {
      const shortcut = await window.deckhand.findSystemShortcut(next);
      if (shortcut) {
        setMode({ kind: 'confirm', combo: next, shortcut });
        return;
      }
    }
    if (await save(next)) setMode({ kind: 'view' });
  };

  // Listening: every key event is read and swallowed before anything else sees it.
  useEffect(() => {
    if (mode.kind !== 'listening') return;
    // For recordLoneModifiers: the modifier keys pressed since every key was
    // last up, in order; whether any other key went down among them; and which
    // keys are down now, by code, so left and right are told apart.
    let chord: string[] = [];
    let spoiled = false;
    const down = new Set<string>();
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keyup') {
        const released = captureKey(event);
        if (released.kind === 'modifier') {
          setMode((m) => (m.kind === 'listening' ? { ...m, held: m.held.filter((h) => h !== released.modifier) } : m));
        }
        down.delete(event.code);
        if (recordLoneModifiers && down.size === 0) {
          const lone = spoiled ? null : loneModifierCombo(chord);
          chord = [];
          spoiled = false;
          if (lone) void offer(lone);
        }
        return;
      }
      if (event.repeat) return;
      down.add(event.code);
      // Every key records, Esc included — it is a real binding (close a
      // window, open a menu). Only the Cancel button stops listening.
      const captured = captureKey(event);
      if (captured.kind === 'modifier') {
        if (!chord.includes(event.code)) chord.push(event.code);
        // Shown by code: a modifier's own keydown may not carry its flag (Meta's does not).
        setMode((m) => (m.kind === 'listening' && !m.held.includes(captured.modifier) ? { ...m, held: [...m.held, captured.modifier] } : m));
      } else if (captured.kind === 'unknown') {
        spoiled = true;
        setMode((m) => (m.kind === 'listening' ? { ...m, message: `That key (${captured.code}) has no name Deckhand can send. Use Type manually.` } : m));
      } else {
        spoiled = true;
        void offer(captured.combo);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    // The grid's bulk shortcuts stand down while this records (key-capture.ts).
    keyCapture.active = true;
    return () => {
      keyCapture.active = false;
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
    <section className="inspector-section">
      <h3 className="section-heading">{heading}</h3>

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
              <button disabled={editingBlocked} onClick={clear}>
                {clearLabel}
              </button>
            )}
          </div>
          {children}
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
          {recordLoneModifiers && <p className="muted small">A modifier on its own — Shift, say — records when you let go of it.</p>}
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

/**
 * Press/Release: the key held while the deck key is held. Written
 * as a pair — `keyHold` down as the press action, `keyHold` up with the same
 * keys as the release action — which is what the daemon runs (a hand-written
 * `keyHold` down with no release would hold the key forever).
 */
export function PressReleaseForm({ at, button, editingBlocked, run, listenRequest, onListening }: { at: ButtonLocation; button: ButtonDef | undefined; editingBlocked: boolean; run: (edit: Edit) => Promise<boolean> } & ListenProps) {
  const combo = button?.action?.type === 'keyHold' && typeof button.action.keys === 'string' && button.action.keys !== '' ? button.action.keys : null;
  return (
    <ComboCapture
      heading="Press / Release"
      combo={combo}
      editingBlocked={editingBlocked}
      save={(keys) => run({ kind: 'setPressRelease', at, keys })}
      clear={() => void run({ kind: 'setPressRelease', at, keys: null })}
      clearLabel="Clear"
      recordLoneModifiers
      listenRequest={listenRequest}
      onListening={onListening}
    >
      <div className="phases">
        <div className="phase">
          <span className="phase-name">On press</span>
          {combo ? <span>hold {keycaps(combo).join('+')} down</span> : <span className="muted">nothing yet</span>}
        </div>
        <div className="phase">
          <span className="phase-name">On release</span>
          {combo ? <span>let {keycaps(combo).join('+')} go</span> : <span className="muted">nothing yet</span>}
        </div>
      </div>
    </ComboCapture>
  );
}

/**
 * Toggle: one combo, latched. Press once and it stays
 * down; press again and it releases. The same capture as Press/Release —
 * including lone modifiers, which is what a latch is usually for — but it
 * writes one action, with no release action: the daemon holds the state and
 * ignores the physical release.
 */
export function ToggleForm({ at, button, editingBlocked, run, listenRequest, onListening }: { at: ButtonLocation; button: ButtonDef | undefined; editingBlocked: boolean; run: (edit: Edit) => Promise<boolean> } & ListenProps) {
  const combo = button?.action?.type === 'toggle' && typeof button.action.keys === 'string' && button.action.keys !== '' ? button.action.keys : null;
  return (
    <ComboCapture
      heading="Toggle"
      combo={combo}
      editingBlocked={editingBlocked}
      save={(keys) => run({ kind: 'setAction', at, action: { type: 'toggle', keys } })}
      clear={() => void run({ kind: 'removeAction', at })}
      clearLabel="Clear"
      recordLoneModifiers
      listenRequest={listenRequest}
      onListening={onListening}
    >
      <div className="phases">
        <div className="phase">
          <span className="phase-name">First press</span>
          {combo ? <span>hold {keycaps(combo).join('+')} down</span> : <span className="muted">nothing yet</span>}
        </div>
        <div className="phase">
          <span className="phase-name">Next press</span>
          {combo ? <span>let {keycaps(combo).join('+')} go</span> : <span className="muted">nothing yet</span>}
        </div>
      </div>
      <p className="muted small">
        It stays down while you do other things — leaving the page, switching profile or unplugging the deck releases it.
      </p>
    </ComboCapture>
  );
}
