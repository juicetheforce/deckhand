import { CATALOGUE } from './catalogue.js';

/**
 * The action library: the whole catalogue, grouped (scope §10). Entries the
 * inspector cannot configure yet are shown dimmed rather than hidden, so the
 * capability is still visible (§2). An editable entry, clicked with a key
 * selected, starts configuring it (phase A: Hotkey starts listening).
 */
export function Library({ onPick }: { onPick: (type: string) => void }) {
  return (
    <aside className="library glass" aria-label="Actions">
      {CATALOGUE.map((group) => (
        <section key={group.name} className="library-group">
          <h2 className="library-heading">{group.name}</h2>
          <ul>
            {group.entries.map((entry) => (
              <li key={entry.type}>
                <button
                  className={`library-entry tone-${group.tone}${entry.editable ? '' : ' library-entry-later'}`}
                  title={entry.editable ? `${entry.description} — select a key, then click` : `${entry.description} — not configurable in the editor yet`}
                  disabled={!entry.editable}
                  onClick={() => onPick(entry.type)}
                >
                  <span className="library-name">{entry.name}</span>
                  <span className="library-description">{entry.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
