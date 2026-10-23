import { useEffect, useRef, useState } from 'react';
import type { DiscordApprovalState, DiscordStatus } from '../../../src/control/protocol.js';
import { discordView } from './integration-status.js';
import { Banner, Disclosure, Group, IntegrationHeader } from './settings-ui.js';

/**
 * Settings › Discord (the design mockups, 15c–15f, and the copy sheet's
 * words): where Discord is set up. Each person makes their own application
 * in Discord's Developer Portal — Discord approves no shared one (scope §7)
 * — and copies its Application ID here. Connect is the only thing in
 * Deckhand that ever asks Discord to authorize: Discord shows its Authorize
 * window, and Authorize there saves the tokens. Remove forgets them, revokes
 * them at Discord, and touches no key.
 *
 * **Cancel exists here**, as in the mockups: it stops waiting, and nothing is
 * saved. Whether Discord's own window closes with it is not known yet, so the
 * message says to close it there if it is still open.
 *
 * Two states the mockups do not draw follow OBS's page: "Waiting for
 * Discord" (set up, Discord not running or no Discord key in the profile),
 * and "Connecting…" while Discord answers its handshake, which can take
 * seconds.
 *
 * No token is ever shown — the daemon never sends one — only whether one is
 * saved, the application it is for, and the account that allowed it.
 */

type Message = { kind: 'ok' | 'warn' | 'error' | 'info'; text: string };

const REFUSED = 'Discord no longer accepts Deckhand’s authorization. Connect again to authorize it.';

/** Connect is under way: finding Discord, or its Authorize window waiting for the person. */
const asking = (state: DiscordApprovalState | undefined) => state === 'checking' || state === 'waiting';

const STEPS = [
  <>In Discord’s Developer Portal, create an application.</>,
  <>Under OAuth2, turn on Public Client.</>,
  <>
    Add <code>http://127.0.0.1</code> as a redirect.
  </>,
  <>Copy the Application ID into the field above.</>,
];

export function DiscordSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without Discord). */
  const [status, setStatus] = useState<DiscordStatus | null | undefined>(undefined);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const idInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.deckhand.discordStatus().then((s) => {
      setStatus(s);
      setClientId(s?.clientId ?? '');
    });
    return window.deckhand.onDiscordStatus(setStatus);
  }, []);

  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    idInput.current?.focus();
  }, [focus, loaded]);

  const connect = async () => {
    const id = clientId.trim();
    if (!/^\d{15,25}$/.test(id)) {
      setMessage({ kind: 'error', text: 'The Application ID is a long number: copy it from General Information in the Developer Portal.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    setConfirmingRemove(false);
    const result = await window.deckhand.discordConnect(id);
    setBusy(false);
    if (!result.ok) setMessage({ kind: 'error', text: `Could not ask Discord: ${result.error}` });
    // Not the reply's status: how it goes arrives as events, which can come first.
  };

  const cancel = async () => {
    setMessage(null);
    const result = await window.deckhand.discordCancel();
    if (!result.ok) setMessage({ kind: 'error', text: `Not cancelled: ${result.error}` });
  };

  const remove = async () => {
    setConfirmingRemove(false);
    setBusy(true);
    const result = await window.deckhand.discordRemove();
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `Not removed: ${result.error}` });
      return;
    }
    setStatus(result.status);
    // Only "revoked" when Discord said so.
    setMessage(
      result.revoked === false
        ? {
            kind: 'warn',
            text: 'Removed here, but Discord did not confirm revoking it: remove your application in Discord’s User Settings › Authorized Apps. Discord keys stay where they are.',
          }
        : { kind: 'ok', text: 'Removed, and revoked at Discord. Discord keys stay where they are, and work again once it is connected.' },
    );
  };

  if (status === undefined) return <div id="settings-discord" />;
  if (status === null) {
    return (
      <div id="settings-discord" className="sp-page" data-discord-section="unavailable">
        <IntegrationHeader icon="discord-deafen" tint="discord" name="Discord" dot="unset" status="Needs Deckhand's service running: it is what connects to Discord." />
      </div>
    );
  }

  const view = discordView(status);
  const approval = status.approval;
  const waiting = approval.state === 'waiting';
  // A local message (a bad ID, Remove) until the next Connect's progress replaces it; then Connect's; then a refused authorization.
  const fromConnect = approval.state !== 'none' && !waiting && approval.message ? { kind: approvalKind(approval.state), text: approval.message } : null;
  const shown: Message | null = message ?? fromConnect ?? (status.connection === 'refused' ? { kind: 'error', text: REFUSED } : null);

  return (
    <div id="settings-discord" className="sp-page" data-discord-section={status.setUp ? 'set-up' : 'not-set-up'}>
      <IntegrationHeader icon="discord-deafen" tint="discord" name="Discord" dot={view.dot} status={view.text} data-discord-status={status.setUp ? status.connection : 'not-set-up'}>
        {status.setUp && !confirmingRemove && (
          <button className="sp-button sp-button-danger" disabled={busy} onClick={() => setConfirmingRemove(true)} data-discord="remove">
            Remove…
          </button>
        )}
      </IntegrationHeader>
      {confirmingRemove && (
        <div className="sp-confirm" data-discord-confirm="remove">
          <p className="sp-confirm-text">
            Every Discord key stops working until it is connected again. The keys stay where they are. The authorization is revoked at Discord too.
          </p>
          <div className="sp-actions">
            <button className="sp-button sp-button-danger-solid" onClick={() => void remove()} data-discord="confirm-remove">
              Remove Discord
            </button>
            <button className="sp-button" onClick={() => setConfirmingRemove(false)} data-discord="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {waiting && (
        <Banner
          kind="discord"
          data-discord-approval="waiting"
          action={
            <button className="sp-button" onClick={() => void cancel()} data-discord="cancel">
              Cancel
            </button>
          }
        >
          {approval.message ?? 'Approve Deckhand in Discord’s Authorize window.'}
        </Banner>
      )}
      {shown && (
        <Banner kind={shown.kind} data-discord-message={shown.kind} data-discord-approval={message ? undefined : shown === fromConnect ? approval.state : undefined}>
          {shown.text}
        </Banner>
      )}
      <Group heading="Connection">
        <div className="sp-form">
          <label className="sp-field">
            <span className="sp-field-label">Application ID</span>
            <input
              ref={idInput}
              className={`sp-input${clientId === '' ? '' : ' sp-input-id'}`}
              value={clientId}
              placeholder="From the Developer Portal"
              inputMode="numeric"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
              data-discord-field="client-id"
            />
          </label>
          <div className="sp-actions">
            <button
              className="sp-button sp-button-primary"
              disabled={busy || asking(approval.state)}
              onClick={() => {
                setMessage(null);
                void connect();
              }}
              data-discord="connect"
            >
              {status.setUp ? 'Connect again' : 'Connect'}
            </button>
            <span className="sp-row-detail">Connect opens Discord’s Authorize prompt.</span>
          </div>
        </div>
      </Group>
      <Disclosure summary="Setup steps" initiallyOpen={!status.setUp}>
        <ol className="sp-steps" data-discord-steps="">
          {STEPS.map((step, i) => (
            <li key={i} className="sp-step">
              <span className="sp-step-number" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}

/** How Connect's outcome reads: under way is information, a cancel a warning, the rest an error. */
function approvalKind(state: DiscordApprovalState): Message['kind'] {
  if (state === 'approved') return 'ok';
  if (state === 'checking') return 'info';
  if (state === 'cancelled') return 'warn';
  return 'error';
}
