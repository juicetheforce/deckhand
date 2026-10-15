import { useEffect, useRef, useState } from 'react';
import type { TwitchLinkingState, TwitchStatus } from '../../../src/control/protocol.js';

/**
 * Settings › Integrations › Twitch (scope §7, "Streaming integrations"):
 * where a Twitch account is linked. Link asks Twitch for a code; the person
 * approves Deckhand at twitch.tv/activate, in any browser, phone included,
 * and the daemon saves the link. Remove forgets the link, ends it at
 * Twitch, and touches no key.
 *
 * **Cancel exists here**, unlike VTube Studio's Connect: stopping leaves
 * nothing behind on Twitch's side — the code just expires. A Cancel on
 * Twitch's own page is never seen by Deckhand (Twitch session 1), so the
 * code waits here until approved, expired, or cancelled here.
 *
 * No token is ever shown — the daemon never sends one — only the account
 * and what the link allows.
 */

type Message = { kind: 'ok' | 'warn' | 'error'; text: string };

/** What each scope Deckhand asks for allows, in plain words. */
const ALLOWS: Record<string, string> = {
  'channel:manage:broadcast': "set your stream's title and category, and add stream markers",
  'clips:edit': 'make clips of your stream',
  'user:write:chat': 'send chat messages as you',
};
const ASKED = ['channel:manage:broadcast', 'clips:edit', 'user:write:chat'];

/** Linking is under way: asking for a code, or the code waiting to be approved. */
const linking = (state: TwitchLinkingState | undefined) => state === 'starting' || state === 'waiting';

export function TwitchSettings({ focus }: { focus: number }) {
  /** undefined while it is first read; null with no daemon (or one without Twitch). */
  const [status, setStatus] = useState<TwitchStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void window.deckhand.twitchStatus().then(setStatus);
    return window.deckhand.onTwitchStatus(setStatus);
  }, []);

  const loaded = status !== undefined;
  useEffect(() => {
    if (focus === 0 || !loaded) return;
    section.current?.scrollIntoView({ block: 'start' });
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
    await call(() => window.deckhand.twitchLink(), 'Could not ask Twitch');
  };
  const cancel = async () => {
    setMessage(null);
    await call(() => window.deckhand.twitchCancel(), 'Not cancelled');
  };
  const remove = async () => {
    setConfirmingRemove(false);
    if (await call(() => window.deckhand.twitchRemove(), 'Not removed')) {
      setMessage({ kind: 'ok', text: 'Removed, and ended at Twitch. Twitch keys stay where they are, and work again once an account is linked.' });
    }
  };
  const openActivate = async () => {
    const result = await window.deckhand.twitchOpenActivate();
    if (!result.ok) setMessage({ kind: 'error', text: `Could not open the page: ${result.error}` });
  };

  if (status === undefined) return <div ref={section} id="settings-twitch" />;
  if (status === null) {
    return (
      <div ref={section} id="settings-twitch" className="settings-row" data-twitch-section="unavailable">
        <div className="settings-text">
          <span className="settings-title">Twitch</span>
          <span className="settings-sub">Needs Deckhand's service running: it is what talks to Twitch.</span>
        </div>
      </div>
    );
  }

  const progress = status.linking;
  const waiting = progress.state === 'waiting' && progress.userCode ? progress : null;
  // A local message (Remove, a failed call) until the next Link's progress replaces it.
  const shown: Message | null =
    message ?? (progress.state !== 'none' && progress.state !== 'waiting' && progress.message ? { kind: linkingKind(progress.state), text: progress.message } : null);
  const allows = (status.setUp ? status.scopes : ASKED).map((s) => ALLOWS[s] ?? s);

  return (
    <div ref={section} id="settings-twitch" className="obs-settings" data-twitch-section={status.link}>
      <div className="settings-text">
        <span className="settings-title">Twitch</span>
        <span className="settings-sub" data-twitch-status={status.link}>
          {statusLine(status)}
        </span>
      </div>
      <span className="settings-sub" data-twitch-allows="">
        {status.setUp ? 'The link allows Deckhand to ' : 'Linking allows Deckhand to '}
        {allows.join(', ')} — on your own channel, only when a key is pressed. Twitch lists it as DeckHandApp, at twitch.tv/settings/connections.
      </span>
      <span className="settings-sub">
        The link renews itself while Deckhand is running. If Deckhand does not run for 30 days, Twitch ends it, and you link again here.
      </span>
      {waiting && (
        <div className="twitch-code" data-twitch-code={waiting.userCode}>
          <span className="settings-sub">Approve Deckhand on Twitch, in any browser, with this code:</span>
          <span className="twitch-code-value" aria-label="Code to enter at twitch.tv/activate">
            {waiting.userCode}
          </span>
          <span className="settings-sub">
            At twitch.tv/activate{waiting.expiresAt ? `, before ${new Date(waiting.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
          </span>
        </div>
      )}
      <div className="obs-actions">
        {waiting ? (
          <>
            <button className="settings-button settings-button-primary" onClick={() => void openActivate()} data-twitch="open-activate">
              Open twitch.tv/activate
            </button>
            <button className="settings-button" disabled={busy} onClick={() => void cancel()} data-twitch="cancel">
              Cancel
            </button>
          </>
        ) : (
          <button
            ref={linkButton}
            className="settings-button settings-button-primary"
            disabled={busy || linking(progress.state)}
            onClick={() => void link()}
            data-twitch="link"
          >
            {status.setUp ? 'Link again' : 'Link Twitch account'}
          </button>
        )}
        {status.setUp && !waiting && !confirmingRemove && (
          <button className="settings-button" disabled={busy} onClick={() => setConfirmingRemove(true)} data-twitch="remove">
            Remove…
          </button>
        )}
      </div>
      {confirmingRemove && (
        <div className="obs-confirm" data-twitch-confirm="remove">
          <p className="settings-status settings-status-warn">
            Every Twitch key stops working until an account is linked again. The keys stay where they are. The link is ended at Twitch too.
          </p>
          <div className="obs-actions">
            <button className="settings-button settings-button-danger" onClick={() => void remove()} data-twitch="confirm-remove">
              Remove Twitch
            </button>
            <button className="settings-button" onClick={() => setConfirmingRemove(false)} data-twitch="keep">
              Keep
            </button>
          </div>
        </div>
      )}
      {shown && (
        <p
          className={`settings-status${shown.kind === 'error' ? ' settings-status-error' : shown.kind === 'warn' ? ' settings-status-warn' : ''}`}
          role="status"
          data-twitch-message={shown.kind}
          data-twitch-linking={message ? undefined : progress.state}
        >
          {shown.text}
        </p>
      )}
    </div>
  );
}

function statusLine(status: TwitchStatus): string {
  if (status.link === 'not-set-up') return 'Not linked. Twitch keys do nothing until an account is.';
  if (status.link === 'refused')
    return `Linked as ${status.login}, but Twitch no longer accepts the link. Deckhand keeps trying hourly, in case it is Twitch's fault; link again if it does not come back.`;
  return `Linked as ${status.login}.`;
}

/** How linking's outcome reads. */
function linkingKind(state: TwitchLinkingState): Message['kind'] {
  if (state === 'approved' || state === 'starting') return 'ok';
  if (state === 'cancelled') return 'warn';
  return 'error';
}
