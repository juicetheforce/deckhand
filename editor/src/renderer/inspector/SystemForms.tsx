import { useEffect, useState } from 'react';
import type { AppListing } from '../../../../src/control/protocol.js';
import { iconUrl } from '../../shared/icons.js';
import { Checkbox, NumberSetting, Row, Segmented, actionOf, nextAction, type FormProps } from './controls.js';

/**
 * The small System forms: Clock, Nothing and Brightness. Grouped
 * by the library section they sit in, since each is a few controls.
 */

/** clock: the time is the key's face, so the grid does not draw it. */
export function ClockForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('clock', button);
  const format = action?.format === 'HH:mm:ss' ? 'HH:mm:ss' : 'HH:mm';
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Clock</h3>
      <Row name="Shows">
        <Segmented
          label="Clock format"
          options={[
            { value: 'HH:mm', label: '14:05' },
            { value: 'HH:mm:ss', label: '14:05:09' },
          ]}
          value={format}
          disabled={disabled}
          // HH:mm is the daemon's default, so choosing it removes the setting.
          onChoose={(v) => void run({ kind: 'setAction', at, action: nextAction('clock', button, { format: v === 'HH:mm' ? undefined : v }) })}
        />
      </Row>
      <p className="muted small">The time is drawn on the deck; the grid here does not show it.</p>
    </section>
  );
}

/** noop: a deliberate spacer — no default icon either. */
export function NoopForm() {
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Nothing</h3>
      <p className="muted small">Does nothing when pressed, and draws no default icon: a spacer. It can still have a label or an icon of its own.</p>
    </section>
  );
}

/** editor: opens this editor from the deck. Nothing to set. */
export function EditorForm() {
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Open editor</h3>
      <p className="muted small">Opens this editor. If it is already open, even in the tray, it comes to the front. Every deck starts with one of these on its first key.</p>
    </section>
  );
}

type BrightnessMode = 'up' | 'down' | 'set';

/** brightness: nudge by a step, or set a level, on the deck the key is on. */
export function BrightnessForm({ at, button, disabled, run }: FormProps) {
  const action = actionOf('brightness', button);
  const value = typeof action?.value === 'number' ? action.value : null;
  const delta = typeof action?.delta === 'number' ? action.delta : null;
  const mode: BrightnessMode | null = value !== null ? 'set' : delta !== null ? (delta < 0 ? 'down' : 'up') : null;
  const step = Math.abs(delta ?? 10);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('brightness', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Brightness</h3>
      <Segmented<BrightnessMode>
        label="Brightness"
        options={[
          { value: 'up', label: 'Brighter' },
          { value: 'down', label: 'Dimmer' },
          { value: 'set', label: 'Set to' },
        ]}
        value={mode}
        disabled={disabled}
        onChoose={(m) => write(m === 'set' ? { value: value ?? 50, delta: undefined } : { delta: m === 'up' ? step : -step, value: undefined })}
      />
      {mode === null && <p className="muted small">Choose whether the key nudges this deck's brightness or sets it.</p>}
      {(mode === 'up' || mode === 'down') && (
        <Row name="By">
          <NumberSetting label="Brightness step" value={step} min={1} max={100} disabled={disabled} onSave={(n) => write({ delta: mode === 'up' ? n : -n })} />
          <span className="form-value">%</span>
        </Row>
      )}
      {mode === 'set' && (
        <Row name="Level">
          <NumberSetting label="Brightness level" value={value ?? 50} min={5} max={100} disabled={disabled} onSave={(n) => write({ value: n })} />
          <span className="form-value">%</span>
        </Row>
      )}
      {mode !== null && (
        <Checkbox label="Show the level on the key" checked={action?.showLevel === true} disabled={disabled} onChange={(on) => write({ showLevel: on ? true : undefined })} />
      )}
    </section>
  );
}

/**
 * app: open an installed application, picked from the daemon's list (its
 * `apps`: the desktop's own entries, each with the icon its theme gives it).
 * The key stores the desktop file ID and nothing else; with no icon of its
 * own it draws the app's, on the deck and here.
 *
 * Opening the form asks the daemon for the list again, so an app installed
 * since the editor started is there to pick.
 */
export function AppForm({ at, button, disabled, run, apps }: FormProps & { apps: AppListing[] | null | undefined }) {
  const action = actionOf('app', button);
  const stored = typeof action?.app === 'string' && action.app !== '' ? action.app : null;
  const [query, setQuery] = useState('');
  useEffect(() => {
    void window.deckhand.refreshApps();
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = (apps ?? []).filter((a) => needle === '' || a.name.toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle));
  const storedMissing = stored !== null && apps != null && !apps.some((a) => a.id === stored);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Open app</h3>
      <p className="muted small">Opens the app. The key shows the app’s own icon unless you give it another.</p>
      {apps == null ? (
        <p className="warning-text">The daemon has not listed the installed applications yet, so there is nothing to pick from. Is it running?</p>
      ) : (
        <>
          <input className="app-search" type="search" aria-label="Search applications" placeholder="Search applications…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="target-list app-list">
            {shown.map((a) => (
              <li key={a.id}>
                <button className={stored === a.id ? 'target app-target target-selected' : 'target app-target'} disabled={disabled} data-app={a.id} onClick={() => void run({ kind: 'setAction', at, action: nextAction('app', button, { app: a.id }) })}>
                  {a.icon ? <img className="app-icon" src={iconUrl(a.icon)} alt="" draggable={false} /> : <span className="app-icon" />}
                  <span className="app-text">
                    <span className="target-name">{a.name}</span>
                    <span className="target-note">{a.id}</span>
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="muted small">No application matches “{query}”.</li>}
          </ul>
        </>
      )}
      {storedMissing && <p className="warning-text">“{stored}” is not installed now. The key fails when pressed until it is, or pick another.</p>}
      {stored === null && apps != null && <p className="muted small">Pick the application this key opens.</p>}
      <p className="muted small">To go to a page or profile once the app is open, put both in a Multi action, with a pause after the app long enough for its window to appear.</p>
    </section>
  );
}
