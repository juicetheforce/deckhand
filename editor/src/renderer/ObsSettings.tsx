import { useEffect, useRef, useState } from 'react';
import type { ObsAttempt, ObsStatus } from '../../../src/control/protocol.js';
import type { ObsForm } from '../shared/bridge.js';

/**
 * Settings › Integrations › OBS (scope §7, "Streaming integrations"): where
 * OBS is set up. Saving sets it up — set up means saved, not "has connected
 * once", so OBS can be closed while it is done. Test connection tries the
 * form's values without saving and says which thing is wrong. Remove deletes
 * the saved connection and touches no key: OBS keys stay where they are,
 * show "not set up", and come back when it is set up again.
 *
 * The password field never shows the saved password — the daemon never sends
 * it — only whether one is set. Left empty, the saved one is kept.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;
const WHERE = 'In OBS: Tools › WebSocket Server Settings. Turn on Enable WebSocket server; Show Connect Info has the port and password.';
/** obs-websocket listens on every network interface, IPv4 and IPv6, with no local-only option: the password is all that guards OBS. */
const STRONG = "Use a strong password: OBS's WebSocket server listens on your whole network, and the password is all that guards it.";

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
  const section = useRef<HTMLDivElement>(null);
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

  // Opened at this section (a not-set-up OBS action, or a key's callout): show
  // it — once the form is drawn, which waits for the status.
  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    section.current?.scrollIntoView({ block: 'start' });
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
    setMessage(result.ok ? { kind: 'ok', text: `Connected to OBS ${result.obsVersion}. Save to use it.` } : { kind: 'error', text: result.message });
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
    setMessage(savedMessage(result.attempt));
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

  if (status === undefined) return <div ref={section} id="settings-obs" />;
  if (status === null) {
    return (
      <div ref={section} id="settings-obs" className="settings-row" data-obs-section="unavailable">
        <div className="settings-text">
          <span className="settings-title">OBS Studio</span>
          <span className="settings-sub">Needs Deckhand's service running: it is what connects to OBS.</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={section} id="settings-obs" className="obs-settings" data-obs-section={status.setUp ? 'set-up' : 'not-set-up'}>
      <div className="settings-text">
        <span className="settings-title">OBS Studio</span>
        <span className="settings-sub" data-obs-status={status.setUp ? status.connection : 'not-set-up'}>
          {statusLine(status)}
        </span>
      </div>
      <div className="obs-fields">
        <label className="obs-field">
          <span>Host</span>
          <input ref={hostInput} className="settings-input" value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} data-obs-field="host" />
        </label>
        <label className="obs-field obs-field-port">
          <span>Port</span>
          <input className="settings-input" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} data-obs-field="port" />
        </label>
        <label className="obs-field obs-field-password">
          <span>Password</span>
          <input
            className="settings-input"
            type="password"
            autoComplete="off"
            value={password}
            placeholder={clearPassword ? 'Removed on Save' : status.passwordSet ? 'Saved — type to replace it' : 'None saved'}
            onChange={(e) => {
              setPassword(e.target.value);
              setClearPassword(false);
            }}
            data-obs-field="password"
          />
        </label>
      </div>
      <span className="settings-sub" data-obs-hint="strong-password">
        {STRONG}
      </span>
      {status.passwordSet && !clearPassword && password === '' && (
        <button className="obs-link" onClick={() => setClearPassword(true)} data-obs="clear-password">
          Remove the saved password (OBS with authentication off)
        </button>
      )}
      <span className="settings-sub">{WHERE}</span>
      <div className="obs-actions">
        <button className="settings-button" disabled={busy} onClick={() => void test()} data-obs="test">
          Test connection
        </button>
        <button className="settings-button settings-button-primary" disabled={busy} onClick={() => void save()} data-obs="save">
          Save
        </button>
        {status.setUp && !confirmingRemove && (
          <button className="settings-button" disabled={busy} onClick={() => setConfirmingRemove(true)} data-obs="remove">
            Remove…
          </button>
        )}
      </div>
      {confirmingRemove && (
        <div className="obs-confirm" data-obs-confirm="remove">
          <p className="settings-status settings-status-warn">
            Every OBS key stops working until OBS is set up again. The keys stay where they are. The saved password is deleted for good:
            backups never include it, so none can bring it back.
          </p>
          <div className="obs-actions">
            <button className="settings-button settings-button-danger" onClick={() => void remove()} data-obs="confirm-remove">
              Remove OBS
            </button>
            <button className="settings-button" onClick={() => setConfirmingRemove(false)} data-obs="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {message && (
        <p
          className={`settings-status${message.kind === 'error' ? ' settings-status-error' : message.kind === 'warn' ? ' settings-status-warn' : ''}`}
          role="status"
          data-obs-message={message.kind}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function statusLine(status: ObsStatus): string {
  if (!status.setUp) return 'Not set up. OBS keys do nothing until it is.';
  switch (status.connection) {
    case 'connected':
      return 'Set up, and connected.';
    case 'unavailable':
      return 'Set up. Keys will connect once OBS is running.';
    case 'auth-failed':
      return 'Set up, but OBS refused the password.';
    default:
      // Idle: no OBS key on a page a deck shows, so nothing is connected — and nothing needs to be.
      return 'Set up.';
  }
}

/** What Save says, from its one attempt to connect. */
function savedMessage(attempt: ObsAttempt): Message {
  if (attempt.ok) return { kind: 'ok', text: `Saved. Connected to OBS ${attempt.obsVersion}.` };
  if (attempt.reason === 'not-running') return { kind: 'ok', text: 'Saved. Keys will connect once OBS is running.' };
  return { kind: 'warn', text: `Saved, but: ${attempt.message}` };
}
