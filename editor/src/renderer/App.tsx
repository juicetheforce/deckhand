import { useEffect, useState } from 'react';
import type { StoreState, DaemonView } from '../shared/bridge.js';
import { DeckGrid } from './DeckGrid.js';
import { Inspector } from './Inspector.js';
import { Library } from './Library.js';
import { geometryFor, layoutFor, reconcileSelection, type Selection } from './model.js';
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
  const [selection, setSelection] = useState<Selection>(() => reconcileSelection(config, daemon, null));

  // A reload, a page added, a deck plugged in: keep the selection if it still exists.
  useEffect(() => {
    setSelection((current) => reconcileSelection(config, daemon, current));
  }, [config, daemon]);

  const select = (change: Partial<Selection>) =>
    setSelection((current) => reconcileSelection(config, daemon, { ...current, key: null, ...change }));

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
        <Library />
        <main className="stage glass">
          <Notices store={store} daemon={daemon} />
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
        <Inspector index={selection.key} button={selection.key === null ? undefined : page?.buttons[String(selection.key)]} />
      </div>
    </div>
  );
}
