import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { builtinRef, iconUrl } from '../shared/icons.js';
import { CATALOGUE, libraryIcon, searchCatalogue, type CatalogueEntry } from './catalogue.js';

/**
 * The action library: the whole §6 catalogue, grouped (scope §10), each row
 * with its action's default icon (phase C2). Design
 * rules here all come from §2's discoverability point — an action nobody can
 * see is one nobody finds, and the maintainer never discovered profiles in
 * StreamController because nothing surfaced them:
 *
 * - **One action per row**, not a grid of tiles. In a 230 px pane two columns
 *   leave no room for a readable name beside an icon. Legibility over density
 *   (the maintainer, 2026-09-16). Each row carries its action's default icon (C2); the
 *   coloured rail each group used to have is gone with them — **the icons say
 *   what the colour did** (the maintainer, 2026-09-17).
 * - **Entries with no inspector are greyed with a reason, never hidden**
 *   (the maintainer, 2026-09-16) — the same call as showing unrenderable files in the
 *   icon picker. The tooltip distinguishes "needs daemon work" from "works by
 *   hand, only the form is missing".
 * - **Sections collapse, and default to expanded**.
 *   Collapsing is something you choose, not something you inherit. The state
 *   lives in the editor's preferences store, never config.json.
 * - **Search looks inside collapsed sections**. Collapse
 *   helps when scanning, search when you know what you want, and collapsing
 *   everything has to make search *more* useful. So a query replaces the
 *   grouped list entirely with a flat list of matches, wherever they live;
 *   clearing it restores exactly the collapse state you had, because that
 *   state is never touched while searching.
 */
export function Library({
  onPick,
  onDragStart,
}: {
  onPick: (type: string) => void;
  /** A press on a row that may become a drag onto a key (useActionDrag); null while editing is blocked. */
  onDragStart: ((type: string, e: ReactPointerEvent) => void) | null;
}) {
  // Starts expanded and stays that way until the saved state arrives, so a
  // slow read can never flash sections shut.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void window.deckhand.collapsedLibrary().then((saved) => alive && setCollapsed(saved));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (group: string) => {
    const next = collapsed.includes(group) ? collapsed.filter((g) => g !== group) : [...collapsed, group];
    setCollapsed(next);
    void window.deckhand.setCollapsedLibrary(next);
  };

  const [query, setQuery] = useState('');
  const matches = searchCatalogue(query);
  const searching = query.trim() !== '';

  return (
    <aside className="library glass" aria-label="Actions">
      <div className="library-header">
        <input
          type="search"
          aria-label="Search actions"
          placeholder="Search actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
      </div>

      <div className="library-body">
      {searching && (
        <div className="library-results">
          <p className="library-result-count">
            {matches.length === 0 ? 'No actions match.' : `${matches.length} of ${CATALOGUE.reduce((n, g) => n + g.entries.length, 0)} actions`}
          </p>
          <ul>
            {matches.map(({ group, entry }) => (
              <li key={entry.type}>
                <Entry entry={entry} onPick={onPick} onDragStart={onDragStart} />
                {/* Matches come from every section, so each says where it lives. */}
                <span className="library-result-group">{group.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!searching && CATALOGUE.map((group) => {
        const shut = collapsed.includes(group.name);
        return (
          <section key={group.name} className="library-group">
            <h2 className="library-heading">
              <button
                className="library-toggle"
                aria-expanded={!shut}
                title={shut ? `Show ${group.name} actions` : `Hide ${group.name} actions`}
                onClick={() => toggle(group.name)}
              >
                <span className={shut ? 'library-caret library-caret-shut' : 'library-caret'} aria-hidden="true">
                  ▾
                </span>
                {group.name}
                {shut && <span className="library-count">{group.entries.length}</span>}
              </button>
            </h2>
            {!shut && (
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.type}>
                    <Entry entry={entry} onPick={onPick} onDragStart={onDragStart} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      </div>
    </aside>
  );
}

function Entry({
  entry,
  onPick,
  onDragStart,
}: {
  entry: CatalogueEntry;
  onPick: (type: string) => void;
  onDragStart: ((type: string, e: ReactPointerEvent) => void) | null;
}) {
  const icon = libraryIcon(entry.type);
  return (
    <button
      className="library-entry"
      title={`${entry.description} — select a key, then click; or drag it onto a key to make a new button there`}
      data-action-type={entry.type}
      onPointerDown={(e) => onDragStart?.(entry.type, e)}
      onClick={() => onPick(entry.type)}
    >
      {/* The same built-in the deck draws for a key with no icon of its own. */}
      {icon === null ? (
        <span className="library-icon" aria-hidden="true" />
      ) : (
        <img className="library-icon" src={iconUrl(builtinRef(icon))} alt="" draggable={false} data-icon={icon} />
      )}
      <span className="library-text">
        <span className="library-name">{entry.name}</span>
        <span className="library-description">{entry.description}</span>
      </span>
    </button>
  );
}
