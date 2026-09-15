import { useEffect, useRef, useState } from 'react';
import { startPageOf } from '../../../src/config-common.js';
import type { DaemonResult, DaemonView, StoreState } from '../shared/bridge.js';
import { DeckGrid } from './DeckGrid.js';
import { Inspector } from './Inspector.js';
import { Library } from './Library.js';
import { canSwitchDeck, deckForProfile, followDeck, geometryFor, layoutFor, reconcileSelection, type Selection } from './model.js';
import { Notices } from './Notices.js';
import { Toolbar, type AddPageResult } from './Toolbar.js';
import { useEditor } from './useEditor.js';

export function App() {
  const snapshot = useEditor();
  if (!snapshot) return <div className="app-loading">Loading…</div>;
  if (!snapshot.store.open) return <CannotOpen error={snapshot.store.error} />;
  return <Editor store={snapshot.store.state} daemon={snapshot.daemon} />;
}

function CannotOpen({ error }: { error: string }) {
  return (
    <main className="cannot-open glass">
      <h1>config.json could not be opened</h1>
      <p>{error}</p>
      <button onClick={() => void window.deckhand.reopenConfig()}>Try again</button>
    </main>
  );
}

function Editor({ store, daemon }: { store: StoreState; daemon: DaemonView }) {
  const config = store.config;
  const [selection, setSelection] = useState<Selection>(() => followDeck(config, daemon, reconcileSelection(config, daemon, null)));
  // Switches sent to the daemon and not yet answered. While one is in flight
  // the breadcrumb shows what was chosen; state events from before the switch
  // would otherwise pull it back for a moment.
  const [inFlight, setInFlight] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** Bumped when the library's Hotkey entry is clicked, to start listening in the inspector. */
  const [listenToken, setListenToken] = useState(0);

  // Follow the decks (scope §10): any change to the config or to what the
  // decks show moves the breadcrumb to match — unconditionally, mid-edit too.
  useEffect(() => {
    if (inFlight > 0) return;
    setSelection((current) => followDeck(config, daemon, current));
  }, [config, daemon, inFlight]);

  // The latest daemon view, for code waiting inside a switch.
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;

  /**
   * Send a switch and hold the breadcrumb on the choice until the daemon's
   * state shows it. The daemon replies to a switch before its merged `state`
   * event arrives, so resuming on the reply let the breadcrumb jump back for a
   * moment (caught by scripts/check-live.mjs). At most a second, then follow
   * whatever the deck reports.
   */
  const sendSwitch = async (call: () => Promise<DaemonResult>, shows: (view: DaemonView) => boolean) => {
    setInFlight((n) => n + 1);
    try {
      const result = await call();
      setSwitchError(result.ok ? null : `Could not switch the deck: ${result.error}`);
      if (result.ok) {
        const started = Date.now();
        while (!shows(daemonRef.current) && Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      // Back to following: if the switch failed, the breadcrumb returns to what the deck really shows.
      setInFlight((n) => n - 1);
    }
  };
  const deckShows = (serial: string, check: (deck: { profile?: string; page?: string }) => boolean) => (view: DaemonView) =>
    view.status?.decks.some((d) => d.serial === serial && check(d)) ?? false;

  const select = (change: Partial<Selection>) => {
    if (change.profile !== undefined && change.profile !== selection.profile) {
      // Live switching: choosing a profile makes it active on the decks.
      const profile = change.profile;
      const serial = deckForProfile(config, daemon, profile, selection.serial);
      const layout = layoutFor(config, profile, serial);
      setSelection(reconcileSelection(config, daemon, { profile, serial, page: layout ? startPageOf(layout) : '', key: null }));
      if (daemon.connected) {
        void sendSwitch(
          () => window.deckhand.switchProfile(profile),
          (view) => view.status?.activeProfile?.id === profile,
        );
      }
      return;
    }
    if (change.serial !== undefined && change.serial !== selection.serial) {
      // Choosing a device opens whatever that deck is showing; nothing is sent.
      setSelection(followDeck(config, daemon, { ...selection, serial: change.serial, key: null }));
      return;
    }
    if (change.page !== undefined && change.page !== selection.page) {
      // Live switching: choosing a page shows it on the deck being edited.
      const page = change.page;
      const serial = selection.serial;
      setSelection(reconcileSelection(config, daemon, { ...selection, page, key: null }));
      if (canSwitchDeck(daemon, serial)) {
        void sendSwitch(
          () => window.deckhand.showPage(serial, page),
          deckShows(serial, (d) => d.page === page),
        );
      }
    }
  };

  const editingBlocked = store.conflict !== null || store.fileError !== null;
  const layout = layoutFor(config, selection.profile, selection.serial);
  const page = layout?.pages[selection.page];
  const geometry = geometryFor(daemon, selection.serial);

  const addPage = async (name: string): Promise<AddPageResult> => {
    const result = await window.deckhand.apply({ kind: 'addPage', profile: selection.profile, serial: selection.serial, name });
    return result.ok ? { ok: true, page: result.result.pageId! } : { ok: false, error: result.error };
  };

  return (
    <div className="app">
      <Toolbar
        config={config}
        daemon={daemon}
        selection={selection}
        editingBlocked={editingBlocked}
        onSelect={select}
        onAddPage={addPage}
      />
      <div className="panes">
        <Library onPick={(type) => type === 'hotkey' && selection.key !== null && setListenToken((n) => n + 1)} />
        <main className="stage glass">
          <Notices store={store} daemon={daemon} switchError={switchError} />
          <div className="well">
            {!layout && <p className="muted">This profile has no layout for this deck.</p>}
            {layout && !geometry && (
              <p className="muted">
                This deck is not connected. Its layout comes from the deck itself, so plug it in to edit this page.
              </p>
            )}
            {layout && geometry && page && (
              <DeckGrid
                config={config}
                geometry={geometry}
                page={page}
                selectedKey={selection.key}
                onSelectKey={(key) => setSelection((s) => ({ ...s, key }))}
              />
            )}
          </div>
        </main>
        <Inspector
          at={selection.key === null || !page ? null : { profile: selection.profile, serial: selection.serial, page: selection.page, index: selection.key }}
          button={selection.key === null ? undefined : page?.buttons[String(selection.key)]}
          editingBlocked={editingBlocked}
          listenToken={listenToken}
          apply={async (edit) => {
            const result = await window.deckhand.apply(edit);
            return result.ok ? null : result.error;
          }}
        />
      </div>
    </div>
  );
}
