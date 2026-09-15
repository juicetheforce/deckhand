import type { DaemonView, StoreState } from '../shared/bridge.js';

interface Props {
  store: StoreState;
  daemon: DaemonView;
}

/**
 * Transient notices only — no permanent status chrome (scope §10). Each one
 * is shown only while its condition holds.
 */
export function Notices({ store, daemon }: Props) {
  const api = window.deckhand;
  const lastReload = daemon.status?.config.lastReload;

  return (
    <div className="notices" role="status">
      {store.conflict && (
        <div className="notice notice-warning">
          <p>
            <strong>config.json was changed outside the editor</strong> while you had unsaved edits. Nothing has been
            overwritten. Keep which version?
          </p>
          {store.conflict.fileError && <p className="muted">The file's version is not usable: {store.conflict.fileError}</p>}
          <div className="notice-actions">
            <button onClick={() => void api.resolveConflict('file')}>Keep the file's version</button>
            <button onClick={() => void api.resolveConflict('mine')}>Keep my edits</button>
          </div>
        </div>
      )}
      {store.fileError && (
        <div className="notice notice-error">
          <p>
            <strong>config.json on disk is not usable</strong>, so editing is paused until it is fixed: {store.fileError}
          </p>
        </div>
      )}
      {store.reformatPending && (
        <div className="notice notice-warning">
          <p>
            <strong>config.json is not in the editor's format</strong> (two-space JSON). The first save will rewrite its
            layout, so a diff will show every line. Nothing is saved until you allow it.
          </p>
          <div className="notice-actions">
            <button onClick={() => void api.acknowledgeReformat()}>Allow reformatting</button>
          </div>
        </div>
      )}
      {store.saveError && (
        <div className="notice notice-error">
          <p>
            <strong>Could not save:</strong> {store.saveError}
          </p>
        </div>
      )}
      {!daemon.connected && (
        <div className="notice notice-info">
          <p>
            <strong>Not connected to the daemon:</strong> {daemon.problem}. Edits are still saved; the decks pick them up
            when it runs.
          </p>
        </div>
      )}
      {lastReload && !lastReload.ok && (
        <div className="notice notice-error">
          <p>
            <strong>The daemon refused the last config it read</strong> and kept the previous one: {lastReload.error}
          </p>
        </div>
      )}
    </div>
  );
}
