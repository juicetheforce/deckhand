import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeckhandBridge } from '../shared/bridge.js';
import { App } from './App.js';
import { runCheck } from './checks.js';
import { applyAccent, SettingsWindow } from './SettingsWindow.js';
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

createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'settings' ? <SettingsWindow /> : <App />}</StrictMode>);

const check = new URLSearchParams(window.location.search).get('check');
if (check) void runCheck(check, window.deckhand);
