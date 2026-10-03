import { useEffect, useRef, useState } from 'react';
import type { VtsApprovalState, VtsStatus } from '../../../src/control/protocol.js';

/**
 * Settings › Integrations › VTube Studio (scope §7, "Streaming
 * integrations"): where VTube Studio is set up. Connect is the only thing in
 * Deckhand that ever asks VTS for access — VTS shows a window, and Allow
 * there saves a token, which sets it up. Remove deletes the token and touches
 * no key: VTS keys stay where they are, show "not set up", and come back when
 * it is connected again.
 *
 * **No Cancel** (scope §7): closing the request does not take VTS's window
 * back, so a Cancel would leave a window in VTS that does nothing when
 * clicked. While VTS shows it, this says to answer it there. How Connect goes
 * arrives as status updates (the daemon's "vts" event), each message written
 * for the person already (services/vts.ts).
 *
 * The token is never shown — the daemon never sends it — only whether one is
 * saved.
 */

const DEFAULT_PORT = 8001;
const WHERE = "In VTube Studio's settings, turn on Allow Plugin API access. Connect then asks VTube Studio for access: allow Deckhand in the window it shows.";
const PORT_HINT = '8001 unless you changed it in VTube Studio. If it is on another port, Connect finds it.';

type Message = { kind: 'ok' | 'warn' | 'error'; text: string };

/** Connect is under way: finding VTS, or VTS's window waiting for the person. */
const asking = (state: VtsApprovalState | undefined) => state === 'checking' || state === 'waiting';

export function VtsSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without VTube Studio). */
  const [status, setStatus] = useState<VtsStatus | null | undefined>(undefined);
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const lastApproval = useRef<VtsApprovalState | undefined>(undefined);

  useEffect(() => {
    const follow = (s: VtsStatus | null) => {
      setStatus(s);
      // Allowed: the port Connect found VTS on is the one saved. Only on the change, never over a port being typed.
      if (s?.approval.state === 'approved' && lastApproval.current !== 'approved' && lastApproval.current !== undefined && s.port !== null) setPort(String(s.port));
      lastApproval.current = s?.approval.state;
    };
    void window.deckhand.vtsStatus().then((s) => {
      lastApproval.current = s?.approval.state;
      setStatus(s);
      setPort(String(s?.port ?? DEFAULT_PORT));
    });
    return window.deckhand.onVtsStatus(follow);
  }, []);

  // Opened at this section (a not-set-up VTS action, or a key's callout): show
  // it — once the form is drawn, which waits for the status.
  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    section.current?.scrollIntoView({ block: 'start' });
    portInput.current?.focus();
  }, [focus, loaded]);

  const connect = async () => {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setMessage({ kind: 'error', text: 'The port is a whole number from 1 to 65535: 8001 unless you changed it in VTube Studio.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await window.deckhand.vtsConnect(portNumber);
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `Could not ask: ${result.error}` });
      return;
    }
    setStatus(result.status);
  };

  const remove = async () => {
    setConfirmingRemove(false);
    setBusy(true);
    const result = await window.deckhand.vtsRemove();
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `Not removed: ${result.error}` });
      return;
    }
    setStatus(result.status);
    setMessage({ kind: 'ok', text: "Removed. VTube Studio keys stay where they are, and work again once it is connected. Deckhand stays in VTube Studio's plugin list until you remove it there." });
  };

  if (status === undefined) return <div ref={section} id="settings-vts" />;
  if (status === null) {
    return (
      <div ref={section} id="settings-vts" className="settings-row" data-vts-section="unavailable">
        <div className="settings-text">
          <span className="settings-title">VTube Studio</span>
          <span className="settings-sub">Needs Deckhand's service running: it is what connects to VTube Studio.</span>
        </div>
      </div>
    );
  }

  const approval = status.approval;
  // A local message (a bad port, Remove) until the next Connect's progress replaces it.
  const shown: Message | null = message ?? (approval.state !== 'none' && approval.message ? { kind: approvalKind(approval.state), text: approval.message } : null);

  return (
    <div ref={section} id="settings-vts" className="obs-settings" data-vts-section={status.setUp ? 'set-up' : 'not-set-up'}>
      <div className="settings-text">
        <span className="settings-title">VTube Studio</span>
        <span className="settings-sub" data-vts-status={status.setUp ? status.connection : 'not-set-up'}>
          {statusLine(status)}
        </span>
      </div>
      <div className="obs-fields">
        <label className="obs-field obs-field-port">
          <span>Port</span>
          <input ref={portInput} className="settings-input" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} data-vts-field="port" />
        </label>
      </div>
      <span className="settings-sub">{PORT_HINT}</span>
      <span className="settings-sub">{WHERE}</span>
      <div className="obs-actions">
        <button
          className="settings-button settings-button-primary"
          disabled={busy || asking(approval.state)}
          onClick={() => {
            setMessage(null);
            void connect();
          }}
          data-vts="connect"
        >
          {status.setUp ? 'Connect again' : 'Connect'}
        </button>
        {status.setUp && !confirmingRemove && (
          <button className="settings-button" disabled={busy} onClick={() => setConfirmingRemove(true)} data-vts="remove">
            Remove…
          </button>
        )}
      </div>
      {confirmingRemove && (
        <div className="obs-confirm" data-vts-confirm="remove">
          <p className="settings-status settings-status-warn">
            Every VTube Studio key stops working until it is connected again. The keys stay where they are. Connecting again shows VTube Studio's
            window again.
          </p>
          <div className="obs-actions">
            <button className="settings-button settings-button-danger" onClick={() => void remove()} data-vts="confirm-remove">
              Remove VTube Studio
            </button>
            <button className="settings-button" onClick={() => setConfirmingRemove(false)} data-vts="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {shown && (
        <p
          className={`settings-status${shown.kind === 'error' ? ' settings-status-error' : shown.kind === 'warn' ? ' settings-status-warn' : ''}`}
          role="status"
          data-vts-message={shown.kind}
          data-vts-approval={message ? undefined : approval.state}
        >
          {shown.text}
        </p>
      )}
    </div>
  );
}

function statusLine(status: VtsStatus): string {
  if (!status.setUp) return 'Not set up. VTube Studio keys do nothing until it is.';
  switch (status.connection) {
    case 'connected':
      return 'Set up, and connected.';
    case 'unavailable':
      return 'Set up. Keys will connect once VTube Studio is running.';
    case 'refused':
      return 'Set up, but VTube Studio no longer allows Deckhand. Connect again to ask it.';
    default:
      // Idle: no VTS key on a page a deck shows, so nothing is connected — and nothing needs to be.
      return 'Set up.';
  }
}

/** How Connect's progress reads: waiting on the person is a warning to go and look, not an error. */
function approvalKind(state: VtsApprovalState): Message['kind'] {
  if (state === 'approved' || state === 'checking') return 'ok';
  if (state === 'waiting') return 'warn';
  return 'error';
}
