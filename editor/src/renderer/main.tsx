import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeckhandBridge } from '../shared/bridge.js';
import { App } from './App.js';
import { runCheck } from './checks.js';
import logoUrl from '../../../assets/logo/deckhand-small.svg';
import { applyAccent, SettingsWindow } from './SettingsWindow.js';
import { TitleBar } from './TitleBar.js';
import './styles.css';

declare global {
  interface Window {
    deckhand: DeckhandBridge;
  }
}

// One bundle, two windows: the settings window loads it with ?view=settings (Ship piece 3).
const view = new URLSearchParams(window.location.search).get('view');
if (view === 'settings') {
  document.title = 'Deckhand Settings';
  document.body.classList.add('settings-body');
}

// The accent colour applies in both windows, and changes the moment it is picked.
void window.deckhand.appSettings().then((s) => applyAccent(s.accent));
window.deckhand.onAppSettings((s) => applyAccent(s.accent));

// The title bar sits outside App, so the window can be moved and closed
// whatever App is showing — loading, or config.json that could not be opened.
// The logo at 18 px is deckhand-small.svg, the one drawn for 16–32 px (scope §7).
const editor = (
  <div className="window">
    <TitleBar>
      <img className="titlebar-logo" src={logoUrl} width={18} height={18} alt="Deckhand" />
    </TitleBar>
    <div className="window-body">
      <App />
    </div>
  </div>
);

createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'settings' ? <SettingsWindow /> : editor}</StrictMode>);

const check = new URLSearchParams(window.location.search).get('check');
if (check) void runCheck(check, window.deckhand);
