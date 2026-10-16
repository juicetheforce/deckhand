import { useEffect, useRef, useState } from 'react';
import type { TwitchLinkingState, TwitchStatus } from '../../../src/control/protocol.js';
import { twitchChips, twitchView } from './integration-status.js';
import { Banner, Disclosure, Group, IntegrationHeader } from './settings-ui.js';

/**
 * Settings › Twitch (the design mockups): where a Twitch account is linked. Link asks Twitch for a code;
 * the person approves Deckhand at twitch.tv/activate, in any browser, phone
 * included, and the daemon saves the link. Remove forgets the link, ends it
 * at Twitch, and touches no key.
 *
 * **Cancel exists here**, unlike VTube Studio's Connect: stopping leaves
 * nothing behind on Twitch's side — the code just expires. A Cancel on
 * Twitch's own page is never seen by Deckhand, so the
 * code waits here until approved, expired, or cancelled here.
 *
 * No token is ever shown — the daemon never sends one — only the account
 * and what the link allows.
 */

type Message = { kind: 'ok' | 'warn' | 'error'; text: string };

const ABOUT = 'Listed as Deckhand App at twitch.tv/settings/connections. Renews while Deckhand runs; Twitch ends it after 30 days unused.';
const REFUSED = "Twitch no longer accepts the link. Deckhand keeps trying hourly, in case it is Twitch's fault; link again if it does not come back.";

/** Linking is under way: asking for a code, or the code waiting to be approved. */
const linking = (state: TwitchLinkingState | undefined) => state === 'starting' || state === 'waiting';

export function TwitchSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without Twitch). */
  const [status, setStatus] = useState<TwitchStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const linkButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void window.deckhand.twitchStatus().then(setStatus);
    return window.deckhand.onTwitchStatus(setStatus);
  }, []);

  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    linkButton.current?.focus();
  }, [focus, loaded]);

  const call = async <T extends { ok: true; status: TwitchStatus } | { ok: false; error: string }>(run: () => Promise<T>, failed: string): Promise<T | null> => {
    setBusy(true);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: `${failed}: ${result.error}` });
      return null;
    }
    setStatus(result.status);
    return result;
  };

  const link = async () => {
    setMessage(null);
    setConfirmingRemove(false);
    await call(() => window.deckhand.twitchLink(), 'Could not ask Twitch');
  };
  const cancel = async () => {
    setMessage(null);
    await call(() => window.deckhand.twitchCancel(), 'Not cancelled');
  };
  const remove = async () => {
    setConfirmingRemove(false);
    const result = await call(() => window.deckhand.twitchRemove(), 'Not removed');
    if (!result?.ok) return;
    // Only "ended at Twitch" when Twitch said so: otherwise it is still listed there until it lapses.
    setMessage(
      result.revoked === false
        ? {
            kind: 'warn',
            text: 'Removed here, but Twitch did not confirm ending the link: end it at twitch.tv/settings/connections, where it is listed as Deckhand App. Twitch keys stay where they are.',
          }
        : { kind: 'ok', text: 'Removed, and ended at Twitch. Twitch keys stay where they are, and work again once an account is linked.' },
    );
  };
  const openActivate = async () => {
    const result = await window.deckhand.twitchOpenActivate();
    if (!result.ok) setMessage({ kind: 'error', text: `Could not open the page: ${result.error}` });
  };

  if (status === undefined) return <div id="settings-twitch" />;
  if (status === null) {
    return (
      <div id="settings-twitch" className="sp-page" data-twitch-section="unavailable">
        <IntegrationHeader icon="twitch-chat" tint="twitch" name="Twitch" dot="unset" status="Needs Deckhand's service running: it is what talks to Twitch." />
      </div>
    );
  }

  const view = twitchView(status);
  const progress = status.linking;
  const waiting = progress.state === 'waiting' && progress.userCode ? progress : null;
  // A local message (Remove, a failed call) until the next Link's progress replaces it; then how the last link went; then a refused link.
  const shown: Message | null =
    message ??
    (progress.state !== 'none' && progress.state !== 'waiting' && progress.message ? { kind: linkingKind(progress.state), text: progress.message } : null) ??
    (status.link === 'refused' ? { kind: 'error', text: REFUSED } : null);

  return (
    <div id="settings-twitch" className="sp-page" data-twitch-section={status.link}>
      <IntegrationHeader icon="twitch-chat" tint="twitch" name="Twitch" dot={view.dot} status={view.text} data-twitch-status={status.link}>
        {!linking(progress.state) && !status.setUp && (
          <button ref={linkButton} className="sp-button sp-button-primary" disabled={busy} onClick={() => void link()} data-twitch="link">
            Link Twitch
          </button>
        )}
        {!linking(progress.state) && status.setUp && !confirmingRemove && (
          <>
            <button ref={linkButton} className="sp-button" disabled={busy} onClick={() => void link()} data-twitch="link">
              Link again
            </button>
            <button className="sp-button sp-button-danger" disabled={busy} onClick={() => setConfirmingRemove(true)} data-twitch="remove">
              Remove…
            </button>
          </>
        )}
      </IntegrationHeader>
      {confirmingRemove && (
        <div className="sp-confirm" data-twitch-confirm="remove">
          <p className="sp-confirm-text">
            Every Twitch key stops working until an account is linked again. The keys stay where they are. The link is ended at Twitch too.
          </p>
          <div className="sp-actions">
            <button className="sp-button sp-button-danger-solid" onClick={() => void remove()} data-twitch="confirm-remove">
              Remove Twitch
            </button>
            <button className="sp-button" onClick={() => setConfirmingRemove(false)} data-twitch="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {shown && (
        <Banner kind={shown.kind} data-twitch-message={shown.kind} data-twitch-linking={message ? undefined : progress.state}>
          {shown.text}
        </Banner>
      )}
      {waiting && (
        <div className="sp-code" data-twitch-code={waiting.userCode}>
          <span className="sp-row-detail">Enter this code at twitch.tv/activate</span>
          <span className="sp-code-value" aria-label="Code to enter at twitch.tv/activate">
            {waiting.userCode}
          </span>
          <span className="sp-code-wait">
            <span className="sp-dot sp-dot-waiting" aria-hidden="true" />
            Waiting for you to approve on Twitch
          </span>
          <div className="sp-actions">
            <button className="sp-button sp-button-primary" onClick={() => void openActivate()} data-twitch="open-activate">
              Open twitch.tv/activate
            </button>
            <button className="sp-button" disabled={busy} onClick={() => void cancel()} data-twitch="cancel">
              Cancel
            </button>
          </div>
        </div>
      )}
      <Group heading={status.setUp ? 'Allowed' : 'Will be able to'} data-twitch-allows="">
        <div className="sp-chips-box">
          <div className="sp-chips">
            {twitchChips(status).map((chip) => (
              <span key={chip} className={`sp-chip${status.setUp ? ' sp-chip-on' : ''}`}>
                {chip}
              </span>
            ))}
          </div>
          <span className="sp-row-detail">Your channel only, and only when a key is pressed</span>
        </div>
      </Group>
      {!waiting && (
        <Disclosure summary="About this link" initiallyOpen={status.setUp}>
          {ABOUT}
        </Disclosure>
      )}
    </div>
  );
}

/** How linking's outcome reads. */
function linkingKind(state: TwitchLinkingState): Message['kind'] {
  if (state === 'approved' || state === 'starting') return 'ok';
  if (state === 'cancelled') return 'warn';
  return 'error';
}
