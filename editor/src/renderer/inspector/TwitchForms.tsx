import { useEffect, useRef, useState } from 'react';
import { actionOf, nextAction, type FormProps } from './controls.js';

/**
 * Twitch keys (scope §7): each sends one request as the linked account, on
 * its own channel.
 */

/** Twitch's own limit on a chat message, counted as the daemon counts it. */
const MAX_CHAT = 500;
const length = (text: string) => [...text].length;

/**
 * twitch.chat: the message, written here. Over Twitch's limit it is shown
 * and never saved — the daemon would refuse every press of it.
 */
export function TwitchChatForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('twitch.chat', button);
  const saved = typeof action?.message === 'string' ? action.message : '';
  const [message, setMessage] = useState(saved);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setMessage(saved);
  }, [saved]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const save = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (length(next) > MAX_CHAT) return; // shown below; never saved
    // Nothing written into a key that is not a chat key yet: leave it as it is.
    if (action === undefined && next === '') return;
    if (next !== saved || action === undefined) void run({ kind: 'setAction', at, action: nextAction('twitch.chat', button, { message: next === '' ? undefined : next }) });
  };
  const count = length(message);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Chat message</h3>
      <textarea
        className="text-input"
        aria-label="Chat message"
        rows={3}
        placeholder="What the key says in your chat"
        value={message}
        disabled={disabled}
        onChange={(e) => {
          setMessage(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const next = e.target.value;
          timer.current = setTimeout(() => save(next), 400);
        }}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          save(message);
        }}
      />
      {count > MAX_CHAT ? (
        <p className="field-error">
          {count} characters: Twitch takes up to {MAX_CHAT}, so it is not saved.
        </p>
      ) : (
        <p className="muted small">
          Sent to your own channel&apos;s chat, as your linked Twitch account, live or not. {count}/{MAX_CHAT}
        </p>
      )}
    </section>
  );
}
