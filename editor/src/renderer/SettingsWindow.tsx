import { useEffect, useState } from 'react';
import logoUrl from '../../../assets/logo/deckhand.svg';
import micIconUrl from '../../../assets/icons/mic.svg';
import { BUILTIN_ICON_SIZE, DEFAULTS, shownIconSize, storedIconSize } from '../../../src/config-common.js';
import type { DiscordStatus, ObsStatus, TwitchStatus, VtsStatus } from '../../../src/control/protocol.js';
import { RESTORED_FOLDER, type ExportResult, type ImportChoice, type ImportIcon, type ImportResult, type ImportReview, type KeptConfig, type KeptConfigList } from '../shared/backup.js';
import type { SettingsSection } from '../shared/bridge.js';
import { ACCENTS, type AccentName, type AppSettings, type DeckOption } from '../shared/settings.js';
import { NO_UPDATE_STATE, type UpdateState } from '../shared/updates.js';
import { discordView, importedLine, obsView, twitchView, vtsView, type Dot } from './integration-status.js';
import { VirtualDecks } from './VirtualDecksSettings.js';
import { DiscordSettings } from './DiscordSettings.js';
import { ObsSettings } from './ObsSettings.js';
import { Banner, Divider, Group, InfoTip, IntegrationIcon, LinkButton, PageTitle, Row, Slider, StatusDot, Switch } from './settings-ui.js';
import { TwitchSettings } from './TwitchSettings.js';
import { VtsSettings } from './VtsSettings.js';

/**
 * The settings window (the design mockups): a sidebar of pages —
 * General, Decks, the integrations (OBS Studio, VTube Studio, Twitch,
 * Discord, each with a status dot), Backups and About — one page at a time,
 * and a footer. Every change is saved at once and reaches the editor behind
 * it at once, except OBS's connection (its own Save), VTube Studio's port
 * and Discord's Application ID (each saved by Connect) and an import, which
 * waits for its review — so the footer says "Changes save automatically"
 * only on the pages where that is true, and Done only closes the window.
 *
 * It runs in its own window, a child of the editor's, frameless, under its
 * own title bar with a close button only (main.tsx, TitleBar.tsx). Opened at
 * an integration (a not-set-up key's Set up), it shows that page.
 */

type Page = 'general' | 'decks' | SettingsSection | 'backups' | 'about';

const PAGES: ReadonlyArray<{ page: Page; name: string }> = [
  { page: 'general', name: 'General' },
  { page: 'decks', name: 'Decks' },
];
const INTEGRATION_PAGES: ReadonlyArray<{ page: SettingsSection; name: string; icon: string }> = [
  { page: 'obs', name: 'OBS Studio', icon: 'obs-stream' },
  { page: 'vts', name: 'VTube Studio', icon: 'vts-model' },
  { page: 'twitch', name: 'Twitch', icon: 'twitch-chat' },
  { page: 'discord', name: 'Discord', icon: 'discord-deafen' },
];
const LATER_PAGES: ReadonlyArray<{ page: Page; name: string }> = [
  { page: 'backups', name: 'Backups' },
  { page: 'about', name: 'About' },
];
/** Where "Changes save automatically" is true. */
const SAVES_AUTOMATICALLY = new Set<Page>(['general', 'decks']);

const isSection = (value: string | null): value is SettingsSection => value === 'obs' || value === 'vts' || value === 'twitch' || value === 'discord';
const ALL_PAGES = new Set<string>([...PAGES, ...INTEGRATION_PAGES, ...LATER_PAGES].map((p) => p.page));
/** `?page=`: a page to open at — set only by the screenshot script (`--settings --page backups`). */
const requestedPage = (value: string | null): Page | null => (value !== null && ALL_PAGES.has(value) ? (value as Page) : null);

export function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [decks, setDecks] = useState<DeckOption[]>([]);
  /** In config.json, not with the settings above; null while it is not open. */
  const [notifications, setNotificationsState] = useState<boolean | null>(null);
  /** Built-in icons' size, also in config.json; null while it is not open. */
  const [iconSize, setIconSize] = useState<number | null>(null);
  /** Icon size's sample while the slider moves, as stored (percent of the key): live, though nothing is saved until it is let go. */
  const [iconSample, setIconSample] = useState<number | null>(null);
  const params = new URLSearchParams(window.location.search);
  const opening = params.get('section');
  const [page, setPage] = useState<Page>(() => (isSection(opening) ? opening : (requestedPage(params.get('page')) ?? 'general')));
  /** Bumped each time the window is asked to show an integration: opened at it, or asked again while open. */
  const [focus, setFocus] = useState(() => (isSection(opening) ? 1 : 0));
  const dots = useIntegrationDots();
  const update = useUpdateState();
  /** Reset to defaults asks first: the footer turns into the question. */
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    void window.deckhand.appSettings().then(setSettings);
    const refreshDecks = () => {
      void window.deckhand.settingsDecks().then(setDecks);
      // config.json edited by hand while the window is open shows the next time it is looked at.
      void window.deckhand.notifications().then(setNotificationsState);
      void window.deckhand.builtinIconSize().then(setIconSize);
    };
    refreshDecks();
    // A deck plugged in while the window is open shows the next time it is looked at.
    window.addEventListener('focus', refreshDecks);
    const stop = window.deckhand.onAppSettings(setSettings);
    const stopSection = window.deckhand.onSettingsSection((section) => {
      setPage(section);
      setFocus((n) => n + 1);
    });
    return () => {
      window.removeEventListener('focus', refreshDecks);
      stop();
      stopSection();
    };
  }, []);

  if (!settings) return null;
  const change = (patch: Partial<AppSettings>) => void window.deckhand.setAppSettings(patch).then(setSettings);
  const changeNotifications = (on: boolean) => void window.deckhand.setNotifications(on).then(setNotificationsState);
  // Saved on release: the decks and the editor's grid redraw then, not while it moves.
  const changeIconSize = (percent: number | null) =>
    void window.deckhand.setBuiltinIconSize(percent).then((saved) => {
      setIconSize(saved);
      setIconSample(null);
    });
  const sampleSize = iconSample ?? iconSize ?? DEFAULTS.builtinIconSize;
  const navItem = (item: { page: Page; name: string }, extra?: { icon?: string; dot?: Dot; update?: boolean }) => (
    <button
      key={item.page}
      className={`sp-nav-item${page === item.page ? ' sp-nav-item-current' : ''}`}
      aria-current={page === item.page ? 'page' : undefined}
      onClick={() => setPage(item.page)}
      data-settings-nav={item.page}
    >
      {extra?.icon && <IntegrationIcon icon={extra.icon} tint={item.page as SettingsSection} size="nav" />}
      <span className="sp-nav-name">{item.name}</span>
      {extra?.dot && <StatusDot dot={extra.dot} />}
      {extra?.update && <span className="sp-dot sp-dot-update" data-dot="update" title="Update available" />}
    </button>
  );

  return (
    <main className="settings" data-settings-page={page}>
      <div className="sp-body">
        <nav className="sp-nav" aria-label="Settings pages">
          {PAGES.map((item) => navItem(item))}
          <span className="sp-nav-heading">INTEGRATIONS</span>
          {INTEGRATION_PAGES.map((item) => navItem(item, { icon: item.icon, dot: dots[item.page] }))}
          <div className="sp-nav-gap" />
          {LATER_PAGES.map((item) => navItem(item, item.page === 'about' ? { update: update.status === 'available' } : undefined))}
        </nav>
        <div className="sp-pane">
          {page === 'general' && (
            <div className="sp-page" data-settings-section="general">
              <PageTitle>General</PageTitle>
              <Group heading="Window">
                {/* Not the copy sheet's "Keys keep working with the window closed": the
                    daemon runs the keys whatever the editor does, and a subtitle on this
                    switch reads as what the switch does. */}
                <Row title="Close to tray" detail="Closing the editor leaves Deckhand in the system tray" htmlFor="settings-close-to-tray">
                  <Switch id="settings-close-to-tray" checked={settings.closeToTray} onChange={(on) => change({ closeToTray: on })} />
                </Row>
                <Divider />
                <Row
                  title="Notifications"
                  detail={notifications === null ? 'Needs config.json to be open' : 'When a key needs you, like holding Stream to stop'}
                  htmlFor="settings-notifications"
                >
                  <Switch id="settings-notifications" checked={notifications ?? true} disabled={notifications === null} onChange={changeNotifications} />
                </Row>
              </Group>
              <Group heading="Appearance">
                <Row title="Accent color">
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
                </Row>
                <Divider />
                {/* Claude Design's 16a–16c: global, percent of the key, built-in icons only. */}
                <Row title="Icon size" detail={iconSize === null ? 'Needs config.json to be open' : 'Built-in icons on keys'}>
                  {/* Shown relative to the largest size (70% of the key as 100%), stored as a percent of the key. */}
                  <Slider
                    label="Icon size"
                    value={shownIconSize(iconSize ?? DEFAULTS.builtinIconSize)}
                    min={BUILTIN_ICON_SIZE.shown.min}
                    max={BUILTIN_ICON_SIZE.shown.max}
                    step={BUILTIN_ICON_SIZE.shown.step}
                    unit="%"
                    disabled={iconSize === null}
                    onPreview={(shown) => setIconSample(storedIconSize(shown))}
                    onCommit={(shown) => changeIconSize(storedIconSize(shown))}
                  >
                    <span className="sp-icon-sample" data-settings="icon-sample">
                      <img src={micIconUrl} alt="" width={Math.round((56 * sampleSize) / 100)} height={Math.round((56 * sampleSize) / 100)} />
                    </span>
                  </Slider>
                </Row>
              </Group>
            </div>
          )}
          {page === 'decks' && (
            <div className="sp-page" data-settings-section="decks">
              <PageTitle>Decks</PageTitle>
              <Group heading="Editor">
                <Row title="Default deck" detail="Opens when the editor starts" htmlFor="settings-default-deck">
                  <select
                    id="settings-default-deck"
                    className="sp-select"
                    value={decks.some((d) => d.serial === settings.defaultDeck) ? settings.defaultDeck! : ''}
                    onChange={(e) => change({ defaultDeck: e.target.value === '' ? null : e.target.value })}
                  >
                    <option value="">Automatic</option>
                    {decks.map((d) => (
                      <option key={d.serial} value={d.serial}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <VirtualDecks />
            </div>
          )}
          {page === 'obs' && <ObsSettings focus={focus} />}
          {page === 'vts' && <VtsSettings focus={focus} />}
          {page === 'twitch' && <TwitchSettings focus={focus} />}
          {page === 'discord' && <DiscordSettings focus={focus} />}
          {page === 'backups' && <BackupsPage />}
          {page === 'about' && <AboutPage update={update} />}
        </div>
      </div>

      {confirmingReset ? (
        <div className="settings-footer settings-footer-confirm" data-settings-confirm="reset">
          <span className="settings-note settings-note-ask">Reset the default deck, close to tray, notifications, accent color and icon size to their defaults?</span>
          <button
            className="sp-button sp-button-danger-solid"
            onClick={() => {
              setConfirmingReset(false);
              void window.deckhand.resetAppSettings().then(setSettings);
              if (notifications === false) changeNotifications(true);
              if (iconSize !== null && iconSize !== DEFAULTS.builtinIconSize) changeIconSize(null);
            }}
            data-settings="confirm-reset"
          >
            Reset
          </button>
          <button className="sp-button" onClick={() => setConfirmingReset(false)} data-settings="keep-settings">
            Keep
          </button>
        </div>
      ) : (
        <div className="settings-footer">
          <span className="settings-note">{SAVES_AUTOMATICALLY.has(page) ? 'Changes save automatically' : ''}</span>
          <button className="sp-button" onClick={() => setConfirmingReset(true)} data-settings="reset">
            Reset to defaults
          </button>
          <button className="sp-button sp-button-primary" onClick={() => void window.deckhand.closeSettings()} data-settings="done">
            Done
          </button>
        </div>
      )}
    </main>
  );
}

/** The update check's state (main/updates.ts): asked when the window opens, then told each change. */
function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(NO_UPDATE_STATE);
  useEffect(() => {
    void window.deckhand.updateState().then((s) => s && setState(s));
    return window.deckhand.onUpdateState(setState);
  }, []);
  return state;
}

/** Each integration's dot in the sidebar: the daemon's state, as the page's own status line reads it (integration-status.ts). */
function useIntegrationDots(): Partial<Record<SettingsSection, Dot>> {
  const [obs, setObs] = useState<ObsStatus | null>(null);
  const [vts, setVts] = useState<VtsStatus | null>(null);
  const [twitch, setTwitch] = useState<TwitchStatus | null>(null);
  const [discord, setDiscord] = useState<DiscordStatus | null>(null);
  useEffect(() => {
    void window.deckhand.obsStatus().then(setObs);
    void window.deckhand.vtsStatus().then(setVts);
    void window.deckhand.twitchStatus().then(setTwitch);
    void window.deckhand.discordStatus().then(setDiscord);
    const stops = [window.deckhand.onObsStatus(setObs), window.deckhand.onVtsStatus(setVts), window.deckhand.onTwitchStatus(setTwitch), window.deckhand.onDiscordStatus(setDiscord)];
    return () => stops.forEach((stop) => stop());
  }, []);
  // No daemon: no dot, rather than one that claims to know.
  return {
    obs: obs ? obsView(obs).dot : undefined,
    vts: vts ? vtsView(vts).dot : undefined,
    twitch: twitch ? twitchView(twitch).dot : undefined,
    discord: discord ? discordView(discord).dot : undefined,
  };
}

/**
 * The installed version, selectable so it can be copied into an issue, and
 * the releases page; then whether a newer release exists (main/updates.ts),
 * and the switch that allows asking. Nothing is downloaded: the link opens
 * the release's page, whose notes say how to update. If the browser cannot be
 * opened, the message names the URL, to copy.
 */
function AboutPage({ update }: { update: UpdateState }) {
  /** undefined while it is read; null in a checkout, with no VERSION file. */
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    void window.deckhand.appVersion().then(setVersion);
  }, []);
  return (
    <div className="sp-page" data-settings-section="about">
      <PageTitle>About</PageTitle>
      <Group>
        <div className="sp-about" data-about="version">
          <img className="sp-about-icon" src={logoUrl} width={40} height={40} alt="" />
          <div className="sp-about-text">
            <span className="sp-about-name">Deckhand</span>
            <span className="settings-version" data-about-version={version ?? ''}>
              {version === undefined ? '' : version === null ? 'A development build: not installed' : version}
            </span>
          </div>
          <LinkButton
            title="github.com/juicetheforce/deckhand/releases"
            onClick={() => {
              setOpenError(null);
              void window.deckhand.openReleases().then((r) => setOpenError(r.ok ? null : r.error));
            }}
            data-about="releases"
          >
            Releases on GitHub
          </LinkButton>
        </div>
      </Group>
      <Group heading="Updates" data-about="updates">
        <Row title="Check for updates" detail={updateDetail(update)} htmlFor="settings-check-updates">
          <Switch id="settings-check-updates" checked={update.enabled} onChange={(on) => void window.deckhand.setUpdateCheck(on)} />
        </Row>
        {update.status === 'available' && update.latest && (
          <>
            <Divider />
            <Row title="Update available" detail={`Deckhand ${update.latest} — its page says how to update`}>
              <LinkButton
                title={update.url ?? undefined}
                onClick={() => {
                  setOpenError(null);
                  void window.deckhand.openUpdate().then((r) => setOpenError(r.ok ? null : r.error));
                }}
                data-about="update"
              >
                View release
              </LinkButton>
            </Row>
          </>
        )}
      </Group>
      {openError && <Banner kind="error">{openError}</Banner>}
    </div>
  );
}

/** Under "Check for updates": what it does, or what the last check found when that is worth saying. */
function updateDetail(update: UpdateState): string {
  if (update.status === 'off') return 'Off: Deckhand never asks GitHub for a newer version';
  if (update.status === 'failed') return 'Could not reach GitHub; it asks again the next time the editor opens';
  if (update.status === 'current') return 'Each time the editor opens. This is the newest release';
  return 'Each time the editor opens, asks GitHub for the newest release. Nothing is downloaded';
}

/**
 * Backups: export, import, and the kept configurations. Export with icons is
 * the default, and is not remembered: a config-only restore onto a fresh
 * install is a deck of blank buttons, so each export starts from the safe
 * choice. Choosing a file to import writes nothing: main plans the import
 * and this shows the review — every relocated icon and where it will go
 * included — until Replace configuration or Cancel.
 */
function BackupsPage() {
  const [includeIcons, setIncludeIcons] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; keptFile?: string } | null>(null);
  // The kept configurations, reread whenever one is made or removed.
  const [kept, setKept] = useState<KeptConfigList | null>(null);
  const refreshKept = () => void window.deckhand.keptConfigs().then(setKept);
  useEffect(refreshKept, []);

  const runExport = async () => {
    setExporting(true);
    setExported(null);
    try {
      setExported(await window.deckhand.exportConfig(includeIcons));
    } finally {
      setExporting(false);
    }
  };

  /**
   * Choosing a file and restoring a kept one are the same thing: main plans
   * the import and this shows the review, which writes nothing until it is
   * confirmed. So restoring keeps the configuration it replaces too, and says
   * what it is replacing first.
   */
  const choose = async (call: () => Promise<ImportChoice> = () => window.deckhand.chooseImport()) => {
    setBusy(true);
    setMessage(null);
    setReview(null);
    try {
      const choice = await call();
      if (choice.ok) setReview(choice.review);
      else if (!choice.cancelled) setMessage({ kind: 'error', text: choice.error });
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
      setMessage(result.ok ? { kind: 'ok', text: importedText(result), keptFile: result.backup ?? undefined } : { kind: 'error', text: `Import failed: ${result.error}` });
      refreshKept(); // the import kept the configuration it replaced
    } finally {
      setBusy(false);
    }
  };
  const remove = async (file: string) => {
    const result = await window.deckhand.deleteKeptConfig(file);
    if (!result.ok) setMessage({ kind: 'error', text: `That kept configuration could not be deleted: ${result.error ?? 'unknown error'}` });
    refreshKept();
  };
  const disabled = busy || review !== null;

  return (
    <div className="sp-page" data-settings-section="backups">
      <PageTitle>Backups</PageTitle>
      <Group heading="Configuration">
        <Row title="Export" detail="All profiles and settings as a .zip">
          <div className="settings-export">
            <label className="sp-check">
              <input type="checkbox" checked={includeIcons} onChange={(e) => setIncludeIcons(e.target.checked)} />
              Include icons
            </label>
            <button className="sp-button" disabled={exporting} onClick={() => void runExport()} data-backup="export">
              {exporting ? 'Exporting…' : 'Export…'}
            </button>
          </div>
        </Row>
        <Divider />
        <Row title="Import" detail="Replaces the current setup. A backup is kept first.">
          <button className="sp-button" disabled={disabled} onClick={() => void choose()} data-backup="import">
            Import…
          </button>
        </Row>
      </Group>
      <ExportStatus result={exported} />
      {message && (
        <Banner
          kind={message.kind}
          data-status="import"
          action={
            message.keptFile ? (
              <LinkButton onClick={() => void window.deckhand.showKeptFile(message.keptFile!)} data-backup="show-file">
                Show file
              </LinkButton>
            ) : undefined
          }
        >
          {message.text}
        </Banner>
      )}
      {review && <ImportReviewPanel review={review} busy={busy} onCancel={cancel} onConfirm={() => void confirm()} />}
      {kept && (
        <KeptConfigs list={kept} disabled={disabled} onRestore={(file) => void choose(() => window.deckhand.restoreKeptConfig(file))} onDelete={(file) => void remove(file)} />
      )}
    </div>
  );
}

function ExportStatus({ result }: { result: ExportResult | null }) {
  if (!result || (!result.ok && result.cancelled)) return null;
  if (!result.ok) {
    return (
      <Banner kind="error" data-status="export">
        Export failed: {result.error}
      </Banner>
    );
  }
  const what = result.includesIcons ? `${result.iconFiles} icon file${result.iconFiles === 1 ? '' : 's'}, ${megabytes(result.bytes)}` : `config only, ${megabytes(result.bytes)}`;
  const shown = result.missing.slice(0, 3).map((m) => `${m.path} (${m.reason})`);
  const more = result.missing.length - shown.length;
  const warn = result.missing.length > 0 || result.unsavedLeftOut;
  return (
    <Banner kind={warn ? 'warn' : 'ok'} data-status="export">
      Exported to {result.path} — {what}.
      {result.missing.length > 0 && (
        <>
          {' '}
          {result.missing.length === 1 ? 'One icon' : `${result.missing.length} icons`} could not be read and {result.missing.length === 1 ? 'is' : 'are'} not in it: {shown.join(', ')}
          {more > 0 ? `, and ${more} more` : ''}.
        </>
      )}
      {result.unsavedLeftOut && <> Edits the editor could not save are not in it.</>}
    </Banner>
  );
}

/**
 * The configurations kept before a profile delete or an import. They are
 * never deleted automatically: Delete here is the only thing that removes
 * one, and at the cap a delete or import refuses rather than drop the oldest.
 */
function KeptConfigs({
  list,
  disabled,
  onRestore,
  onDelete,
}: {
  list: KeptConfigList;
  disabled: boolean;
  onRestore: (file: string) => void;
  onDelete: (file: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <>
      <Group
        heading="Kept backups"
        data-kept-count={String(list.entries.length)}
        extra={
          <>
            <InfoTip text={`Kept before deleting a profile or importing. Up to ${list.max}; after that you’ll be asked to remove one. Never deleted automatically.`} />
            <LinkButton
              title={list.folder}
              onClick={() => {
                setOpenError(null);
                void window.deckhand.openKeptFolder().then((r) => setOpenError(r.ok ? null : r.error));
              }}
              data-backup="open-folder"
            >
              Open folder
            </LinkButton>
          </>
        }
      >
        {list.entries.length === 0 ? (
          <div className="sp-empty kept-empty">
            <span className="sp-empty-title">None yet</span>
            <span className="sp-row-detail">One is kept each time you delete a profile or import.</span>
          </div>
        ) : (
          <ul className="kept-list">
            {list.entries.map((entry, i) => (
              <li key={entry.file} data-kept={entry.file}>
                {i > 0 && <Divider />}
                <div className="sp-kept">
                  <div className="kept-what">
                    <span className="kept-title">
                      {entry.reason === 'delete' ? 'Before deleting a profile' : 'Before import'} <span className="kept-when">· {when(entry.keptAt)}</span>
                    </span>
                    <span className="kept-sub">{describeKept(entry)}</span>
                  </div>
                  <div className="kept-actions">
                    <button className="sp-button" disabled={disabled} onClick={() => onRestore(entry.file)}>
                      Restore…
                    </button>
                    {confirming === entry.file ? (
                      <>
                        <button
                          className="sp-button sp-button-danger-solid"
                          onClick={() => {
                            setConfirming(null);
                            onDelete(entry.file);
                          }}
                        >
                          Delete for good
                        </button>
                        <button className="sp-button" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button className="sp-button sp-button-quiet" disabled={disabled} onClick={() => setConfirming(entry.file)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Group>
      {openError && <Banner kind="error">{openError}</Banner>}
    </>
  );
}

/** A kept copy's time, as this machine shows dates and times. */
function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * What is in a kept copy, for the line under its title — the profiles by
 * name, not only how many (choosing between two timestamps is guessing),
 * then decks and keys as the copy sheet counts them.
 */
function describeKept(entry: KeptConfig): string {
  if (!entry.summary) return `This file could not be read: ${entry.problem ?? 'unknown error'}`;
  const { profiles, decks, keys } = entry.summary;
  const names = profiles.length === 0 ? 'no profiles' : `${plural(profiles.length, 'profile')}: ${profiles.join(', ')}`;
  return `${names} · ${plural(decks, 'deck')} · ${plural(keys, 'key')}`;
}

function importedText(result: Extract<ImportResult, { ok: true }>): string {
  const parts = [importedLine(result.written, result.backup !== null)];
  if (result.appeared.length > 0) parts.push(`Not written, because a file appeared there after the review: ${result.appeared.join(', ')}.`);
  if (result.backup === null) parts.push('There was no previous configuration to keep.');
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
        <button className="sp-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="sp-button sp-button-danger-solid" disabled={busy} onClick={onConfirm}>
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

/** The settings gear, drawn inline. */
export function SettingsGlyph({ size }: { size: number }) {
  return (
    <svg className="settings-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M12 2.8 L13.8 2.8 L14.4 5.3 A7 7 0 0 1 16.6 6.6 L19 5.8 L19.9 7.4 L18.1 9.2 A7 7 0 0 1 18.1 11.8 L19.9 13.6 L19 15.2 L16.6 14.4 A7 7 0 0 1 14.4 15.7 L13.8 18.2 L12 18.2 L10.2 18.2 L9.6 15.7 A7 7 0 0 1 7.4 14.4 L5 15.2 L4.1 13.6 L5.9 11.8 A7 7 0 0 1 5.9 9.2 L4.1 7.4 L5 5.8 L7.4 6.6 A7 7 0 0 1 9.6 5.3 L10.2 2.8 Z"
        transform="translate(0 1.5)"
        fill="currentColor"
        fillOpacity={0.18}
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
