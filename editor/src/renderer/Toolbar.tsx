import { useState, type KeyboardEvent } from 'react';
import type { Config } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import { deckChoices, layoutFor, pageChoices, profileChoices, type Selection } from './model.js';

interface Props {
  config: Config;
  daemon: DaemonView;
  selection: Selection;
  editingBlocked: boolean;
  onSelect: (change: Partial<Selection>) => void;
  onAddPage: (name: string) => Promise<AddPageResult>;
}

export type AddPageResult = { ok: true; page: string } | { ok: false; error: string };

/**
 * Breadcrumb — profile → device → page (scope §10). Choosing a profile or a
 * page shows it on the decks, and the breadcrumb follows the decks when they
 * change from elsewhere (live switching, 2026-09-15). The selected profile is
 * the one showing, so the dropdown needs no marker for it.
 */
export function Toolbar({ config, daemon, selection, editingBlocked, onSelect, onAddPage }: Props) {
  const decks = deckChoices(config, selection.profile, daemon);
  const selectedDeck = decks.find((d) => d.id === selection.serial);
  const layout = layoutFor(config, selection.profile, selection.serial);

  return (
    <header className="toolbar glass">
      <label className="crumb">
        <span className="crumb-label">Profile</span>
        <select value={selection.profile} onChange={(e) => onSelect({ profile: e.target.value })}>
          {profileChoices(config).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <span className="crumb-sep">›</span>
      <label className="crumb">
        <span className="crumb-label">Device</span>
        <select value={selection.serial} onChange={(e) => onSelect({ serial: e.target.value })}>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.connected ? '' : ' — not connected'}
              {d.hasLayout ? '' : ' — no layout in this profile'}
            </option>
          ))}
        </select>
      </label>
      <span className="crumb-sep">›</span>
      <nav className="tabs" aria-label="Pages">
        {layout &&
          pageChoices(layout).map((p) => (
            <button
              key={p.id}
              className={p.id === selection.page ? 'tab tab-selected' : 'tab'}
              onClick={() => onSelect({ page: p.id })}
            >
              {p.label}
            </button>
          ))}
        {layout && <AddPage disabled={editingBlocked} onAdd={onAddPage} onAdded={(page) => onSelect({ page })} />}
      </nav>
      <span className="toolbar-spacer" />
      {/* The selected deck's connection state (scope §10, changed 2026-09-15). */}
      {selectedDeck && (
        <span className={selectedDeck.connected ? 'pill pill-connected' : 'pill pill-disconnected'} role="status">
          <span className="pill-dot" aria-hidden="true" />
          {selectedDeck.connected ? 'Connected' : 'Not connected'}
        </span>
      )}
    </header>
  );
}

function AddPage({ disabled, onAdd, onAdded }: { disabled: boolean; onAdd: (name: string) => Promise<AddPageResult>; onAdded: (page: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const result = await onAdd(name);
    if (!result.ok) {
      setError(result.error); // e.g. a name this deck already has; the field stays open
      return;
    }
    setEditing(false);
    setName('');
    setError(null);
    onAdded(result.page);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void submit();
    if (e.key === 'Escape') {
      setEditing(false);
      setName('');
      setError(null);
    }
  };

  if (!editing) {
    return (
      <button className="tab tab-add" disabled={disabled} title="Add a page to this deck" onClick={() => setEditing(true)}>
        + Page
      </button>
    );
  }
  return (
    <span className="add-page">
      <input
        autoFocus
        placeholder="New page name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
        onBlur={() => name === '' && setEditing(false)}
      />
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}
