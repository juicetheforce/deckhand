import { useEffect, useRef, useState } from 'react';
import type { ActionDef, ButtonDef } from '../../../../src/types.js';
import type { Edit } from '../../shared/edits.js';
import { builtinRef, iconUrl } from '../../shared/icons.js';
import { actionName, libraryIcon } from '../catalogue.js';
import { actionIncomplete } from '../model.js';
import { STEP_TYPES, multiTotal, stepEditable, stepSummary, withoutDelay } from '../steps.js';
// ActionForm renders this form for a Multi key and this form renders
// ActionForm for each step: a cycle between the two, used only at render time.
import { ActionForm, type ActionFormProps } from './ActionForm.js';
import { NumberSetting, actionOf, nextAction } from './controls.js';

const TEST_COUNTDOWN_S = 3;

/**
 * Multi action: a step list — drag-handled rows, a delay after
 * each step, the running total in both figures, and Test Run, which arms
 * rather than fires. A step is edited with the same form a key of that action
 * uses; its edits come back here and are written into `steps`.
 */
export function MultiForm(p: ActionFormProps) {
  const { at, button, disabled, run, pages, profiles, serial, canTestRun } = p;
  const action = actionOf('multi', button);
  const steps: ActionDef[] = Array.isArray(action?.steps) ? (action.steps as ActionDef[]) : [];
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // The latest steps and key, for edits that arrive after a later render (a
  // form's debounced text save), so one step's save never overwrites another's.
  const latest = useRef<{ steps: ActionDef[]; button: ButtonDef | undefined }>({ steps, button });
  latest.current = { steps, button };
  const writeSteps = (next: ActionDef[]) => run({ kind: 'setAction', at, action: nextAction('multi', latest.current.button, { steps: next }) });

  /** A step's own form writes through here: its action replaces the step, keeping the step's delay. */
  const stepRun = (i: number) => async (edit: Edit) => {
    const now = latest.current.steps;
    const current = now[i];
    if (!current) return false;
    let next: ActionDef;
    if (edit.kind === 'setAction') next = edit.action;
    else if (edit.kind === 'removeAction') next = { type: current.type }; // "Clear hotkey" and the like: an empty step
    else return false; // no step form sends anything else
    // Forms build on the step they were given, delay included (nextAction), so
    // this rarely adds anything; it holds for a form that does not. Either alone
    // keeps the delay.
    if (typeof current.delayMs === 'number' && next.delayMs === undefined) next = { ...next, delayMs: current.delayMs };
    return writeSteps(now.map((s, j) => (j === i ? next : s)));
  };

  const setDelay = (i: number, ms: number) => {
    const now = latest.current.steps;
    void writeSteps(now.map((s, j) => (j === i ? (ms === 0 ? withoutDelay(s) : { ...s, delayMs: ms }) : s)));
  };
  const remove = (i: number) => {
    setOpen(null);
    void writeSteps(latest.current.steps.filter((_, j) => j !== i));
  };
  const add = (type: string) => {
    setAdding(false);
    setOpen(steps.length);
    void writeSteps([...latest.current.steps, { type }]);
  };

  // Drag a row by its handle onto another row: the step moves there.
  const drag = useRef<{ from: number; pointerId: number } | null>(null);
  const [dragState, setDragState] = useState<{ from: number; over: number | null } | null>(null);
  useEffect(() => {
    const rowUnder = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-step-index]');
      return el ? Number(el.dataset.stepIndex) : null;
    };
    const move = (e: PointerEvent) => {
      if (!drag.current || e.pointerId !== drag.current.pointerId) return;
      setDragState({ from: drag.current.from, over: rowUnder(e.clientX, e.clientY) });
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      setDragState(null);
      const over = rowUnder(e.clientX, e.clientY);
      if (over === null || over === d.from) return;
      const next = [...latest.current.steps];
      const [moved] = next.splice(d.from, 1);
      next.splice(over, 0, moved);
      setOpen(null);
      void writeSteps(next);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.stopPropagation();
      e.preventDefault();
      drag.current = null;
      setDragState(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', cancel, true);
    };
  }, []);

  // Test Run: count down while the user clicks into the target window, then
  // ask main to run it — refused if the editor still has focus.
  const [countdown, setCountdown] = useState<number | null>(null);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopCountdown = () => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(null);
  };
  useEffect(() => stopCountdown, []);
  const arm = () => {
    setTestMessage(null);
    let left = TEST_COUNTDOWN_S;
    setCountdown(left);
    countdownTimer.current = setInterval(() => {
      left -= 1;
      if (left > 0) {
        setCountdown(left);
        return;
      }
      stopCountdown();
      const tested = latest.current.button?.action;
      if (!tested) return;
      void window.deckhand.testRun(serial, tested).then((result) => {
        if (result.ok) setTestMessage({ ok: true, text: 'Sent.' });
        else if (result.code === 'focused') setTestMessage({ ok: false, text: 'The editor still had focus, so nothing was sent. Click into the window it should reach during the countdown.' });
        else setTestMessage({ ok: false, text: `Not sent: ${result.error}` });
      });
    }, 1000);
  };

  return (
    <section className="inspector-section">
      <h3 className="section-heading">Multi action</h3>
      <p className="muted small">The steps run in order; each step's delay is a pause after it.</p>
      <ol className="step-list">
        {steps.map((step, i) => {
          const icon = libraryIcon(step.type);
          const editable = stepEditable(step);
          const classes = ['step', open === i ? 'step-open' : '', dragState?.from === i ? 'step-dragging' : '', dragState && dragState.over === i && dragState.from !== i ? 'step-drop-target' : ''];
          return (
            <li key={i} className={classes.filter(Boolean).join(' ')} data-step-index={i}>
              <div className="step-row">
                <span
                  className="step-handle"
                  title="Drag to reorder"
                  aria-label={`Drag step ${i + 1}`}
                  onPointerDown={(e) => {
                    if (disabled || e.button !== 0) return;
                    e.preventDefault();
                    drag.current = { from: i, pointerId: e.pointerId };
                    setDragState({ from: i, over: i });
                  }}
                >
                  ⋮⋮
                </span>
                <button className="step-main" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  {icon ? <img className="step-icon" src={iconUrl(builtinRef(icon))} alt="" draggable={false} /> : <span className="step-icon" />}
                  <span className="step-name">{actionName(step.type)}</span>
                  <span className={actionIncomplete(step) ? 'step-summary warning-text' : 'step-summary'}>{stepSummary(step, pages, profiles)}</span>
                </button>
                <span className="step-delay">
                  <NumberSetting label={`Delay after step ${i + 1}`} value={typeof step.delayMs === 'number' ? step.delayMs : 0} min={0} max={60000} disabled={disabled} onSave={(ms) => setDelay(i, ms)} />
                  <span className="form-value">ms</span>
                </span>
                <button className="step-remove" disabled={disabled} aria-label={`Remove step ${i + 1}`} onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
              {open === i && (
                <div className="step-form">
                  {editable ? (
                    <ActionForm
                      {...p}
                      type={step.type}
                      button={{ action: step }}
                      run={stepRun(i)}
                      listenRequest={false}
                      onListening={() => {}}
                      onChooseIcon={undefined}
                    />
                  ) : (
                    <>
                      <p className="muted small">Not editable here; it can still be moved, delayed or removed. As saved:</p>
                      <pre className="json">{JSON.stringify(withoutDelay(step), null, 2)}</pre>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {steps.length === 0 && <p className="muted small">No steps yet.</p>}

      <div className="button-row">
        <button disabled={disabled} onClick={() => setAdding(!adding)} aria-expanded={adding}>
          Add a step
        </button>
      </div>
      {adding && (
        <ul className="target-list step-types">
          {STEP_TYPES.map((type) => {
            const icon = libraryIcon(type);
            return (
              <li key={type}>
                <button className="target step-type" data-step-type={type} disabled={disabled} onClick={() => add(type)}>
                  {icon && <img className="step-icon" src={iconUrl(builtinRef(icon))} alt="" draggable={false} />}
                  {actionName(type)}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {steps.length > 0 && <p className="muted small step-total">{multiTotal(steps)}</p>}

      <div className="button-row">
        <button className="primary" disabled={disabled || steps.length === 0 || countdown !== null || !canTestRun} title={canTestRun ? 'Runs it on this deck after a short countdown' : 'The deck is not connected'} onClick={arm}>
          Test run
        </button>
        {countdown !== null && <button onClick={stopCountdown}>Cancel</button>}
      </div>
      {countdown !== null && (
        <p className="listening test-countdown" role="status">
          Click into the window it should reach… {countdown}
        </p>
      )}
      {testMessage && <p className={testMessage.ok ? 'muted small test-result' : 'warning-text test-result'}>{testMessage.text}</p>}
    </section>
  );
}
