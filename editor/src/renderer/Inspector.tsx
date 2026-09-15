import type { ButtonDef } from '../../../src/types.js';
import { actionName } from './catalogue.js';
import { describeAction, keyKind } from './model.js';

interface Props {
  index: number | null;
  button: ButtonDef | undefined;
}

/**
 * The selected key. Read-only in step 3; the hotkey inspector (capture, Type
 * manually, the three clear operations, label) is step 4.
 */
export function Inspector({ index, button }: Props) {
  if (index === null) {
    return (
      <aside className="inspector glass">
        <p className="muted">Select a key to see what it does.</p>
      </aside>
    );
  }
  const kind = keyKind(button);
  return (
    <aside className="inspector glass" aria-label="Inspector">
      <h2 className="inspector-title">Key {index + 1}</h2>
      {kind === 'empty' && <p className="muted">Empty.</p>}
      {kind !== 'empty' && (
        <dl className="facts">
          <dt>Action</dt>
          <dd>{button?.action ? actionName(button.action.type) : 'none'}</dd>
          <dt>Does</dt>
          <dd>{describeAction(button)}</dd>
          {button?.label !== undefined && (
            <>
              <dt>Label</dt>
              <dd>{button.label}</dd>
            </>
          )}
          {button?.icon !== undefined && (
            <>
              <dt>Icon</dt>
              <dd className="path">{button.icon}</dd>
            </>
          )}
        </dl>
      )}
      {kind === 'other' && (
        <>
          <p className="muted">This action type is not configurable in the editor yet. As saved:</p>
          <pre className="json">{JSON.stringify({ action: button?.action, onRelease: button?.onRelease }, null, 2)}</pre>
        </>
      )}
    </aside>
  );
}
