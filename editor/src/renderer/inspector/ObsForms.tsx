/**
 * The OBS keys (scope §7, "Streaming integrations"): nothing to set — what
 * they act on is OBS itself — so each form says what the key does and what it
 * needs. The connection is set from the command line until Settings has it.
 */

const ABOUT: Record<string, { heading: string; text: string }> = {
  'obs.stream': {
    heading: 'Stream',
    text: 'Press to go live. To stop, hold the key for a second: a short press while live does nothing but mark the key, so a stray press never ends a stream. The key turns red while live.',
  },
  'obs.record': {
    heading: 'Record',
    text: 'Press to start recording, and again to stop. The key turns red while recording.',
  },
  'obs.recordPause': {
    heading: 'Pause recording',
    text: 'Press to pause the recording, and again to resume. With nothing recording, a press is marked as failed.',
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
