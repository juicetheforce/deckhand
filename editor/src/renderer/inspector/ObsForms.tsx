import { useEffect, useState } from 'react';
import type { ObsList } from '../../../../src/control/protocol.js';
import { actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The OBS keys (scope §7, "Streaming integrations"). Stream, Record and Pause
 * have nothing to set — what they act on is OBS itself — so their form says
 * what the key does and what it needs. Scene, Mute input and Show/hide source
 * pick what they act on **from OBS's own lists, never typed** (Ryan,
 * 2026-10-01): a mistyped name would only fail later, on the deck. With OBS
 * not running there is nothing to pick from — "Start OBS to choose" — and a
 * saved choice is always kept and shown. The connection is set in Settings ›
 * Integrations › OBS.
 */

const ABOUT: Record<string, { heading: string; text: string }> = {
  'obs.stream': {
    heading: 'Stream',
    text: 'Press to go live. To stop, hold the key for a second: a short press while live does nothing but mark the key, so a stray press never ends a stream. Its icon turns red while live, and amber with broken arcs while OBS is reconnecting.',
  },
  'obs.record': {
    heading: 'Record',
    text: 'Press to start recording, and again to stop. Its icon turns red while recording, and amber while paused.',
  },
  'obs.recordPause': {
    heading: 'Pause recording',
    text: 'Press to pause what Record is recording, and again to resume. Recordings only: OBS cannot pause a stream. OBS cannot pause a recording that shares the stream\'s settings either (Settings › Output › Recording Quality "Same as stream", its default) — the key is marked as failed and says so.',
  },
};

export function ObsForm({ type }: { type: string }) {
  const about = ABOUT[type];
  if (!about) return null;
  return (
    <section className="inspector-section">
      <h3 className="section-heading">{about.heading}</h3>
      <p className="muted small">{about.text}</p>
      <p className="muted small">
        Needs OBS running with its WebSocket server on (OBS: Tools › WebSocket Server Settings), and OBS set up in Deckhand's{' '}
        <button className="link-button" onClick={() => void window.deckhand.openSettings('obs')}>
          Settings › Integrations
        </button>
        .
      </p>
    </section>
  );
}

/** OBS's list for a picker, asked when the form opens, when its scene changes, and on Refresh. Null while asking. */
function useObsList(kind: 'scenes' | 'inputs' | 'sources', scene: string | null, ask: number): ObsList | null {
  const [list, setList] = useState<ObsList | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    if (kind === 'sources' && !scene) return;
    void window.deckhand.obsList(kind, scene ?? undefined).then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, [kind, scene, ask]);
  return list;
}

const nameOf = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * One name from OBS's list. A saved name OBS does not list — renamed or
 * deleted there — is kept, shown first and marked; with OBS not reachable,
 * the saved name is still shown, and nothing else can be picked.
 */
function NamePicker({
  list,
  stored,
  what,
  disabled,
  onChoose,
  onRefresh,
}: {
  list: ObsList | null;
  stored: string | null;
  /** "scene", "input", "source": for the words. */
  what: string;
  disabled: boolean;
  onChoose: (name: string) => void;
  onRefresh: () => void;
}) {
  const names = list?.ok ? list.names : [];
  const storedMissing = stored !== null && list?.ok === true && !names.includes(stored);
  const kept = stored !== null && (list === null || !list.ok || storedMissing);
  return (
    <>
      <ul className="target-list" data-obs-picker={what}>
        {kept && (
          <li>
            <button className="target target-selected" disabled data-obs-name={stored}>
              <span className="target-name">{stored}</span>
              {storedMissing && <span className="target-note">not in OBS now</span>}
            </button>
          </li>
        )}
        {names.map((name) => (
          <li key={name}>
            <button className={stored === name ? 'target target-selected' : 'target'} disabled={disabled} onClick={() => onChoose(name)} data-obs-name={name}>
              <span className="target-name">{name}</span>
            </button>
          </li>
        ))}
      </ul>
      {list === null && <p className="muted small">Asking OBS…</p>}
      {list?.ok === false && (
        <p className="warning-text" data-obs-list={list.reason}>
          {list.reason === 'unavailable' ? 'Start OBS to choose.' : list.message}
        </p>
      )}
      {list?.ok === true && names.length === 0 && <p className="muted small">OBS has no {what}s to choose from here.</p>}
      {storedMissing && (
        <p className="warning-text">
          OBS has no {what} named “{stored}” now: renamed or deleted in OBS? The key does nothing until it is back, or pick another.
        </p>
      )}
      {stored === null && list?.ok === true && names.length > 0 && <p className="muted small">Pick the {what} this key acts on.</p>}
      <button className="link-button" onClick={onRefresh} data-obs-refresh={what}>
        Ask OBS again
      </button>
    </>
  );
}

/** obs.scene: switch OBS to one scene. */
export function ObsSceneForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const list = useObsList('scenes', null, ask);
  const stored = nameOf(actionOf('obs.scene', button)?.scene);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Scene</h3>
      <p className="muted small">
        Switches OBS to this scene. The key lights while it is the scene on air. In studio mode it switches what is on air directly, not the
        preview.
      </p>
      <NamePicker
        list={list}
        stored={stored}
        what="scene"
        disabled={disabled}
        onChoose={(scene) => void run({ kind: 'setAction', at, action: nextAction('obs.scene', button, { scene }) })}
        onRefresh={() => setAsk((n) => n + 1)}
      />
    </section>
  );
}

/** obs.mute: mute and unmute one of OBS's audio inputs. */
export function ObsMuteForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const list = useObsList('inputs', null, ask);
  const stored = nameOf(actionOf('obs.mute', button)?.input);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Mute input</h3>
      <p className="muted small">
        Mutes and unmutes this audio input in OBS — OBS's own mute, which is what your stream hears. The key shows when it is muted. Mic mute,
        under Audio, mutes the system's microphone instead.
      </p>
      <NamePicker
        list={list}
        stored={stored}
        what="input"
        disabled={disabled}
        onChoose={(input) => void run({ kind: 'setAction', at, action: nextAction('obs.mute', button, { input }) })}
        onRefresh={() => setAsk((n) => n + 1)}
      />
    </section>
  );
}

/** obs.source: show and hide a source in a scene — the scene first, then its sources. */
export function ObsSourceForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('obs.source', button);
  const storedScene = nameOf(action?.scene);
  const storedSource = nameOf(action?.source);
  // A scene picked, not yet written: the source list follows it until a source is chosen.
  const [scene, setScene] = useState<string | null>(storedScene);
  const scenes = useObsList('scenes', null, ask);
  const sources = useObsList('sources', scene, ask);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Show/hide source</h3>
      <p className="muted small">Shows or hides a source in one scene. The key shows when it is hidden.</p>
      <h4 className="form-subheading">Scene</h4>
      <NamePicker list={scenes} stored={scene} what="scene" disabled={disabled} onChoose={setScene} onRefresh={() => setAsk((n) => n + 1)} />
      {scene !== null && (
        <>
          <h4 className="form-subheading">Source</h4>
          <NamePicker
            list={sources}
            stored={scene === storedScene ? storedSource : null}
            what="source"
            disabled={disabled}
            onChoose={(source) => void run({ kind: 'setAction', at, action: nextAction('obs.source', button, { scene, source }) })}
            onRefresh={() => setAsk((n) => n + 1)}
          />
        </>
      )}
    </section>
  );
}
