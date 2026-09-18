import type { Config } from '../../../src/types.js';
import type { DecksResult } from '../../../src/control/protocol.js';

/**
 * The editor's app settings (Ship piece 3, scope §7): what the settings window
 * shows and changes. Kept in the editor's preferences file, never config.json
 * — they are about this editor, not about the decks. Pure, so main, both
 * renderers and the tests share one reading of what is stored.
 */
export interface AppSettings {
  /** The deck the editor opens on, by serial; null is Automatic. */
  defaultDeck: string | null;
  /** Closing the editor leaves it in the tray (Ship piece 2); off, closing quits. */
  closeToTray: boolean;
  accent: AccentName;
}

/**
 * The accent colours: a closed set, each checked once against the editor's
 * cool-tinted neutrals rather than any colour allowed (scope §10). The four
 * of mockup 6a. Blue is today's and the default, and needs no attribute; the
 * others set `data-accent` on the root element (styles.css).
 */
export const ACCENTS = [
  { name: 'blue', label: 'Blue', hex: '#5b6ee8' },
  { name: 'purple', label: 'Purple', hex: '#8b5fd6' },
  { name: 'teal', label: 'Teal', hex: '#2e9e8f' },
  { name: 'sky', label: 'Sky', hex: '#4a8fd9' },
] as const;

export type AccentName = (typeof ACCENTS)[number]['name'];

export const DEFAULT_SETTINGS: AppSettings = { defaultDeck: null, closeToTray: true, accent: 'blue' };

/** The keys of AppSettings, as they are named in preferences.json. */
export const SETTINGS_KEYS: readonly (keyof AppSettings)[] = ['defaultDeck', 'closeToTray', 'accent'];

function isAccent(value: unknown): value is AccentName {
  return ACCENTS.some((a) => a.name === value);
}

/** The settings in a preferences object: anything missing or not understood is its default. */
export function readSettings(preferences: Record<string, unknown>): AppSettings {
  const deck = preferences.defaultDeck;
  return {
    defaultDeck: typeof deck === 'string' && deck !== '' ? deck : DEFAULT_SETTINGS.defaultDeck,
    closeToTray: typeof preferences.closeToTray === 'boolean' ? preferences.closeToTray : DEFAULT_SETTINGS.closeToTray,
    accent: isAccent(preferences.accent) ? preferences.accent : DEFAULT_SETTINGS.accent,
  };
}

/**
 * A change from the settings window, kept to what is valid: unknown keys and
 * values of the wrong kind are dropped, so nothing but settings reaches the
 * preferences file from there.
 */
export function cleanSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (typeof patch !== 'object' || patch === null) return {};
  const p = patch as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  if ('defaultDeck' in p && (p.defaultDeck === null || (typeof p.defaultDeck === 'string' && p.defaultDeck !== ''))) out.defaultDeck = p.defaultDeck as string | null;
  if (typeof p.closeToTray === 'boolean') out.closeToTray = p.closeToTray;
  if (isAccent(p.accent)) out.accent = p.accent;
  return out;
}

/** A deck the Default deck setting can name. */
export interface DeckOption {
  serial: string;
  /** Its name in config, else the model's product name, else the serial. */
  label: string;
  connected: boolean;
}

/**
 * The decks the Default deck setting offers: every deck config.json knows —
 * named, or with a layout in any profile — then any connected deck it does
 * not. The one it is set to is always offered, even if nothing else knows it
 * any more, so opening the window never quietly changes the setting.
 */
export function deckOptions(config: Config | null, decks: DecksResult | null, current: string | null): DeckOption[] {
  const serials: string[] = [];
  const add = (serial: string) => {
    if (!serials.includes(serial)) serials.push(serial);
  };
  for (const serial of Object.keys(config?.decks ?? {})) add(serial);
  for (const profile of Object.values(config?.profiles ?? {})) for (const serial of Object.keys(profile.layouts ?? {})) add(serial);
  for (const deck of decks ?? []) add(deck.serial);
  if (current !== null) add(current);
  return serials.map((serial) => {
    const geometry = decks?.find((d) => d.serial === serial);
    return { serial, label: config?.decks?.[serial]?.name ?? geometry?.productName ?? serial, connected: geometry !== undefined };
  });
}
