/**
 * What the shell shows, worked out from the config and the daemon view.
 * Pure functions with no DOM, so test/renderer-model.test.ts runs them in Node.
 *
 * Device knowledge comes from the daemon (scope §3): key positions and counts
 * are read from `decks` geometry, never assumed.
 */
import { DEFAULTS, startPageOf } from '../../../src/config-common.js';
import type { DecksResult } from '../../../src/control/protocol.js';
import type { ButtonDef, Config, LayoutDef } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import { pageLinks, type PageLink } from '../shared/links.js';

export type DeckGeometryWithSerial = DecksResult[number];

export interface Selection {
  profile: string;
  serial: string;
  page: string;
  /** Selected key index, or null. */
  key: number | null;
}

export interface Choice {
  id: string;
  label: string;
}

export interface DeckChoice extends Choice {
  connected: boolean;
  hasLayout: boolean;
}

export function profileChoices(config: Config): Choice[] {
  return Object.entries(config.profiles).map(([id, p]) => ({ id, label: p.name ?? id }));
}

export function layoutFor(config: Config, profile: string, serial: string): LayoutDef | null {
  const p = Object.prototype.hasOwnProperty.call(config.profiles, profile) ? config.profiles[profile] : undefined;
  if (!p || !Object.prototype.hasOwnProperty.call(p.layouts, serial)) return null;
  return p.layouts[serial];
}

export function geometryFor(daemon: DaemonView, serial: string): DeckGeometryWithSerial | null {
  return daemon.decks?.find((d) => d.serial === serial) ?? null;
}

/**
 * The Device dropdown: decks this profile has a layout for, in config order,
 * then connected decks it has none for. Connection state lives here, not in
 * a toolbar pill (scope §10).
 */
export function deckChoices(config: Config, profile: string, daemon: DaemonView): DeckChoice[] {
  const layouts = Object.keys(config.profiles[profile]?.layouts ?? {});
  const connected = (daemon.decks ?? []).map((d) => d.serial);
  const serials = [...layouts, ...connected.filter((s) => !layouts.includes(s))];
  return serials.map((serial) => {
    const geometry = geometryFor(daemon, serial);
    const name = config.decks?.[serial]?.name ?? geometry?.productName ?? serial;
    return { id: serial, label: name, connected: geometry !== null, hasLayout: layouts.includes(serial) };
  });
}

/**
 * Every deck the editor knows about, for the new-profile control: the decks
 * named in config, then any connected deck that is not. Unlike deckChoices
 * this is not scoped to a profile — it is the set a new profile may cover.
 */
export function knownDecks(config: Config, daemon: DaemonView): DeckChoice[] {
  const named = Object.keys(config.decks ?? {});
  const connected = (daemon.decks ?? []).map((d) => d.serial);
  const serials = [...named, ...connected.filter((s) => !named.includes(s))];
  return serials.map((serial) => {
    const geometry = geometryFor(daemon, serial);
    return {
      id: serial,
      label: config.decks?.[serial]?.name ?? geometry?.productName ?? serial,
      connected: geometry !== null,
      hasLayout: false,
    };
  });
}

/** What deleting a page would do, for the confirmation (scope §7, B1). */
export interface PageDeletion {
  /** Keys in this layout that navigate to it, and would lose that action. */
  links: PageLink[];
  /** The page the deck would start on instead, or null if that does not change. */
  startPageAfter: string | null;
  /** Why it cannot be deleted at all, or null. */
  refusal: string | null;
}

/**
 * A description only — config-document.ts is what actually applies the delete,
 * and test/config-store.test.ts checks this description against what it does.
 * The links come from the same pageLinks() the edit uses, and the start page
 * from the daemon's own startPageOf, so neither rule is restated here.
 */
export function pageDeletion(config: Config, profile: string, serial: string, page: string): PageDeletion | null {
  const layout = layoutFor(config, profile, serial);
  if (!layout || !Object.prototype.hasOwnProperty.call(layout.pages, page)) return null;
  const remaining = Object.keys(layout.pages).filter((id) => id !== page);
  if (remaining.length === 0) {
    return { links: [], startPageAfter: null, refusal: "This is the deck's only page in this profile, and a layout must keep one." };
  }
  const pages = Object.fromEntries(Object.entries(layout.pages).filter(([id]) => id !== page));
  // No startPage fixup here, deliberately. The edit has to write one, because
  // validateConfig refuses a startPage that does not resolve; startPageOf only
  // has to *answer*, and its fallback is the first remaining page — which is
  // exactly what the edit writes. Restating the rule would be a second copy to
  // drift (config-store.test.ts checks the two agree).
  const startPageAfter = startPageOf({ ...layout, pages });
  return {
    links: pageLinks(layout, page),
    startPageAfter: startPageAfter === startPageOf(layout) ? null : startPageAfter,
    refusal: null,
  };
}

/** What a key's label inherits when it sets nothing: config `defaults`, then the daemon's. */
export function labelDefaults(config: Config): { labelPosition: 'top' | 'bottom' | 'center'; labelColor: string; labelSize: number } {
  const d = { ...DEFAULTS, ...config.defaults };
  return { labelPosition: d.labelPosition, labelColor: d.labelColor, labelSize: d.labelSize };
}

/** A page's display name, for messages: its name, else its ID. */
export function pageLabel(layout: LayoutDef, page: string): string {
  return layout.pages[page]?.name ?? page;
}

export function pageChoices(layout: LayoutDef): Choice[] {
  return Object.entries(layout.pages).map(([id, page]) => ({ id, label: page.name ?? id }));
}

/**
 * Keep the selection when it still points at something that exists; otherwise
 * pick a sensible one: the daemon's active profile, the first connected deck
 * with a layout in it, and that layout's start page (the daemon's own rule).
 */
export function reconcileSelection(config: Config, daemon: DaemonView, current: Selection | null): Selection {
  const profiles = Object.keys(config.profiles);
  const active = daemon.status?.activeProfile?.id;
  const profile =
    current && profiles.includes(current.profile) ? current.profile : active && profiles.includes(active) ? active : profiles[0];

  const decks = deckChoices(config, profile, daemon);
  const keepSerial = current && current.profile === profile && decks.some((d) => d.id === current.serial);
  const serial = keepSerial
    ? current!.serial
    : (decks.find((d) => d.connected && d.hasLayout) ?? decks.find((d) => d.hasLayout) ?? decks[0])?.id ?? '';

  const layout = layoutFor(config, profile, serial);
  let page = '';
  if (layout) {
    const keepPage = current && current.profile === profile && current.serial === serial && Object.prototype.hasOwnProperty.call(layout.pages, current.page);
    page = keepPage ? current!.page : startPageOf(layout);
  }
  const samePage = current && current.profile === profile && current.serial === serial && current.page === page;
  return { profile, serial, page, key: samePage ? current!.key : null };
}

/**
 * The breadcrumb follows the deck (scope §10, live switching): when the
 * selected deck is showing a page, the selection moves to that profile and
 * page, unconditionally. The selected key is kept only if the page did not
 * change. A deck with nothing to report (disconnected, no session, daemon
 * not connected) leaves the selection as it is.
 */
export function followDeck(config: Config, daemon: DaemonView, current: Selection): Selection {
  const deck = daemon.connected ? daemon.status?.decks.find((d) => d.serial === current.serial) : undefined;
  if (deck?.profile && deck.page && Object.prototype.hasOwnProperty.call(config.profiles, deck.profile)) {
    const moved = deck.profile !== current.profile || deck.page !== current.page;
    return reconcileSelection(config, daemon, { ...current, profile: deck.profile, page: deck.page, key: moved ? null : current.key });
  }
  return reconcileSelection(config, daemon, current);
}

/**
 * The deck to edit after choosing a profile: the current one if the profile
 * has a layout for it, otherwise the first connected deck it covers, otherwise
 * the first deck it has a layout for. Keeps the breadcrumb on a deck the new
 * profile actually shows, so following does not bounce it back.
 */
export function deckForProfile(config: Config, daemon: DaemonView, profile: string, preferred: string): string {
  if (layoutFor(config, profile, preferred)) return preferred;
  const choices = deckChoices(config, profile, daemon);
  return (choices.find((d) => d.connected && d.hasLayout) ?? choices.find((d) => d.hasLayout))?.id ?? preferred;
}

/** Whether a selection change can be shown on the deck right now. */
export function canSwitchDeck(daemon: DaemonView, serial: string): boolean {
  return daemon.connected && (daemon.status?.decks.some((d) => d.serial === serial && d.connected && d.page !== undefined) ?? false);
}

export type KeyKind = 'empty' | 'unbound' | 'hotkey' | 'other';

/**
 * - empty: no button.
 * - unbound: shows something (icon, label or background) but does nothing on
 *   press — marked in the grid, since it looks like a bound key (scope §10).
 * - hotkey: editable in phase A.
 * - other: any other action; read-only in phase A.
 */
export function keyKind(button: ButtonDef | undefined): KeyKind {
  if (!button || Object.keys(button).length === 0) return 'empty';
  if (!button.action && !button.onRelease) return 'unbound';
  if (button.action?.type === 'hotkey') return 'hotkey';
  return 'other';
}

export interface KeyFace {
  background: string;
  icon: string | null;
  iconFit: 'cover' | 'contain';
  label: string | null;
  labelColor: string;
  labelPosition: 'top' | 'bottom' | 'center';
  /** The label size as a fraction of the key's width, from the deck's pixel size. */
  labelScale: number;
}

/**
 * An approximation of the key face (scope §10: the grid is an approximation,
 * the deck is the truth). Live faces — clock, now playing, active output —
 * are not drawn.
 */
export function keyFace(config: Config, button: ButtonDef | undefined, iconSize: number | null): KeyFace {
  const d = { ...DEFAULTS, ...config.defaults };
  const size = iconSize ?? 72;
  return {
    background: button?.background ?? d.background,
    icon: button?.icon ?? null,
    iconFit: button?.iconFit ?? d.iconFit,
    label: button?.label ?? null,
    labelColor: button?.labelColor ?? d.labelColor,
    labelPosition: button?.labelPosition ?? d.labelPosition,
    labelScale: (button?.labelSize ?? d.labelSize) / size,
  };
}

/**
 * The fields each editable action type may carry. An action with anything else
 * on it is shown read-only, so editing it here cannot silently drop settings
 * the inspector has no field for (scope §10, phase A's rule for hotkey,
 * extended to page and profile in phase B).
 */
const EDITABLE_FIELDS: Record<string, readonly string[]> = {
  hotkey: ['keys'],
  page: ['to', 'back'],
  profile: ['to'],
};

/**
 * Whether the inspector may edit this key's action as `type`. True for a key
 * with no action at all — it can become anything — and for an action already
 * of that type carrying only fields the inspector knows about. Anything with
 * onRelease is read-only: that is a two-phase key, which is phase C.
 */
export function actionEditable(button: ButtonDef | undefined, type: string): boolean {
  if (button?.onRelease) return false;
  const action = button?.action;
  if (!action) return true;
  if (action.type !== type) return false;
  const fields = EDITABLE_FIELDS[type];
  if (!fields) return false;
  // A hotkey sequence is an array; phase A edits single combos only.
  if (type === 'hotkey' && typeof action.keys !== 'string') return false;
  return Object.keys(action).every((k) => k === 'type' || fields.includes(k));
}

/** Kept for phase A's call sites and tests: hotkey is just one editable type. */
export function hotkeyEditable(button: ButtonDef | undefined): boolean {
  return actionEditable(button, 'hotkey');
}

/**
 * The decks a profile covers, by their display names — §2's discoverability
 * point, which asks that a profile say plainly that it changes both decks.
 * `connected` decks it does not cover are what the uncovered-deck warning
 * needs (scope §10).
 */
export function profileCoverage(
  config: Config,
  daemon: DaemonView,
  profile: string,
): { covered: string[]; uncoveredConnected: string[] } {
  const layouts = Object.keys(config.profiles[profile]?.layouts ?? {});
  const label = (serial: string) =>
    config.decks?.[serial]?.name ?? geometryFor(daemon, serial)?.productName ?? serial;
  const uncoveredConnected = (daemon.decks ?? []).filter((d) => !layouts.includes(d.serial)).map((d) => label(d.serial));
  return { covered: layouts.map(label), uncoveredConnected };
}

/** One line describing what a key does, for its tooltip and the inspector. */
export function describeAction(button: ButtonDef | undefined): string {
  const action = button?.action;
  if (!action) return button?.onRelease ? 'runs an action on release only' : 'does nothing when pressed';
  if (action.type === 'hotkey') {
    const keys = Array.isArray(action.keys) ? action.keys.join(', then ') : String(action.keys ?? '');
    return `hotkey ${keys}`;
  }
  return action.type;
}
