import { useEffect, useState } from 'react';
import { ACCENTS, type AccentName, type AppSettings, type DeckOption } from '../shared/settings.js';

/**
 * The settings window (Ship piece 3, scope §7), after mockup 6a: DEVICES,
 * BEHAVIOR and APPEARANCE, one card per setting, and a footer. Every change is
 * saved at once and reaches the editor behind it at once — there is nothing to
 * apply — so Done only closes the window.
 *
 * It runs in its own window, a child of the editor's, with the normal KDE
 * title bar until the frameless one is built (piece 4, which gives this
 * window a close button only).
 */
export function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [decks, setDecks] = useState<DeckOption[]>([]);

  useEffect(() => {
    void window.deckhand.appSettings().then(setSettings);
    const refreshDecks = () => void window.deckhand.settingsDecks().then(setDecks);
    refreshDecks();
    // A deck plugged in while the window is open shows the next time it is looked at.
    window.addEventListener('focus', refreshDecks);
    const stop = window.deckhand.onAppSettings(setSettings);
    return () => {
      window.removeEventListener('focus', refreshDecks);
      stop();
    };
  }, []);

  if (!settings) return null;
  const change = (patch: Partial<AppSettings>) => void window.deckhand.setAppSettings(patch).then(setSettings);

  return (
    <main className="settings">
      <span className="settings-heading">DEVICES</span>
      <div className="settings-row">
        <div className="settings-text">
          <label className="settings-title" htmlFor="settings-default-deck">
            Default deck
          </label>
          <span className="settings-sub">The deck the editor opens on</span>
        </div>
        <select
          id="settings-default-deck"
          className="settings-select"
          value={settings.defaultDeck ?? ''}
          onChange={(e) => change({ defaultDeck: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">Automatic</option>
          {decks.map((d) => (
            <option key={d.serial} value={d.serial}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <span className="settings-heading">BEHAVIOR</span>
      <div className="settings-row">
        <div className="settings-text">
          <label className="settings-title" htmlFor="settings-close-to-tray">
            Close to system tray
          </label>
          {/* Not 6a's "Keeps keys active": the daemon runs the keys whatever the editor does (scope §7). */}
          <span className="settings-sub">Closing the editor leaves Deckhand in the system tray, one click away</span>
        </div>
        <input
          id="settings-close-to-tray"
          type="checkbox"
          className="settings-check"
          checked={settings.closeToTray}
          onChange={(e) => change({ closeToTray: e.target.checked })}
        />
      </div>

      <span className="settings-heading">APPEARANCE</span>
      <div className="settings-row">
        <div className="settings-text">
          <span className="settings-title">Accent color</span>
          <span className="settings-sub">Applies to selections, toggles and active keys</span>
        </div>
        <div className="settings-swatches" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button
              key={a.name}
              role="radio"
              aria-checked={settings.accent === a.name}
              aria-label={a.label}
              title={a.label}
              data-accent-swatch={a.name}
              className={settings.accent === a.name ? 'swatch swatch-selected' : 'swatch'}
              style={{ background: a.hex }}
              onClick={() => change({ accent: a.name as AccentName })}
            />
          ))}
        </div>
      </div>

      <div className="settings-footer">
        <span className="settings-note">Settings apply immediately</span>
        <button onClick={() => void window.deckhand.resetAppSettings().then(setSettings)}>Reset to defaults</button>
        <button className="primary" onClick={() => void window.deckhand.closeSettings()}>
          Done
        </button>
      </div>
    </main>
  );
}

/** the maintainer's settings.svg from the mockups (screen 6a and the icon set), drawn inline. */
export function SettingsGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#8f9cf0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M12 2.8 L13.8 2.8 L14.4 5.3 A7 7 0 0 1 16.6 6.6 L19 5.8 L19.9 7.4 L18.1 9.2 A7 7 0 0 1 18.1 11.8 L19.9 13.6 L19 15.2 L16.6 14.4 A7 7 0 0 1 14.4 15.7 L13.8 18.2 L12 18.2 L10.2 18.2 L9.6 15.7 A7 7 0 0 1 7.4 14.4 L5 15.2 L4.1 13.6 L5.9 11.8 A7 7 0 0 1 5.9 9.2 L4.1 7.4 L5 5.8 L7.4 6.6 A7 7 0 0 1 9.6 5.3 L10.2 2.8 Z"
        transform="translate(0 1.5)"
        fill="rgba(143,156,240,.18)"
      />
      <circle cx="12" cy="12" r="2.7" />
    </svg>
  );
}

/** Put an accent on the page: an attribute on the root element for all but the default blue (styles.css). */
export function applyAccent(accent: AccentName): void {
  if (accent === 'blue') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}
