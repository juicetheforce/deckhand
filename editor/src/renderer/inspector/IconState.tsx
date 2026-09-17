import type { ButtonDef } from '../../../../src/types.js';
import type { IconChoice } from '../../shared/edits.js';
import { builtinName } from '../../shared/icons.js';

/**
 * A button's icon has three states and they are not interchangeable
 * (scope §10): absent means "use the action's built-in default", null means
 * "deliberately none — label only", and a string is that file. They are shown
 * as one segmented control rather than two buttons, because **the state has to
 * be visible rather than inferred from which control was pressed last** (the maintainer,
 * 2026-09-16). On a key with no action, Default and None draw the same, so the
 * sub-line says which it is.
 *
 * No segment is ever disabled (the maintainer, 2026-09-16): going from a file to
 * "deliberately none" must be one click, not clear-then-tick. Choosing None
 * with a file set discards the path, which is what was asked for.
 */
export function IconState({
  button,
  disabled,
  onChoose,
  onBrowse,
}: {
  button: ButtonDef | undefined;
  disabled: boolean;
  onChoose: (icon: IconChoice) => void;
  onBrowse: () => void;
}) {
  // Absent, null and a string are three different things; `in` distinguishes
  // the first two, which `?.` and `??` cannot.
  const hasKey = button !== undefined && 'icon' in button;
  const path = typeof button?.icon === 'string' ? button.icon : null;
  const state: IconChoice['kind'] = path !== null ? 'file' : hasKey ? 'none' : 'default';

  return (
    <div className="icon-state">
      <div className="segmented" role="group" aria-label="Icon">
        <button
          className={state === 'default' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'default'}
          disabled={disabled}
          onClick={() => onChoose({ kind: 'default' })}
        >
          Default
        </button>
        <button
          className={state === 'none' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'none'}
          disabled={disabled}
          onClick={() => onChoose({ kind: 'none' })}
        >
          None
        </button>
        <button
          className={state === 'file' ? 'segment segment-selected' : 'segment'}
          aria-pressed={state === 'file'}
          disabled={disabled}
          onClick={onBrowse}
        >
          This file
        </button>
      </div>

      {state === 'default' && (
        <p className="muted small">
          {button?.action
            ? "No icon chosen, so the key draws its action's built-in icon."
            : 'No icon chosen. A key with no action draws no icon.'}
        </p>
      )}
      {state === 'none' && <p className="muted small">Label only — no icon.</p>}
      {state === 'file' && (
        <>
          <p className="path">{path !== null && builtinName(path) !== null ? `Built-in: ${builtinName(path)}` : path}</p>
          <button className="link-button" disabled={disabled} onClick={onBrowse}>
            Choose a different icon…
          </button>
        </>
      )}
    </div>
  );
}
