/**
 * The OBS keys (scope §7, "Streaming integrations"): nothing to set — what
 * they act on is OBS itself — so each form says what the key does and what it
 * needs. The connection is set from the command line until Settings has it.
 */

const ABOUT: Record<string, { heading: string; text: string }> = {
  'obs.stream': {
    heading: 'Stream',
    text: 'Press to go live. To stop, hold the key for a second: a short press while live does nothing but mark the key, so a stray press never ends a stream. Its icon turns red while live, and the key amber if OBS is reconnecting.',
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
        Needs OBS running with its WebSocket server on (OBS: Tools › WebSocket Server Settings). Set its password once with{' '}
        <code>deckhand obs password</code>.
      </p>
    </section>
  );
}
