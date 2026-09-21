import type { ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import type { Choice } from '../model.js';

/**
 * "Go to page": a plain list of page names in this deck's layout,
 * not the mockups' thumbnails, plus Back. The target is written as the page's
 * ID, so renaming a page never breaks the link — but a link
 * hand-written as a name is still recognised here, since that is how the
 * daemon resolves it.
 */
export function PageAction({
  at,
  action,
  pages,
  disabled,
  run,
}: {
  at: ButtonLocation;
  action: ButtonDef['action'];
  pages: Choice[];
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
}) {
  const back = action?.type === 'page' && action.back === true;
  const to = action?.type === 'page' && typeof action.to === 'string' ? action.to : null;
  const target = to === null ? null : (pages.find((p) => p.id === to) ?? pages.find((p) => p.label === to))?.id ?? null;
  const missing = to !== null && target === null;

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Go to page</h3>
      <div className="button-row">
        <button
          className={back ? '' : 'primary'}
          disabled={disabled || !back}
          onClick={() => void run({ kind: 'removeAction', at })}
        >
          A page
        </button>
        <button
          className={back ? 'primary' : ''}
          disabled={disabled || back}
          onClick={() => void run({ kind: 'setAction', at, action: { type: 'page', back: true } })}
        >
          Back
        </button>
      </div>

      {back ? (
        <p className="muted small">Returns to whatever page this deck came from. Nothing to choose.</p>
      ) : (
        <>
          {pages.length === 0 && <p className="muted small">This deck has no other pages in this profile yet.</p>}
          <ul className="target-list">
            {pages.map((p) => (
              <li key={p.id}>
                <button
                  className={p.id === target ? 'target target-selected' : 'target'}
                  disabled={disabled}
                  onClick={() => void run({ kind: 'setAction', at, action: { type: 'page', to: p.id } })}
                >
                  {p.label}
                  {p.id === at.page ? ' — this page' : ''}
                </button>
              </li>
            ))}
          </ul>
          {missing && (
            <p className="warning-text">
              This key points at “{to}”, which is not a page on this deck. Pressing it does nothing.
            </p>
          )}
          {target === null && !missing && <p className="muted small">Pick the page this key should show.</p>}
        </>
      )}
    </section>
  );
}
