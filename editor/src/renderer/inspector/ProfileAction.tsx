import type { ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import type { Choice } from '../model.js';

/**
 * "Switch profile": a list of profiles, each saying which decks it changes.
 * §2 records that the maintainer never discovered profiles in StreamController, so the
 * key that switches them has to state plainly that it moves both decks — and
 * warn when one it does not cover is plugged in, which keeps its old layout
 * (scope §3).
 */
export function ProfileAction({
  at,
  action,
  profiles,
  coverage,
  disabled,
  run,
}: {
  at: ButtonLocation;
  action: ButtonDef['action'];
  profiles: Choice[];
  coverage: (profile: string) => { covered: string[]; uncoveredConnected: string[] };
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const to = action?.type === 'profile' && typeof action.to === 'string' ? action.to : null;
  const target = to === null ? null : (profiles.find((p) => p.id === to) ?? profiles.find((p) => p.label === to))?.id ?? null;
  const uncovered = target === null ? [] : coverage(target).uncoveredConnected;

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Switch profile</h3>
      <ul className="target-list">
        {profiles.map((p) => {
          const { covered } = coverage(p.id);
          return (
            <li key={p.id}>
              <button
                className={p.id === target ? 'target target-selected' : 'target'}
                disabled={disabled}
                onClick={() => void run({ kind: 'setAction', at, action: { type: 'profile', to: p.id } })}
              >
                <span className="target-name">
                  {p.label}
                  {p.id === at.profile ? ' — the one you are editing' : ''}
                </span>
                <span className="target-note">
                  {covered.length === 0 ? 'covers no deck' : `changes ${covered.join(' and ')}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {to !== null && target === null && (
        <p className="warning-text">This key points at “{to}”, which is not a profile. Pressing it does nothing.</p>
      )}
      {uncovered.length > 0 && (
        <p className="warning-text">
          {uncovered.join(' and ')} {uncovered.length === 1 ? 'is' : 'are'} plugged in but not covered by this profile, so{' '}
          {uncovered.length === 1 ? 'it keeps' : 'they keep'} whatever {uncovered.length === 1 ? 'layout it has' : 'layouts they have'}.
        </p>
      )}
      {target === null && to === null && <p className="muted small">Pick the profile this key should switch to.</p>}
    </section>
  );
}
