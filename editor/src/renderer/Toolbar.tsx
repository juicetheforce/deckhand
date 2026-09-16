import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Config } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import { deckChoices, knownDecks, layoutFor, pageChoices, profileChoices, profileCoverage, type DeckChoice, type Selection } from './model.js';
import { pagesWithNoWayOff } from '../shared/links.js';

interface Props {
  config: Config;
  daemon: DaemonView;
  selection: Selection;
  editingBlocked: boolean;
  onSelect: (change: Partial<Selection>) => void;
  onAddPage: (name: string) => Promise<AddPageResult>;
  onAddProfile: (name: string, serials: string[]) => Promise<AddProfileResult>;
  /** A profile that exists only in the edit just made cannot go through onSelect. */
  onProfileAdded: (profile: string) => void;
  /** Rename the selected deck, or (null) clear the name back to the model name. */
  onRenameDeck: (serial: string, name: string | null) => Promise<string | null>;
  /** Ask to delete a page; App shows the confirmation, since it names what would change. */
  onDeletePage: (page: string) => void;
}

export type AddPageResult = { ok: true; page: string } | { ok: false; error: string };
export type AddProfileResult = { ok: true; profile: string } | { ok: false; error: string };

/**
 * Breadcrumb — profile → device → page (scope §10). Choosing a profile or a
 * page shows it on the decks, and the breadcrumb follows the decks when they
 * change from elsewhere (live switching, 2026-09-15). The selected profile is
 * the one showing, so the dropdown needs no marker for it.
 */
export function Toolbar({ config, daemon, selection, editingBlocked, onSelect, onAddPage, onAddProfile, onProfileAdded, onRenameDeck, onDeletePage }: Props) {
  const decks = deckChoices(config, selection.profile, daemon);
  const selectedDeck = decks.find((d) => d.id === selection.serial);
  const layout = layoutFor(config, selection.profile, selection.serial);
  // The guard (scope §10): no key is auto-reserved for Back, so a page you
  // cannot leave is flagged on its tab instead.
  const stranded = layout ? new Set(pagesWithNoWayOff(layout)) : new Set<string>();
  // The same treatment for a profile that leaves a connected deck showing
  // whatever it had (scope §3).
  const uncovered = profileCoverage(config, daemon, selection.profile).uncoveredConnected;

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
      <NewProfile
        decks={knownDecks(config, daemon)}
        disabled={editingBlocked}
        onAdd={onAddProfile}
        onAdded={onProfileAdded}
      />
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
      {selectedDeck && (
        <RenameDeck
          serial={selectedDeck.id}
          name={config.decks?.[selectedDeck.id]?.name ?? null}
          modelName={selectedDeck.label}
          disabled={editingBlocked}
          onRename={onRenameDeck}
        />
      )}
      <span className="crumb-sep">›</span>
      <nav className="tabs" aria-label="Pages">
        {layout &&
          pageChoices(layout).map((p) => (
            <PageTab
              key={p.id}
              label={p.label}
              selected={p.id === selection.page}
              stranded={stranded.has(p.id)}
              disabled={editingBlocked}
              onSelect={() => onSelect({ page: p.id })}
              onDelete={() => onDeletePage(p.id)}
            />
          ))}
        {layout && <AddPage disabled={editingBlocked} onAdd={onAddPage} onAdded={(page) => onSelect({ page })} />}
      </nav>
      <span className="toolbar-spacer" />
      {uncovered.length > 0 && (
        <span
          className="warn-badge"
          role="status"
          title={`This profile has no layout for ${uncovered.join(' and ')}, so ${uncovered.length === 1 ? 'it keeps' : 'they keep'} whatever ${uncovered.length === 1 ? 'was on it' : 'was on them'} when you switch to it.`}
        >
          ⚠ {uncovered.length === 1 ? `${uncovered[0]} not covered` : `${uncovered.length} decks not covered`}
        </span>
      )}
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

/**
 * A page tab, and the menu that deletes it. Two ways in, because §2 wants
 * discoverability on return rather than efficiency of repeated use: right-click
 * anywhere on the tab, or the ⋯ button, which only the selected tab shows so
 * the row stays quiet. Deleting is confirmed by App, which names what it clears.
 */
function PageTab({
  label,
  selected,
  stranded,
  disabled,
  onSelect,
  onDelete,
}: {
  label: string;
  selected: boolean;
  /** No key on this page can leave it (scope §10's guard). */
  stranded: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  // Close on a click anywhere else, and on Escape. Pointerdown rather than
  // click, so the menu is gone before the thing underneath reacts.
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [menu]);

  return (
    <span className="tab-wrap" ref={wrap}>
      <button
        className={selected ? 'tab tab-selected' : 'tab'}
        /* The plain page name, for checks to select by. The tab's textContent
           carries decoration — the guard badge today, default icons in phase C
           — so matching on rendered text breaks whenever the tab grows
           something (it broke check:live and check:icons, 2026-09-16). */
        data-tab={label}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!disabled) setMenu(true);
        }}
      >
        {label}
        {stranded && (
          <span className="tab-warn" title="No key on this page goes to another page or profile, so there is no way off it from the deck.">
            ⚠
          </span>
        )}
      </button>
      {selected && (
        <button
          className="tab-more"
          aria-label={`Page options for ${label}`}
          aria-expanded={menu}
          disabled={disabled}
          onClick={() => setMenu((open) => !open)}
        >
          ⋯
        </button>
      )}
      {menu && (
        <ul className="tab-menu" role="menu">
          <li>
            <button
              role="menuitem"
              className="tab-menu-item danger"
              onClick={() => {
                setMenu(false);
                onDelete();
              }}
            >
              Delete page…
            </button>
          </li>
        </ul>
      )}
    </span>
  );
}

/**
 * Create a profile (scope §7, B1). The deck checkboxes are the point, not a
 * detail: §2 records that the maintainer never found profiles in StreamController, so the
 * control that makes one has to say plainly that it covers both decks at once.
 * Connected decks start checked.
 */
function NewProfile({
  decks,
  disabled,
  onAdd,
  onAdded,
}: {
  decks: DeckChoice[];
  disabled: boolean;
  onAdd: (name: string, serials: string[]) => Promise<AddProfileResult>;
  onAdded: (profile: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setName('');
    setChosen(decks.filter((d) => d.connected).map((d) => d.id));
    setError(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setError(null);
  };
  const toggle = (serial: string) =>
    setChosen((current) => (current.includes(serial) ? current.filter((s) => s !== serial) : [...current, serial]));

  const submit = async () => {
    const result = await onAdd(name, chosen);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    close();
    onAdded(result.profile);
  };

  // The button stays in the flow and the panel hangs off it, so opening the
  // panel does not reflow the breadcrumb.
  return (
    <span className="new-profile-wrap">
      <button
        className="crumb-add"
        disabled={disabled}
        title="Create a profile"
        aria-expanded={open}
        onClick={() => (open ? close() : start())}
      >
        + Profile
      </button>
      {open && <Panel />}
    </span>
  );

  function Panel() {
    return (
      <div className="new-profile glass" role="dialog" aria-label="New profile">
        <input
          autoFocus
          aria-label="Profile name"
          placeholder="Profile name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') close();
          }}
        />
        <p className="muted small">Switching to this profile changes every deck you tick here, in one press.</p>
        <ul className="deck-ticks">
          {decks.map((deck) => (
            <li key={deck.id}>
              <label>
                <input type="checkbox" checked={chosen.includes(deck.id)} onChange={() => toggle(deck.id)} />
                {deck.label}
                {deck.connected ? '' : ' — not connected'}
              </label>
            </li>
          ))}
        </ul>
        {decks.length === 0 && <p className="muted small">No decks are known yet. Plug one in.</p>}
        {error && <p className="field-error">{error}</p>}
        <div className="button-row">
          <button className="primary" disabled={name.trim() === '' || chosen.length === 0} onClick={() => void submit()}>
            Create
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    );
  }
}

/**
 * Rename the selected deck (scope §10, the maintainer 2026-09-16). `decks.<serial>.name`
 * has been in the schema since v0.1 and deck config sits outside profiles, so a
 * name set once applies everywhere — this is UI over an existing field.
 *
 * **With no name set the model name is shown and nothing else.** No serial is
 * appended and no attempt is made to tell identical devices apart: nobody knows
 * their serials and nobody will check them. Two XLs both reading "Stream Deck
 * XL" is correct, because that is genuinely all the software knows — which is
 * which is the owner's to decide and name ("Left", "Right"), and changes when
 * they rearrange their desk. Our job is only to make naming possible.
 */
function RenameDeck({
  serial,
  name,
  modelName,
  disabled,
  onRename,
}: {
  serial: string;
  name: string | null;
  modelName: string;
  disabled: boolean;
  onRename: (serial: string, name: string | null) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setText(name ?? '');
    setError(null);
    setEditing(true);
  };
  const submit = async () => {
    const failure = await onRename(serial, text.trim() === '' ? null : text);
    if (failure !== null) {
      setError(failure);
      return;
    }
    setEditing(false);
    setError(null);
  };

  if (!editing) {
    return (
      <button
        className="crumb-add"
        disabled={disabled}
        title={name === null ? `No name set — showing the model name, ${modelName}. Click to name this deck.` : `Rename "${name}"`}
        onClick={start}
      >
        Rename
      </button>
    );
  }
  return (
    <span className="rename-deck">
      <input
        autoFocus
        aria-label="Deck name"
        placeholder={modelName}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={() => void submit()}
      />
      <span className="muted small">Empty to use “{modelName}”</span>
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}
