import { useEffect, useRef, useState } from 'react';
import logoUrl from '../../../assets/logo/deckhand-small.svg';
import { NO_UPDATE_STATE, type UpdateState } from '../shared/updates.js';

/**
 * The Update pill, left of the settings icon, and its panel (Claude Design's 18).
 * Shown only when a newer release exists and "Not now" has not been pressed for it.
 * Nothing runs from here, and Deckhand never downloads or installs by itself: the
 * panel shows the release's own update line to copy.
 */
export function UpdatePill() {
  const [update, setUpdate] = useState<UpdateState>(NO_UPDATE_STATE);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void window.deckhand.updateState().then((s) => s && setUpdate(s));
    return window.deckhand.onUpdateState(setUpdate);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      pill.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!holder.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Copied, for 2 s, then back.
  useEffect(() => {
    if (!copied) return;
    const back = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(back);
  }, [copied]);

  if (update.status !== 'available' || update.hidden || update.latest === null) return null;
  const version = update.latest;
  return (
    <div className="update-holder" ref={holder}>
      <button
        ref={pill}
        className={open ? 'update-pill update-pill-open' : 'update-pill'}
        title={`Deckhand ${version} is available`}
        aria-label={`Update available: Deckhand ${version}`}
        aria-expanded={open}
        data-update-pill
        onClick={() => setOpen(!open)}
      >
        <span className="update-pill-dot" aria-hidden="true" />
        Update
      </button>
      {open && (
        <div className="update-panel" role="dialog" aria-label={`Deckhand ${version}`} data-update-panel>
          <div className="update-panel-head">
            <img src={logoUrl} width={30} height={30} alt="" />
            <div className="update-panel-names">
              <span className="update-panel-title">Deckhand {version}</span>
              {update.installed && <span className="update-panel-sub">You have {update.installed}</span>}
            </div>
          </div>
          <div className="update-panel-section">
            {update.whatsNew.length > 0 && <span className="update-panel-heading">What’s new</span>}
            {update.whatsNew.map((line, i) => (
              <div className="update-panel-line" key={i}>
                <span className="update-panel-bullet" aria-hidden="true" />
                <span className="update-panel-text" title={line}>
                  {line}
                </span>
              </div>
            ))}
            <button className="update-panel-link" data-update-notes onClick={() => void window.deckhand.openUpdate()}>
              Full release notes ↗
            </button>
          </div>
          {update.updateLine && (
            <div className="update-panel-section update-panel-run">
              <span className="update-panel-heading">To update, run</span>
              <div className="update-panel-command-row">
                <div className="update-panel-command" tabIndex={0} data-update-line>
                  <span className="update-panel-prompt" aria-hidden="true">
                    $
                  </span>
                  {update.updateLine}
                </div>
                <button
                  className={copied ? 'update-panel-copy update-panel-copied' : 'update-panel-copy'}
                  data-update-copy
                  onClick={() => void window.deckhand.copyUpdateLine().then((ok) => setCopied(ok))}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={copied ? 2.4 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {copied ? (
                      <path d="M5 12.5 L10 17.5 L19 7" />
                    ) : (
                      <>
                        <rect x="8" y="8" width="12" height="12" rx="2.5" />
                        <path d="M16 8 V6.5 A2.5 2.5 0 0 0 13.5 4 H6.5 A2.5 2.5 0 0 0 4 6.5 V13.5 A2.5 2.5 0 0 0 6.5 16 H8" />
                      </>
                    )}
                  </svg>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="update-panel-hint">Deckhand restarts itself when it’s done.</span>
            </div>
          )}
          <div className="update-panel-foot">
            <button
              className="update-panel-later"
              data-update-later
              onClick={() => {
                setOpen(false);
                void window.deckhand.hideUpdate();
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
