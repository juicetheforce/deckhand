import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeckhandBridge } from '../shared/bridge.js';
import { runCheck } from './checks.js';

declare global {
  interface Window {
    deckhand: DeckhandBridge;
  }
}

function App() {
  return <p>Deckhand editor — nothing here yet.</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const check = new URLSearchParams(window.location.search).get('check');
if (check) void runCheck(check, window.deckhand);
