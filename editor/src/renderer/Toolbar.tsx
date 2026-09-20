import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { SettingsGlyph } from './SettingsWindow.js';
import type { Config } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import { connectionPill, deckChoices, knownDecks, layoutFor, pageChoices, profileChoices, profileCoverage, type DeckChoice, type Selection } from './model.js';
import { pagesWithNoWayOff } from '../shared/links.js';
import { EditIcon } from './icons.js';

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
  /** Rename a page. Returns an error to show, or null. */
  onRenamePage: (page: string, name: string) => Promise<string | null>;
  /** Rename a profile (M5). Returns an error to show, or null. */
  onRenameProfile: (profile: string, name: string) => Promise<string | null>;
  /** Ask to delete a profile; App shows the confirmation, which names everything that changes. */
  onDeleteProfile: (profile: string) => void;
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
export function Toolbar({ config, daemon, selection, editingBlocked, onSelect, onAddPage, onAddProfile, onProfileAdded, onRenameDeck, onRenamePage, onRenameProfile, onDeleteProfile, onDeletePage }: Props) {
  const decks = deckChoices(config, selection.profile, daemon);
  const selectedDeck = decks.find((d) => d.id === selection.serial);
  const pill = connectionPill(config, daemon, selection);
  const layout = layoutFor(config, selection.profile, selection.serial);
  // The guard (scope §10): no key is auto-reserved for Back, so a page you
  // cannot leave is flagged on its tab instead.
  const stranded = layout ? new Set(pagesWithNoWayOff(layout)) : new Set<string>();
  // The same treatment for a profile that leaves a connected deck showing
  // whatever it had (scope §3).
  const uncovered = profileCoverage(config, daemon, selection.profile).uncoveredConnected;

  return (
    <header className="toolbar glass">
      <ProfileCrumb
        config={config}
        profile={selection.profile}
        disabled={editingBlocked}
        onSelect={(profile) => onSelect({ profile })}
        onDelete={() => onDeleteProfile(selection.profile)}
      />
      {Object.prototype.hasOwnProperty.call(config.profiles, selection.profile) && (
        <RenameControl
          key={`profile:${selection.profile}`}
          fieldLabel="Profile name"
          buttonLabel={`Rename profile "${config.profiles[selection.profile].name ?? selection.profile}"`}
          name={config.profiles[selection.profile].name ?? ''}
          disabled={editingBlocked}
          onRename={(name) => onRenameProfile(selection.profile, name)}
        />
      )}
      <span className="crumb-sep">›</span>
      <label className="crumb">
        <span className="crumb-label">Device</span>
        {/* data-crumb, like the tabs' data-tab: a stable hook for the checks,
            so matching on rendered text does not break when the row grows. */}
        <select data-crumb="device" value={selection.serial} onChange={(e) => onSelect({ serial: e.target.value })} disabled={decks.length === 0}>
          {/* An empty dropdown reads as a working editor with nothing chosen
              yet, which is what the maintainer saw on a machine with no deck (scope §7).
              Say there is nothing to choose from. */}
          {decks.length === 0 && <option value="">No decks</option>}
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.connected ? '' : ' — not connected'}
            </option>
          ))}
        </select>
      </label>
      {selectedDeck && (
        <RenameControl
          key={`deck:${selectedDeck.id}`}
          fieldLabel="Deck name"
          buttonLabel={
            config.decks?.[selectedDeck.id]?.name === undefined
              ? `No name set — showing the model name, ${selectedDeck.label}. Click to name this deck.`
              : `Rename "${config.decks[selectedDeck.id].name}"`
          }
          name={config.decks?.[selectedDeck.id]?.name ?? ''}
          placeholder={selectedDeck.label}
          hint={`Empty to use “${selectedDeck.label}”`}
          disabled={editingBlocked}
          onRename={(name) => onRenameDeck(selectedDeck.id, name.trim() === '' ? null : name)}
        />
      )}
      <span className="crumb-sep">›</span>
      <nav className="tabs" aria-label="Pages">
        {layout &&
          pageChoices(layout).map((p) => (
            <Fragment key={p.id}>
              <PageTab
                label={p.label}
                selected={p.id === selection.page}
                stranded={stranded.has(p.id)}
                disabled={editingBlocked}
                onSelect={() => onSelect({ page: p.id })}
                onDelete={() => onDeletePage(p.id)}
              />
              {/* One pencil, on the selected tab only: a control per tab would
                  multiply with every page created (the maintainer, 2026-09-19). */}
              {p.id === selection.page && (
                <RenameControl
                  key={`page:${p.id}`}
                  fieldLabel="Page name"
                  buttonLabel={`Rename page "${p.label}"`}
                  name={layout.pages[p.id].name ?? ''}
                  disabled={editingBlocked}
                  onRename={(name) => onRenamePage(p.id, name)}
                />
              )}
            </Fragment>
          ))}
        <AddMenu
          canAddPage={layout !== null}
          decks={knownDecks(config, daemon)}
          disabled={editingBlocked}
          onAddPage={onAddPage}
          onPageAdded={(page) => onSelect({ page })}
          onAddProfile={onAddProfile}
          onProfileAdded={onProfileAdded}
        />
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
      {/* App settings (Ship piece 3): its own window, a child of this one. Left of the pill (the maintainer). */}
      <button className="toolbar-settings" title="Settings" aria-label="Settings" onClick={() => void window.deckhand.openSettings()}>
        <SettingsGlyph size={18} />
      </button>
      {/* The connection state (scope §10, changed 2026-09-15; always shown
          since 2026-09-20). It used to render only with a deck selected, so
          the one case that most needed it — nothing connected at all — was
          the one that showed nothing (scope §7, Portability). */}
      <span className={`pill pill-${pill.state}`} role="status" data-connection={pill.state}>
        <span className="pill-dot" aria-hidden="true" />
        {pill.label}
      </span>
    </header>
  );
}

/**
 * Close a right-click menu on a click anywhere outside `wrap`, and on Escape.
 * Pointerdown rather than click, so the menu is gone before the thing
 * underneath reacts.
 */
function useCloseMenu(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, wrap, close]);
}

/**
 * Name a new page. Reached from the "+" menu, which is the trigger — so this
 * shows the field straight away rather than another button behind the first
 * (which is what it did when the toolbar had its own "+ Page").
 */
function AddPage({ disabled, onAdd, onAdded }: { disabled: boolean; onAdd: (name: string) => Promise<AddPageResult>; onAdded: (page: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const result = await onAdd(name);
    if (!result.ok) {
      setError(result.error); // e.g. a name this deck already has; the field stays open
      return;
    }
    onAdded(result.page);
  };

  return (
    <span className="add-page">
      <input
        autoFocus
        aria-label="New page name"
        placeholder="New page name"
        value={name}
        disabled={disabled}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') void submit();
        }}
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

  const closeMenu = useCallback(() => setMenu(false), []);
  useCloseMenu(menu, wrap, closeMenu);

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
      {/* Right-click is the way to delete (the maintainer, 2026-09-16): a per-tab
          button costs a slot on every page ever created. Rename is the pencil
          beside the selected tab, as for profile and device (2026-09-19). */}
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
/**
 * Create a profile, reached from the "+" menu which owns the positioning
 * wrapper. The deck checkboxes are the point, not a detail: §2 records that
 * the maintainer never found profiles in StreamController, so the control that makes one
 * has to say plainly that it covers both decks at once. Connected decks start
 * ticked.
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
  const [name, setName] = useState('');
  // Connected decks start ticked; the list is fixed while the panel is open.
  const [chosen, setChosen] = useState<string[]>(() => decks.filter((d) => d.connected).map((d) => d.id));
  const [error, setError] = useState<string | null>(null);

  const toggle = (serial: string) =>
    setChosen((current) => (current.includes(serial) ? current.filter((s) => s !== serial) : [...current, serial]));

  const submit = async () => {
    const result = await onAdd(name, chosen);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onAdded(result.profile);
  };

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
        <button className="primary" disabled={disabled || name.trim() === '' || chosen.length === 0} onClick={() => void submit()}>
          Create
        </button>
      </div>
    </div>
  );
}

/**
 * One "+" for both new pages and new profiles (the maintainer, 2026-09-16). The toolbar
 * is the row that fills up as pages are added — FFXIV alone is three or four
 * tabs per device — so two labelled buttons is space the tabs will want.
 *
 * It is a button with a menu, not a right-click: §2's distinction is that
 * *operations* on something you can already see may hide behind a gesture, but
 * a *capability* may not. The maintainer never found profiles in StreamController
 * because nothing said the concept existed, and right-clicking does not help
 * when you do not know what to right-click. Clicking "+" is the obvious move
 * when you want to add something, and the menu then names both concepts.
 */
function AddMenu({
  canAddPage,
  decks,
  disabled,
  onAddPage,
  onPageAdded,
  onAddProfile,
  onProfileAdded,
}: {
  canAddPage: boolean;
  decks: DeckChoice[];
  disabled: boolean;
  onAddPage: (name: string) => Promise<AddPageResult>;
  onPageAdded: (page: string) => void;
  onAddProfile: (name: string, serials: string[]) => Promise<AddProfileResult>;
  onProfileAdded: (profile: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'page' | 'profile'>('menu');
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setMode('menu');
  };

  return (
    <span className="add-menu-wrap" ref={wrap}>
      <button
        className="tab tab-add"
        disabled={disabled}
        aria-expanded={open}
        aria-label="Add a page or a profile"
        title="Add a page or a profile"
        onClick={() => {
          setMode('menu');
          setOpen((o) => !o);
        }}
      >
        +
      </button>

      {open && mode === 'menu' && (
        <ul className="tab-menu" role="menu">
          <li>
            <button role="menuitem" className="tab-menu-item" disabled={!canAddPage} onClick={() => setMode('page')}>
              New page
              <span className="menu-note">another page on this deck</span>
            </button>
          </li>
          <li>
            <button role="menuitem" className="tab-menu-item" onClick={() => setMode('profile')}>
              New profile
              <span className="menu-note">a layout for several decks, switched together</span>
            </button>
          </li>
        </ul>
      )}

      {open && mode === 'page' && (
        <div className="tab-menu add-panel">
          <AddPage
            disabled={disabled}
            onAdd={onAddPage}
            onAdded={(page) => {
              close();
              onPageAdded(page);
            }}
          />
        </div>
      )}

      {open && mode === 'profile' && (
        <NewProfile
          decks={decks}
          disabled={disabled}
          onAdd={onAddProfile}
          onAdded={(profile) => {
            close();
            onProfileAdded(profile);
          }}
        />
      )}
    </span>
  );
}

/**
 * The Profile dropdown, and the right-click that deletes (M5, the maintainer
 * 2026-09-19). Rename is the pencil beside it; delete hides behind the
 * gesture, deliberately: "a permanent delete control in the toolbar sits one
 * misclick from wiping 60 keys", and deleting a profile is an operation on
 * something already on screen (scope §10). The same menu a page tab has.
 */
function ProfileCrumb({
  config,
  profile,
  disabled,
  onSelect,
  onDelete,
}: {
  config: Config;
  profile: string;
  disabled: boolean;
  onSelect: (profile: string) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  useCloseMenu(menu, wrap, closeMenu);

  return (
    <span className="crumb tab-wrap" ref={wrap}>
      <span className="crumb-label">Profile</span>
      <select
        value={profile}
        onChange={(e) => onSelect(e.target.value)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!disabled) setMenu(true);
        }}
      >
        {profileChoices(config).map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
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
              Delete profile…
            </button>
          </li>
        </ul>
      )}
    </span>
  );
}

/**
 * Rename by pencil — the one control for profile, device and page (the maintainer,
 * 2026-09-19): a visible pencil beside the thing, which becomes a field in its
 * place. Enter or leaving the field saves; Escape cancels; a refusal (a name
 * already in use, a blank one) stays open and says why.
 */
function RenameControl({
  fieldLabel,
  buttonLabel,
  name,
  placeholder,
  hint,
  disabled,
  onRename,
}: {
  /** The field's accessible name: "Profile name", "Deck name", "Page name". */
  fieldLabel: string;
  /** The pencil's tooltip and accessible name. */
  buttonLabel: string;
  /** The name the field starts with. */
  name: string;
  placeholder?: string;
  /** A short line beside the field, for the deck's "empty uses the model name". */
  hint?: string;
  disabled: boolean;
  /** Returns an error to show, or null when renamed. */
  onRename: (name: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const failure = await onRename(text);
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
        className="icon-button"
        disabled={disabled}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => {
          setText(name);
          setError(null);
          setEditing(true);
        }}
      >
        <EditIcon />
      </button>
    );
  }
  return (
    <span className="rename-inline">
      <input
        autoFocus
        aria-label={fieldLabel}
        placeholder={placeholder}
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
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}
