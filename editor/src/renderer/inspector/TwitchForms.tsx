import { useEffect, useRef, useState } from 'react';
import type { TwitchList } from '../../../../src/control/protocol.js';
import { NumberSetting, Row, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * Twitch keys (scope §7): each sends one request as the linked account, on
 * its own channel. Text is limited as Twitch limits it, counted as the
 * daemon counts it; a category is **picked from Twitch's own search, never
 * typed**, as OBS's and VTube Studio's pickers are.
 */

const length = (text: string) => [...text].length;

/**
 * Text saved when typing pauses and on leaving the field, as the Text key's
 * is. Over `max` it is shown and never saved — the daemon would refuse every
 * press of it. Empty removes the field.
 */
function LimitedText({
  label,
  value,
  max,
  placeholder,
  multiline,
  disabled,
  hint,
  onSave,
}: {
  label: string;
  value: string;
  max: number;
  placeholder: string;
  multiline?: boolean;
  disabled: boolean;
  hint: string;
  onSave: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const save = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (length(next) > max) return; // shown below; never saved
    if (next !== value) onSave(next === '' ? undefined : next);
  };
  const props = {
    'aria-label': label,
    placeholder,
    value: text,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      if (timer.current) clearTimeout(timer.current);
      const next = e.target.value;
      timer.current = setTimeout(() => save(next), 400);
    },
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      save(text);
    },
  };
  const count = length(text);
  return (
    <>
      {multiline ? <textarea className="text-input" rows={3} {...props} /> : <input className="text-input" {...props} onKeyDown={(e) => e.key === 'Enter' && save(text)} />}
      {count > max ? (
        <p className="field-error" data-twitch-over={label}>
          {count} characters: Twitch takes up to {max}, so it is not saved.
        </p>
      ) : (
        <p className="muted small">
          {hint} {count}/{max}
        </p>
      )}
    </>
  );
}

/** twitch.chat: the message. */
export function TwitchChatForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('twitch.chat', button);
  const saved = typeof action?.message === 'string' ? action.message : '';
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Chat message</h3>
      <LimitedText
        label="Chat message"
        value={saved}
        max={500}
        multiline
        placeholder="What the key says in your chat"
        disabled={disabled}
        hint="Sent to your own channel's chat, as your linked Twitch account, live or not."
        onSave={(message) => {
          // Nothing written into a key that is not a chat key yet: leave it as it is.
          if (action === undefined && message === undefined) return;
          void run({ kind: 'setAction', at, action: nextAction('twitch.chat', button, { message }) });
        }}
      />
    </section>
  );
}

/** twitch.marker: an optional description, to find the moment again. */
export function TwitchMarkerForm({ at, button, disabled, run }: FormProps) {
  // Needs nothing set: a library pick writes the key at once (Inspector).
  const action = actionOf('twitch.marker', button);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Stream marker</h3>
      <LimitedText
        label="Marker description"
        value={typeof action?.description === 'string' ? action.description : ''}
        max={140}
        placeholder="Optional: what happened here"
        disabled={disabled}
        hint="Marks this moment of a live stream, to find it again in the VOD. Needs Store past broadcasts on."
        onSave={(description) => void run({ kind: 'setAction', at, action: nextAction('twitch.marker', button, { description }) })}
      />
    </section>
  );
}

/** Twitch's default clip length: left out of the config, so Twitch decides. */
const DEFAULT_CLIP_S = 30;

/** twitch.clip: an optional title, and how long. */
export function TwitchClipForm({ at, button, disabled, run }: FormProps) {
  // Needs nothing set: a library pick writes the key at once (Inspector).
  const action = actionOf('twitch.clip', button);
  const duration = typeof action?.duration === 'number' ? action.duration : DEFAULT_CLIP_S;
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Clip</h3>
      <LimitedText
        label="Clip title"
        value={typeof action?.title === 'string' ? action.title : ''}
        max={140}
        placeholder="Optional: Twitch gives one if left empty"
        disabled={disabled}
        hint="Clips the live stream as your linked account."
        onSave={(title) => void run({ kind: 'setAction', at, action: nextAction('twitch.clip', button, { title }) })}
      />
      <Row name="Length">
        <NumberSetting
          label="Clip length in seconds"
          value={duration}
          min={5}
          max={60}
          disabled={disabled}
          onSave={(n) => void run({ kind: 'setAction', at, action: nextAction('twitch.clip', button, { duration: n === DEFAULT_CLIP_S ? undefined : n }) })}
        />
        <span className="muted small">seconds, ending at the press</span>
      </Row>
      <p className="muted small">Twitch makes the clip in the background: a clip it fails to make later is not reported.</p>
    </section>
  );
}

/** Twitch's categories for a search, asked through the daemon once typing pauses. Null while asking, or before a search. */
function useCategorySearch(query: string): TwitchList | null {
  const [list, setList] = useState<TwitchList | null>(null);
  useEffect(() => {
    setList(null);
    const q = query.trim();
    if (length(q) < 2) return;
    let alive = true;
    const timer = setTimeout(() => void window.deckhand.twitchCategories(q).then((l) => alive && setList(l)), 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  return list;
}

/** twitch.streamInfo: a title, a category, or both — either left as it is on Twitch. */
export function TwitchStreamInfoForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('twitch.streamInfo', button);
  const category = typeof action?.category === 'string' && action.category !== '' ? action.category : null;
  const categoryName = typeof action?.categoryName === 'string' && action.categoryName !== '' ? action.categoryName : null;
  const [query, setQuery] = useState('');
  const found = useCategorySearch(query);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('twitch.streamInfo', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Stream info</h3>
      <LimitedText
        label="Stream title"
        value={typeof action?.title === 'string' ? action.title : ''}
        max={140}
        placeholder="Leave empty to keep the title as it is"
        disabled={disabled}
        hint="Set on your channel when the key is pressed, live or not."
        onSave={(title) => {
          if (action === undefined && title === undefined) return;
          write({ title });
        }}
      />
      <Row name="Category">
        <span className="target-name" data-twitch-category={category ?? ''}>
          {category ? (categoryName ?? category) : 'Left as it is'}
        </span>
        {category && (
          <button className="link-button" disabled={disabled} onClick={() => write({ category: undefined, categoryName: undefined })} data-twitch="keep-category">
            Leave as it is
          </button>
        )}
      </Row>
      <input
        className="text-input"
        aria-label="Search Twitch's categories"
        placeholder="Search Twitch's categories…"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        data-twitch-field="category-search"
      />
      {found && !found.ok && <p className="muted small">{found.message}</p>}
      {found?.ok && found.items.length === 0 && <p className="muted small">Twitch has no category matching that.</p>}
      {found?.ok && found.items.length > 0 && (
        <ul className="target-list" data-twitch-picker="category">
          {found.items.map((item) => (
            <li key={item.id}>
              <button
                className={category === item.id ? 'target target-selected' : 'target'}
                disabled={disabled}
                onClick={() => {
                  write({ category: item.id, categoryName: item.name });
                  setQuery('');
                }}
                data-twitch-id={item.id}
              >
                <span className="target-name">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
