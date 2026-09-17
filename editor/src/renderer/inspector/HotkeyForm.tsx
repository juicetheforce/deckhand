import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ButtonDef } from '../../../../src/types.js';
import type { SystemShortcut } from '../../shared/bridge.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import { LAYOUT_REMAPPED_KEYS, MODIFIER_ORDER, canonicalCombo, captureKey, keycaps, type Modifier } from '../../shared/keys.js';
import { keyCapture } from '../key-capture.js';

type Mode =
  | { kind: 'view' }
  | { kind: 'listening'; held: Modifier[]; message: string | null }
  | { kind: 'typing'; text: string; error: string | null }
  | { kind: 'confirm'; combo: string; shortcut: SystemShortcut };

/**
 * The hotkey inspector (scope §10): record by pressing the combo, Type
 * manually, Re-record and Clear hotkey.
 *
 * Mounted only while the Key tab shows, so listening — which swallows every
 * key — can never carry on out of sight on another tab: leaving the tab
 * unmounts this, and the listening effect's cleanup stands the capture down.
 *
 * `listenRequest` starts listening: set by a library pick of Hotkey, and
 * handed back with `onListening` once taken, so remounting (coming back from
 * the Icon tab) does not start listening again.
 */
export function HotkeyForm({
  at,
  button,
  editingBlocked,
  run,
  listenRequest,
  onListening,
}: {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  editingBlocked: boolean;
  run: (edit: Edit) => Promise<boolean>;
  listenRequest: boolean;
  onListening: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const combo = button?.action?.type === 'hotkey' && typeof button.action.keys === 'string' ? button.action.keys : null;

  useEffect(() => {
    if (!listenRequest) return;
    setMode({ kind: 'listening', held: [], message: null });
    onListening();
  }, [listenRequest]);

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
