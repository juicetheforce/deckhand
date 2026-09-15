import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The daemon's own modules, imported rather than copied. keymap.ts has no
// imports, so it is safe in the renderer. Socket result types come from
// control/protocol.ts, which imports nothing that touches Node.
import { parseCombo } from '../../../src/keymap.js';
import type { StateSnapshot } from '../../../src/control/protocol.js';
import type { DeckhandBridge, SharedImportReport } from '../shared/bridge.js';

declare global {
  interface Window {
    deckhand: DeckhandBridge;
  }
}

function sharedImportReport(): SharedImportReport {
  const snapshot: StateSnapshot = { activeProfile: { id: 'default', name: 'Default' }, decks: [] };
  const profileId = snapshot.activeProfile?.id ?? 'none';
  try {
    return { parseCombo: parseCombo('ctrl+1'), protocolTypeUsed: profileId };
  } catch (err) {
    return { parseCombo: [], protocolTypeUsed: profileId, error: (err as Error).message };
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

window.deckhand.reportSharedImports(sharedImportReport());
