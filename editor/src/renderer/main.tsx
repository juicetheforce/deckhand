import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeckhandBridge } from '../shared/bridge.js';
import { App } from './App.js';
import { runCheck } from './checks.js';
import './styles.css';

declare global {
  interface Window {
    deckhand: DeckhandBridge;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const check = new URLSearchParams(window.location.search).get('check');
if (check) void runCheck(check, window.deckhand);
