import type { Config } from '../../../src/types.js';
import type { DecksResult } from '../../../src/control/protocol.js';

/**
 * The editor's app settings: what the settings window
 * shows and changes. Kept in the editor's preferences file, never config.json
 * — they are about this editor, not about the decks. Pure, so main, both
 * renderers and the tests share one reading of what is stored.
 */
export interface AppSettings {
  /** The deck the editor opens on, by serial; null is Automatic. */
  defaultDeck: string | null;
  /** Closing the editor leaves it in the tray; off, closing quits. */
  closeToTray: boolean;
  accent: AccentName;
}

/**
 * The accent colours: a closed set, each checked once against the editor's
 * cool-tinted neutrals rather than any colour allowed. Blue is the default,
 * and needs no attribute; the others set `data-accent` on the root element (styles.css).
 */
export const ACCENTS = [
  { name: 'blue', label: 'Blue', hex: '#5b6ee8' },
  { name: 'purple', label: 'Purple', hex: '#8b5fd6' },
  { name: 'teal', label: 'Teal', hex: '#2e9e8f' },
  { name: 'sky', label: 'Sky', hex: '#4a8fd9' },
] as const;

export type AccentName = (typeof ACCENTS)[number]['name'];

export const DEFAULT_SETTINGS: AppSettings = { defaultDeck: null, closeToTray: true, accent: 'blue' };

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

/** A deck the Default deck setting offers. */
export interface DeckOption {
  serial: string;
  /** Its name in config, else the model's product name, else the serial. */
  label: string;
}

/**
 * The decks the Default deck setting offers: the connected ones, in the order
 * config.json knows them, then any it does not. A deck that is not plugged in
 * is not listed, like every other device list in the editor.
 *
 * The saved setting can still name an absent deck, so unplugging it does not
 * lose the choice: this list only leaves it out. While it is absent the editor
 * opens as Automatic would, on the first connected deck with a layout
 * (reconcileSelection), and on the chosen deck again once it is back.
 */
export function deckOptions(config: Config | null, decks: DecksResult | null): DeckOption[] {
  const known = [...Object.keys(config?.decks ?? {}), ...Object.values(config?.profiles ?? {}).flatMap((p) => Object.keys(p.layouts ?? {}))];
  const connected = [...(decks ?? [])].sort((a, b) => rank(known, a.serial) - rank(known, b.serial));
  return connected.map((deck) => ({ serial: deck.serial, label: config?.decks?.[deck.serial]?.name ?? deck.productName ?? deck.serial }));
}

/** Where a serial first appears in config, or after all of them if it does not. */
function rank(known: string[], serial: string): number {
  const at = known.indexOf(serial);
  return at === -1 ? known.length : at;
}
