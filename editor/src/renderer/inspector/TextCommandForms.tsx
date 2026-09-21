import { useEffect, useRef, useState } from 'react';
import { formatDuration, textDurationMs } from '../../shared/durations.js';
import { TextSetting, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * Type text and Run command: both are one piece of text.
 */

/**
 * text: typed with the US layout (src/keymap.ts). A character that layout
 * cannot type is refused here rather than saved, since the daemon would refuse
 * the whole press. Shows roughly how long typing takes: capitals and shifted
 * symbols get the game-safe combo timing.
 */
export function TextForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('text', button);
  const saved = typeof action?.text === 'string' ? action.text : '';
  const [text, setText] = useState(saved);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setText(saved);
  }, [saved]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const duration = textDurationMs(text);
  const save = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (textDurationMs(next) === null) return; // shown below; never saved
    // Nothing typed into a key that is not a text key yet: leave it as it is.
    if (action === undefined && next === '') return;
    if (next !== saved || action === undefined) void run({ kind: 'setAction', at, action: nextAction('text', button, { text: next }) });
  };
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Type text</h3>
      <textarea
        className="text-input"
        aria-label="Text to type"
        rows={3}
        placeholder="What the key types"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const next = e.target.value;
          timer.current = setTimeout(() => save(next), 400);
        }}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          save(text);
        }}
      />
      {duration === null ? (
        <p className="field-error">It contains a character the US keyboard layout cannot type, so it is not saved.</p>
      ) : (
        <p className="muted small">
          Typed with the US layout; a new line presses Enter. About {formatDuration(duration)} to type — capitals and shifted symbols take about 0.15 s each.
        </p>
      )}
    </section>
  );
}

/** command: a shell command, started detached so the key never waits for it. */
export function CommandForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('command', button);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Run command</h3>
      <TextSetting
        label="Command"
        value={typeof action?.command === 'string' ? action.command : ''}
        placeholder="e.g. kate ~/notes.md"
        disabled={disabled}
        onSave={(v) => void run({ kind: 'setAction', at, action: nextAction('command', button, { command: v.trim() === '' ? undefined : v }) })}
      />
      <p className="muted small">Run with sh, in the background: the key does not wait for it to finish, and its output is not shown.</p>
    </section>
  );
}
