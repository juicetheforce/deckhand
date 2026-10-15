import { useEffect, useRef, useState } from 'react';
import type { ObsAttempt, ObsStatus } from '../../../src/control/protocol.js';
import type { ObsForm } from '../shared/bridge.js';
import { obsView } from './integration-status.js';
import { Banner, Disclosure, Group, InfoTip, IntegrationHeader, LinkButton } from './settings-ui.js';

/**
 * Settings › OBS Studio (the design mockups): where OBS is set up. Saving sets it up — set up means saved, not
 * "has connected once", so OBS can be closed while it is done. Test
 * connection tries the form's values without saving and says which thing is
 * wrong. Remove deletes the saved connection and touches no key: OBS keys
 * stay where they are, show "not set up", and come back when it is set up
 * again.
 *
 * The password field never shows the saved password — the daemon never sends
 * it — only whether one is set. Left empty, the saved one is kept.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;
const WHERE = 'In OBS: Tools › WebSocket Server Settings. Turn on Enable WebSocket server. Show Connect Info has the port and password.';
/** obs-websocket listens on every network interface, IPv4 and IPv6, with no local-only option: the password is all that guards OBS. */
const STRONG = 'OBS accepts connections from your whole network. Use a strong password.';
const REJECTED = 'OBS rejected the password.';

type Message = { kind: 'ok' | 'warn' | 'error'; text: string };

export function ObsSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without OBS). */
  const [status, setStatus] = useState<ObsStatus | null | undefined>(undefined);
  const [host, setHost] = useState(DEFAULT_HOST);
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const hostInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fill = (s: ObsStatus | null) => {
      setStatus(s);
      setHost(s?.host ?? DEFAULT_HOST);
      setPort(String(s?.port ?? DEFAULT_PORT));
    };
    void window.deckhand.obsStatus().then(fill);
    // Later changes move the status line, never the fields being typed in.
    return window.deckhand.onObsStatus((s) => setStatus(s));
  }, []);

  // Opened at this page (a not-set-up OBS action, or a key's callout): the
  // first field takes the focus — once the form is drawn, which waits for the status.
  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    hostInput.current?.focus();
  }, [focus, loaded]);

  const form = (forSave: boolean): ObsForm | null => {
    const portNumber = Number(port);
    if (host.trim() === '') {
      setMessage({ kind: 'error', text: 'Give the host OBS runs on: 127.0.0.1 for this computer.' });
      return null;
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setMessage({ kind: 'error', text: 'The port is a whole number from 1 to 65535: 4455 unless you changed it in OBS.' });
      return null;
    }
    const values: ObsForm = { host: host.trim(), port: portNumber };
    if (password !== '') values.password = password;
    // Removing the saved one: no password for Test, and removed on Save.
    else if (clearPassword) values.password = forSave ? null : '';
    return values;
  };

  const test = async () => {
    const values = form(false);
    if (!values) return;
    setBusy(true);
    setMessage(null);
    const result = await window.deckhand.obsTest(values);
    setBusy(false);
    setMessage(result.ok ? { kind: 'ok', text: `Connected to OBS ${result.obsVersion}. Save to use it.` } : { kind: 'error', text: failureText(result, values) });
  };

  const save = async () => {
    const values = form(true);
    if (!values) return;
    setBusy(true);
    setMessage(null);
    const result = await window.deckhand.obsSave(values);
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `Not saved: ${result.error}` });
      return;
    }
    setStatus(result.status);
    setPassword('');
    setClearPassword(false);
    setMessage(savedMessage(result.attempt, values));
  };

  const remove = async () => {
    setConfirmingRemove(false);
    setBusy(true);
    const result = await window.deckhand.obsRemove();
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `Not removed: ${result.error}` });
      return;
    }
    setStatus(result.status);
    setPassword('');
    setClearPassword(false);
    setMessage({ kind: 'ok', text: 'Removed. OBS keys stay where they are, and work again once OBS is set up.' });
  };

  if (status === undefined) return <div id="settings-obs" />;
  if (status === null) {
    return (
      <div id="settings-obs" className="sp-page" data-obs-section="unavailable">
        <IntegrationHeader icon="obs-stream" tint="obs" name="OBS Studio" dot="unset" status="Needs Deckhand's service running: it is what connects to OBS." />
      </div>
    );
  }

  const view = obsView(status);
  // A local message (a test, a save, a bad field) until the next; otherwise what the daemon says.
  const shown: Message | null = message ?? (status.setUp && status.connection === 'auth-failed' ? { kind: 'error', text: REJECTED } : null);
  const passwordHint = clearPassword ? 'Removed on Save' : status.passwordSet ? 'Saved · type to replace' : 'From Show Connect Info';

  return (
    <div id="settings-obs" className="sp-page" data-obs-section={status.setUp ? 'set-up' : 'not-set-up'}>
      <IntegrationHeader
        icon="obs-stream"
        tint="obs"
        name="OBS Studio"
        dot={view.dot}
        status={view.text}
        data-obs-status={status.setUp ? status.connection : 'not-set-up'}
      >
        {status.setUp && !confirmingRemove && (
          <button className="sp-button sp-button-danger" disabled={busy} onClick={() => setConfirmingRemove(true)} data-obs="remove">
            Remove…
          </button>
        )}
      </IntegrationHeader>
      {confirmingRemove && (
        <div className="sp-confirm" data-obs-confirm="remove">
          <p className="sp-confirm-text">
            Every OBS key stops working until OBS is set up again. The keys stay where they are. The saved password is deleted for good: backups
            never include it, so none can bring it back.
          </p>
          <div className="sp-actions">
            <button className="sp-button sp-button-danger-solid" onClick={() => void remove()} data-obs="confirm-remove">
              Remove OBS
            </button>
            <button className="sp-button" onClick={() => setConfirmingRemove(false)} data-obs="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {shown && (
        <Banner kind={shown.kind} data-obs-message={shown.kind}>
          {shown.text}
        </Banner>
      )}
      <Group heading="Connection">
        <div className="sp-form">
          <div className="sp-fields">
            <label className="sp-field sp-field-grow">
              <span className="sp-field-label">Host</span>
              <input ref={hostInput} className="sp-input" value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} data-obs-field="host" />
            </label>
            <label className="sp-field sp-field-port">
              <span className="sp-field-label">Port</span>
              <input className="sp-input" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} data-obs-field="port" />
            </label>
            <label className="sp-field sp-field-password">
              <span className="sp-field-label">
                Password <InfoTip text={STRONG} data-obs-hint="strong-password" />
              </span>
              <input
                className={`sp-input${shown?.kind === 'error' && shown.text === REJECTED ? ' sp-input-error' : ''}`}
                type="password"
                autoComplete="off"
                value={password}
                placeholder={passwordHint}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setClearPassword(false);
                }}
                data-obs-field="password"
              />
            </label>
          </div>
          <div className="sp-actions">
            <button className="sp-button" disabled={busy} onClick={() => void test()} data-obs="test">
              Test connection
            </button>
            <button className="sp-button sp-button-primary" disabled={busy} onClick={() => void save()} data-obs="save">
              Save
            </button>
            <span className="sp-spacer" />
            {status.passwordSet && !clearPassword && password === '' && (
              <LinkButton title="For OBS with authentication turned off" onClick={() => setClearPassword(true)} data-obs="clear-password">
                Clear saved password
              </LinkButton>
            )}
          </div>
        </div>
      </Group>
      <Disclosure summary="Where to find these" initiallyOpen={view.dot === 'unset' || view.dot === 'failed'}>
        {WHERE}
      </Disclosure>
    </div>
  );
}

/**
 * A test that did not connect, in the copy sheet's words where they say the
 * same thing; the daemon's otherwise — it tells OBS not running apart from
 * its server off, and that difference is what Test is for.
 */
function failureText(attempt: { reason: string; message: string }, at: ObsForm): string {
  if (attempt.reason === 'auth') return REJECTED;
  if (attempt.reason === 'unreachable') return `No answer at ${at.host ?? DEFAULT_HOST}:${at.port ?? DEFAULT_PORT}. Is the WebSocket server on?`;
  return attempt.message;
}

/** What Save says, from its one attempt to connect. */
function savedMessage(attempt: ObsAttempt, at: ObsForm): Message {
  if (attempt.ok) return { kind: 'ok', text: `Saved. Connected to OBS ${attempt.obsVersion}.` };
  if (attempt.reason === 'not-running') return { kind: 'ok', text: 'Saved. Keys will connect once OBS is running.' };
  return { kind: 'warn', text: `Saved, but: ${failureText(attempt, at)}` };
}
