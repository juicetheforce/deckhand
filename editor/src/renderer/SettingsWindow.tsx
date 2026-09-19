import { useEffect, useState } from 'react';
import { RESTORED_FOLDER, type ExportResult, type ImportChoice, type ImportIcon, type ImportResult, type ImportReview, type KeptConfig, type KeptConfigList } from '../shared/backup.js';
import { ACCENTS, type AccentName, type AppSettings, type DeckOption } from '../shared/settings.js';

/**
 * The settings window (Ship piece 3, scope §7), after mockup 6a: DEVICES,
 * BEHAVIOR and APPEARANCE, one card per setting, and a footer. BACKUP (M5)
 * is not in 6a: export and import of the whole configuration. Everything
 * else applies at once; an import alone waits for its review to be confirmed. Every change is
 * saved at once and reaches the editor behind it at once — there is nothing to
 * apply — so Done only closes the window.
 *
 * It runs in its own window, a child of the editor's, frameless, under its
 * own title bar with a close button only (main.tsx, TitleBar.tsx; piece 4).
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
          <span className="settings-sub">Closing the editor leaves Deckhand in the system tray</span>
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

      <span className="settings-heading">BACKUP</span>
      <ExportRow />
      <ImportAndKept />

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

/**
 * Export (M5 piece 1, scope §5). With icons is the default, and is not
 * remembered: a config-only restore onto a fresh install is a deck of blank
 * buttons, so each export starts from the safe choice.
 */
function ExportRow() {
  const [includeIcons, setIncludeIcons] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await window.deckhand.exportConfig(includeIcons));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-row">
        <div className="settings-text">
          <span className="settings-title">Export configuration</span>
          <span className="settings-sub">Export entire configuration to a zip file</span>
        </div>
        <div className="settings-export">
          <label className="settings-inline-check">
            <input type="checkbox" className="settings-check" checked={includeIcons} onChange={(e) => setIncludeIcons(e.target.checked)} />
            Include icons
          </label>
          <button className="settings-button" disabled={busy} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </div>
      <ExportStatus result={result} />
    </>
  );
}

function ExportStatus({ result }: { result: ExportResult | null }) {
  if (!result || (!result.ok && result.cancelled)) return null;
  if (!result.ok) {
    return (
      <p className="settings-status settings-status-error" role="status" data-status="export">
        Export failed: {result.error}
      </p>
    );
  }
  const what = result.includesIcons ? `${result.iconFiles} icon file${result.iconFiles === 1 ? '' : 's'}, ${megabytes(result.bytes)}` : `config only, ${megabytes(result.bytes)}`;
  const shown = result.missing.slice(0, 3).map((m) => `${m.path} (${m.reason})`);
  const more = result.missing.length - shown.length;
  return (
    <p className="settings-status" role="status" data-status="export">
      Exported to {result.path} — {what}.
      {result.missing.length > 0 && (
        <span className="settings-status-warn">
          {' '}
          {result.missing.length === 1 ? 'One icon' : `${result.missing.length} icons`} could not be read and {result.missing.length === 1 ? 'is' : 'are'} not in it: {shown.join(', ')}
          {more > 0 ? `, and ${more} more` : ''}.
        </span>
      )}
      {result.unsavedLeftOut && <span className="settings-status-warn"> Edits the editor could not save are not in it.</span>}
    </p>
  );
}

/**
 * Import (M5 piece 2, scope §5). Choosing a file writes nothing: main plans
 * the import and this shows the review — every relocated icon and where it
 * will go included — until Replace configuration or Cancel.
 */
function ImportAndKept() {
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  // The kept configurations (M5 piece 2d), reread whenever one is made or removed.
  const [kept, setKept] = useState<KeptConfigList | null>(null);
  const refreshKept = () => void window.deckhand.keptConfigs().then(setKept);
  useEffect(refreshKept, []);

  /**
   * Choosing a file and restoring a kept one are the same thing: main plans
   * the import and this shows the review, which writes nothing until it is
   * confirmed. So restoring keeps the configuration it replaces too, and says
   * what it is replacing first (the maintainer, 2026-09-19).
   */
  const choose = async (call: () => Promise<ImportChoice> = () => window.deckhand.chooseImport()) => {
    setBusy(true);
    setMessage(null);
    setReview(null);
    try {
      const choice = await call();
      if (choice.ok) setReview(choice.review);
      else if (!choice.cancelled) setMessage({ error: true, text: choice.error });
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (review) void window.deckhand.cancelImport(review.id);
    setReview(null);
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const result: ImportResult = await window.deckhand.confirmImport(review.id);
      setReview(null);
      setMessage(result.ok ? { error: false, text: importedText(result) } : { error: true, text: `Import failed: ${result.error}` });
      refreshKept(); // the import kept the configuration it replaced
    } finally {
      setBusy(false);
    }
  };
  const remove = async (file: string) => {
    const result = await window.deckhand.deleteKeptConfig(file);
    if (!result.ok) setMessage({ error: true, text: `That kept configuration could not be deleted: ${result.error ?? 'unknown error'}` });
    refreshKept();
  };

  return (
    <>
      <div className="settings-row">
        <div className="settings-text">
          <span className="settings-title">Import configuration</span>
          <span className="settings-sub">Replace the configuration from an export or a backup file</span>
        </div>
        <button className="settings-button" disabled={busy || review !== null} onClick={() => void choose()}>
          Import…
        </button>
      </div>
      {message && (
        <p className={message.error ? 'settings-status settings-status-error' : 'settings-status'} role="status" data-status="import">
          {message.text}
        </p>
      )}
      {review && <ImportReviewPanel review={review} busy={busy} onCancel={cancel} onConfirm={() => void confirm()} />}
      <KeptConfigs
        list={kept}
        disabled={busy || review !== null}
        onRestore={(file) => void choose(() => window.deckhand.restoreKeptConfig(file))}
        onDelete={(file) => void remove(file)}
      />
    </>
  );
}

/**
 * The configurations kept before a profile delete or an import (M5 piece 2d).
 * Each entry says what is in it — profiles by name, decks, keys — because
 * choosing between two timestamps means guessing (the maintainer, 2026-09-19). They are
 * never deleted automatically: Delete here is the only thing that removes one,
 * and at the cap a delete or import refuses rather than drop the oldest.
 */
function KeptConfigs({
  list,
  disabled,
  onRestore,
  onDelete,
}: {
  list: KeptConfigList | null;
  disabled: boolean;
  onRestore: (file: string) => void;
  onDelete: (file: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!list) return null;
  return (
    <>
      <div className="settings-row">
        <div className="settings-text">
          <span className="settings-title">Kept configurations</span>
          <span className="settings-sub">
            Kept before a profile delete or an import, in {list.folder}. Never deleted automatically; at most {list.max}, and then a
            delete or import asks you to remove one.
          </span>
        </div>
      </div>
      <ul className="kept-list" data-kept-count={list.entries.length}>
        {list.entries.length === 0 && <li className="kept-empty muted small">Nothing kept yet. Deleting a profile or importing keeps one.</li>}
        {list.entries.map((entry) => (
          <li key={entry.file} data-kept={entry.file}>
            <div className="kept-what">
              <span className="kept-title">
                {entry.reason === 'delete' ? 'Before deleting a profile' : 'Before an import'} · {when(entry.keptAt)}
              </span>
              <span className="kept-sub">{describeKept(entry)}</span>
            </div>
            <div className="kept-actions">
              <button className="settings-button" disabled={disabled} onClick={() => onRestore(entry.file)}>
                Restore…
              </button>
              {confirming === entry.file ? (
                <>
                  <button
                    className="settings-button danger"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(entry.file);
                    }}
                  >
                    Delete for good
                  </button>
                  <button className="settings-button" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="settings-button" disabled={disabled} onClick={() => setConfirming(entry.file)}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A kept copy's time, as this machine shows times. */
function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** What is in a kept copy, for the line under its title. */
function describeKept(entry: KeptConfig): string {
  if (!entry.summary) return `This file could not be read: ${entry.problem ?? 'unknown error'}`;
  const { profiles, decks, keys } = entry.summary;
  const names = profiles.length === 0 ? 'no profiles' : `${plural(profiles.length, 'profile')}: ${profiles.join(', ')}`;
  return `${names} · ${plural(decks, 'deck')} · ${plural(keys, 'key')}`;
}

function importedText(result: Extract<ImportResult, { ok: true }>): string {
  const parts = [`Imported. ${result.written} icon file${result.written === 1 ? '' : 's'} written.`];
  if (result.appeared.length > 0) parts.push(`Not written, because a file appeared there after the review: ${result.appeared.join(', ')}.`);
  parts.push(result.backup ? `Your previous configuration is kept at ${result.backup}.` : 'There was no previous configuration to keep.');
  return parts.join(' ');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ImportReviewPanel({ review, busy, onCancel, onConfirm }: { review: ImportReview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const by = (outcome: ImportIcon['outcome']) => review.icons.filter((i) => i.outcome === outcome);
  const relocated = review.icons.filter((i) => i.relocated);
  const written = by('write').filter((i) => !i.relocated);
  const same = by('same');
  const here = by('here');
  const kept = by('kept');
  const refused = by('refused');
  const missing = [...by('absent'), ...by('missing-at-export')];

  return (
    <section className="import-review" aria-label="Import review" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
      <p className="import-review-title">Import {review.source}?</p>
      {review.kind === 'json' ? (
        <p className="import-review-warn">
          This is a configuration file, not a Deckhand export: a config-only restore. It has no record of where it was made, so its icon paths are used exactly as
          written — no home folder is remapped and no icons are restored.
        </p>
      ) : (
        <p>
          Exported {review.exportedAt ? new Date(review.exportedAt).toLocaleString() : ''} from {review.exportedHome}, {review.includesIcons ? 'with its icons' : 'config only — no icon files'}.
        </p>
      )}
      <p>
        This replaces your whole configuration with {plural(review.profiles.length, 'profile')} ({review.profiles.join(', ')}) for{' '}
        {review.decks.map((d, i) => (
          <span key={d.serial}>
            {i > 0 ? ', ' : ''}
            {d.name ?? d.serial} ({d.connected ? 'connected' : 'not connected'})
          </span>
        ))}
        . Your current config.json is kept in {review.backupFolder}.
      </p>
      {review.unsavedDiscarded && <p className="import-review-warn">Edits not yet saved in the editor will be lost.</p>}

      {relocated.length > 0 && (
        <IconList title={`${plural(relocated.length, 'icon')} from outside your home folder, moved into ${RESTORED_FOLDER}:`} icons={relocated} show={(i) => `${i.from} → ${i.to}`} warn />
      )}
      {kept.length > 0 && <IconList title={`${plural(kept.length, 'icon')} left as they are on this machine — the bundle's copy is not written:`} icons={kept} show={(i) => `${i.to} (${i.reason})`} warn />}
      {refused.length > 0 && <IconList title={`${plural(refused.length, 'file')} not restored:`} icons={refused} show={(i) => `${i.to} (${i.reason})`} warn />}
      {missing.length > 0 && (
        <IconList
          title={`${plural(missing.length, 'icon')} will show as missing — not in ${review.kind === 'json' ? 'this file' : 'the export'} and not on this machine:`}
          icons={missing}
          show={(i) => (i.outcome === 'missing-at-export' ? `${i.to} (already missing when exported)` : i.to)}
          warn
        />
      )}
      {review.builtinsMissing.length > 0 && (
        <p className="import-review-warn">
          Built-in icons this version of Deckhand does not have: {review.builtinsMissing.join(', ')}. Those keys show the missing icon until Deckhand is updated or another is chosen.
        </p>
      )}
      {review.oldHomeElsewhere.length > 0 && (
        <IconList
          title={`Other settings that name ${review.exportedHome} — not changed; check them:`}
          icons={review.oldHomeElsewhere.map((text) => ({ from: text, to: text, relocated: false, outcome: 'here' }))}
          show={(i) => i.to}
          warn
        />
      )}
      {written.length + same.length + here.length > 0 && (
        <details className="import-review-list">
          <summary>
            {[written.length > 0 ? `${plural(written.length, 'icon')} restored to where ${written.length === 1 ? 'it was' : 'they were'}` : '', same.length > 0 ? `${same.length} already here` : '', here.length > 0 ? `${here.length} found on this machine` : '']
              .filter(Boolean)
              .join(' · ')}
          </summary>
          <ul>
            {[...written, ...same, ...here].map((i) => (
              <li key={`${i.outcome}:${i.from}`}>{i.to}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="import-review-actions">
        <button className="settings-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="settings-button settings-button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Importing…' : 'Replace configuration'}
        </button>
      </div>
    </section>
  );
}

function IconList({ title, icons, show, warn }: { title: string; icons: ImportIcon[]; show: (icon: ImportIcon) => string; warn?: boolean }) {
  return (
    <div className="import-review-list">
      <p className={warn ? 'import-review-warn' : undefined}>{title}</p>
      <ul>
        {icons.map((i) => (
          <li key={i.from}>{show(i)}</li>
        ))}
      </ul>
    </div>
  );
}

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
