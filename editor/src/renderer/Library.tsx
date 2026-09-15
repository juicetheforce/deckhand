import { CATALOGUE } from './catalogue.js';

/**
 * The action library: the whole catalogue, grouped (scope §10). Entries the
 * inspector cannot configure yet are shown dimmed rather than hidden, so the
 * capability is still visible (§2).
 */
export function Library() {
  return (
    <aside className="library glass" aria-label="Actions">
      {CATALOGUE.map((group) => (
        <section key={group.name} className="library-group">
          <h2 className="library-heading">{group.name}</h2>
          <ul>
            {group.entries.map((entry) => (
              <li
                key={entry.type}
                className={`library-entry tone-${group.tone}${entry.editable ? '' : ' library-entry-later'}`}
                title={entry.editable ? entry.description : `${entry.description} — not configurable in the editor yet`}
              >
                <span className="library-name">{entry.name}</span>
                <span className="library-description">{entry.description}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
