import { useEffect, useState, type ReactNode } from 'react';
import type { WindowAction, WindowState } from '../shared/bridge.js';

/**
 * The window's own title bar (Ship piece 4, scope §10), after mockups 2a and
 * 6a. Both windows are frameless, so this is the only bar they have.
 *
 * - **Dragging** is styles.css: the bar is `-webkit-app-region: drag` and its
 *   buttons `no-drag`. Double-clicking it maximises and right-clicking it opens
 *   KWin's window menu — Chromium and the compositor do both, nothing here
 *   does (measured 2026-09-18, scope §10).
 * - **Buttons on the right**, minimise, maximise, close: Breeze's default order,
 *   hardcoded rather than read from kwinrc (the maintainer, 2026-09-18). The settings
 *   window has close only.
 * - **Maximise shows where it goes**: the maximise mark while restored, the
 *   restore mark while maximised.
 * - **Dimmed while another window is active**, because nothing outside the
 *   application dims it (main.ts, reportWindowState).
 *
 * `children` is what sits on the left: the logo in the editor, the gear and
 * "Settings" in the settings window. The middle stays empty (the maintainer: the
 * breadcrumb below already says which profile and deck).
 */
export function TitleBar({ closeOnly = false, children }: { closeOnly?: boolean; children: ReactNode }) {
  const [state, setState] = useState<WindowState>({ maximised: false, focused: true });

  useEffect(() => {
    let live = true;
    // Read once, then follow: a reload is not a maximise or focus event, so a
    // window maximised before one would otherwise draw the wrong mark.
    void window.deckhand.windowState().then((s) => {
      if (live) setState(s);
    });
    const stop = window.deckhand.onWindowState(setState);
    return () => {
      live = false;
      stop();
    };
  }, []);

  const act = (action: WindowAction) => void window.deckhand.windowControl(action);
  const maximiseLabel = state.maximised ? 'Restore' : 'Maximise';

  return (
    <header className="titlebar" data-focused={state.focused}>
      <div className="titlebar-start">{children}</div>
      <div className="titlebar-buttons">
        {!closeOnly && (
          <>
            <button className="titlebar-button" title="Minimise" aria-label="Minimise" onClick={() => act('minimise')}>
              <WindowGlyph kind="minimise" />
            </button>
            <button className="titlebar-button" title={maximiseLabel} aria-label={maximiseLabel} onClick={() => act('maximise')}>
              <WindowGlyph kind={state.maximised ? 'restore' : 'maximise'} />
            </button>
          </>
        )}
        <button className="titlebar-button titlebar-close" title="Close" aria-label="Close" onClick={() => act('close')}>
          <WindowGlyph kind="close" />
        </button>
      </div>
    </header>
  );
}

/** The four button marks, drawn on a 14 px grid in the text colour. */
function WindowGlyph({ kind }: { kind: 'minimise' | 'maximise' | 'restore' | 'close' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'minimise' && <path d="M3 7.5 H11" />}
      {kind === 'maximise' && <rect x="3" y="3" width="8" height="8" rx="1.5" />}
      {kind === 'restore' && (
        <>
          <rect x="2.5" y="4.5" width="7" height="7" rx="1.5" />
          <path d="M5 2.5 H10 A1.5 1.5 0 0 1 11.5 4 V9" />
        </>
      )}
      {kind === 'close' && <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" />}
    </svg>
  );
}
