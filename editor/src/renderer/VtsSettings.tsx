import { useEffect, useRef, useState } from 'react';
import type { VtsApproval, VtsApprovalState, VtsStatus } from '../../../src/control/protocol.js';
import { vtsView } from './integration-status.js';
import { Banner, Disclosure, Group, IntegrationHeader } from './settings-ui.js';

/**
 * Settings › VTube Studio (scope §7, "Streaming integrations"; Claude Design
 * 14g–14j): where VTube Studio is set up. Connect is the only thing in
 * Deckhand that ever asks VTS for access — VTS shows a window, and Allow
 * there saves a token, which sets it up. Remove deletes the token and touches
 * no key: VTS keys stay where they are, show "not set up", and come back when
 * it is connected again.
 *
 * **No Cancel** (scope §7): closing the request does not take VTS's window
 * back, so a Cancel would leave a window in VTS that does nothing when
 * clicked. While VTS shows it, this says to answer it there. How Connect goes
 * arrives as status updates (the daemon's "vts" event), each message written
 * for the person already (services/vts.ts), except the two the copy sheet
 * words itself.
 *
 * The token is never shown — the daemon never sends it — only whether one is
 * saved.
 */

const DEFAULT_PORT = 8001;
const STEPS = 'In VTube Studio settings, turn on Allow Plugin API access. Press Connect, then allow Deckhand in VTube Studio.';
const PORT_HINT = 'Default 8001. Other ports are found automatically.';
const REFUSED = 'VTube Studio no longer allows Deckhand. Connect again to ask it.';

type Message = { kind: 'ok' | 'warn' | 'error' | 'info'; text: string };

/** Connect is under way: finding VTS, or VTS's window waiting for the person. */
const asking = (state: VtsApprovalState | undefined) => state === 'checking' || state === 'waiting';

export function VtsSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without VTube Studio). */
  const [status, setStatus] = useState<VtsStatus | null | undefined>(undefined);
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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

  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
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

  if (status === undefined) return <div id="settings-vts" />;
  if (status === null) {
    return (
      <div id="settings-vts" className="sp-page" data-vts-section="unavailable">
        <IntegrationHeader icon="vts-model" tint="vts" name="VTube Studio" dot="unset" status="Needs Deckhand's service running: it is what connects to VTube Studio." />
      </div>
    );
  }

  const view = vtsView(status);
  const approval = status.approval;
  // A local message (a bad port, Remove) until the next Connect's progress replaces it; then Connect's; then a refused token.
  const fromConnect = approval.state !== 'none' && approval.message ? { kind: approvalKind(approval.state), text: approvalText(approval) } : null;
  const shown: Message | null = message ?? fromConnect ?? (status.connection === 'refused' ? { kind: 'error', text: REFUSED } : null);

  return (
    <div id="settings-vts" className="sp-page" data-vts-section={status.setUp ? 'set-up' : 'not-set-up'}>
      <IntegrationHeader
        icon="vts-model"
        tint="vts"
        name="VTube Studio"
        dot={view.dot}
        status={view.text}
        data-vts-status={status.setUp ? status.connection : 'not-set-up'}
      >
        {status.setUp && !confirmingRemove && (
          <button className="sp-button sp-button-danger" disabled={busy} onClick={() => setConfirmingRemove(true)} data-vts="remove">
            Remove…
          </button>
        )}
      </IntegrationHeader>
      {confirmingRemove && (
        <div className="sp-confirm" data-vts-confirm="remove">
          <p className="sp-confirm-text">
            Every VTube Studio key stops working until it is connected again. The keys stay where they are. Connecting again shows VTube Studio's
            window again.
          </p>
          <div className="sp-actions">
            <button className="sp-button sp-button-danger-solid" onClick={() => void remove()} data-vts="confirm-remove">
              Remove VTube Studio
            </button>
            <button className="sp-button" onClick={() => setConfirmingRemove(false)} data-vts="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {shown && (
        <Banner kind={shown.kind} data-vts-message={shown.kind} data-vts-approval={message ? undefined : shown === fromConnect ? approval.state : undefined}>
          {shown.text}
        </Banner>
      )}
      <Group heading="Connection">
        <div className="sp-form">
          <label className="sp-field sp-field-port">
            <span className="sp-field-label">Port</span>
            <input ref={portInput} className="sp-input" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} data-vts-field="port" />
          </label>
          <span className="sp-row-detail">{PORT_HINT}</span>
          <div className="sp-actions">
            <button
              className="sp-button sp-button-primary"
              disabled={busy || asking(approval.state)}
              onClick={() => {
                setMessage(null);
                void connect();
              }}
              data-vts="connect"
            >
              {status.setUp ? 'Connect again' : 'Connect'}
            </button>
          </div>
        </div>
      </Group>
      <Disclosure summary="Setup steps" initiallyOpen={view.dot === 'unset' || view.dot === 'failed'}>
        {STEPS}
      </Disclosure>
    </div>
  );
}

/**
 * Connect's progress, in the copy sheet's words for a denial; the daemon's
 * otherwise. Not the sheet's "No answer on port {port}. Is Plugin API access
 * on?": from VTube Studio's own broadcast the daemon knows which — not
 * running, its API off, or on but not answering at that port — and says so.
 */
function approvalText(approval: VtsApproval): string {
  if (approval.state === 'denied') return 'Access was denied in VTube Studio. Connect again and choose Allow.';
  return approval.message ?? '';
}

/** How Connect's progress reads: under way is information, waiting on the person a warning to go and look. */
function approvalKind(state: VtsApprovalState): Message['kind'] {
  if (state === 'approved') return 'ok';
  if (state === 'checking') return 'info';
  if (state === 'waiting') return 'warn';
  return 'error';
}
