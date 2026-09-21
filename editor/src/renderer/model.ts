/**
 * What the shell shows, worked out from the config and the daemon view.
 * Pure functions with no DOM, so test/renderer-model.test.ts runs them in Node.
 *
 * Device knowledge comes from the daemon: key positions and counts
 * are read from `decks` geometry, never assumed.
 */
import { DEFAULTS, startPageOf } from '../../../src/config-common.js';
import { defaultIconFor } from '../../../src/default-icons.js';
import type { DecksResult } from '../../../src/control/protocol.js';
import type { ActionDef, ButtonDef, Config, LayoutDef } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import { builtinRef, pairIconFields } from '../shared/icons.js';
import { keyName, rangeSelection, type Clipboard, type KeyGrid, type Placement } from '../shared/bulk.js';
import { pageLinks, type PageLink } from '../shared/links.js';

export type DeckGeometryWithSerial = DecksResult[number];

/**
 * The keys on the page being edited whose last press on the deck failed, with
 * the error. The deck draws a badge on them, and the grid mirrors the deck,
 * so the grid draws one too. Keyed by the
 * selection's profile and page, not by what the deck shows: a key failed on
 * a page stays failed while the deck is elsewhere.
 */
export function failedKeysOn(daemon: DaemonView, selection: Pick<Selection, 'profile' | 'serial' | 'page'>): Record<number, string> {
  const deck = daemon.status?.decks.find((d) => d.serial === selection.serial);
  const failed: Record<number, string> = {};
  for (const f of deck?.failed ?? []) if (f.profile === selection.profile && f.page === selection.page) failed[f.key] = f.error;
  return failed;
}

export interface Selection {
  profile: string;
  serial: string;
  page: string;
  /**
   * The key the inspector shows, or null. With several keys selected it is
   * the anchor: the last key clicked, where a Shift+click range starts.
   */
  key: number | null;
  /**
   * Every selected key, `key` included. Empty
   * exactly when `key` is null.
   */
  keys: number[];
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
 * The Device dropdown: **only decks that are plugged in right now** — those
 * this profile has a layout for, in config order, then the rest.
 *
 * A deck that is not connected is not listed at all. "The list is the list" — it is a list of devices to work on, not a
 * status display, and **its absence is the indicator that it is missing.**
 * The case that settles it is a deck that has been sold, replaced or
 * upgraded: its serial stays in `config.json` for ever, and it would sit in
 * this dropdown for ever with it.
 *
 * Nothing is lost by it: a layout can only be edited with the deck present,
 * because the grid is drawn from the geometry the daemon reads off the device
 * Every entry this returns therefore has geometry, and
 * `connected` is true on all of them — kept on the type because the daemon's
 * `decks` and `status` lists can disagree for an instant, so callers still
 * guard.
 */
export function deckChoices(config: Config, profile: string, daemon: DaemonView): DeckChoice[] {
  const layouts = Object.keys(config.profiles[profile]?.layouts ?? {});
  const connected = (daemon.decks ?? []).map((d) => d.serial);
  const serials = [...layouts.filter((s) => connected.includes(s)), ...connected.filter((s) => !layouts.includes(s))];
  return serials.map((serial) => {
    const geometry = geometryFor(daemon, serial);
    const name = config.decks?.[serial]?.name ?? geometry?.productName ?? serial;
    return { id: serial, label: name, connected: geometry !== null, hasLayout: layouts.includes(serial) };
  });
}

/**
 * The decks a new profile may cover: **the connected ones**, named in config
 * first. Unlike deckChoices this is not scoped to a profile.
 *
 * Same rule and the same reason as deckChoices: a deck
 * that is not plugged in is not offered. Ticking a sold deck into a new
 * profile would write a layout nobody can edit or see. With none connected
 * the panel already says "No decks are known yet. Plug one in."
 */
export function knownDecks(config: Config, daemon: DaemonView): DeckChoice[] {
  const named = Object.keys(config.decks ?? {});
  const connected = (daemon.decks ?? []).map((d) => d.serial);
  const serials = [...named.filter((s) => connected.includes(s)), ...connected.filter((s) => !named.includes(s))];
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

/** What deleting a page would do, for the confirmation. */
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

/** A profile's display name, for messages: its name, else its ID. */
export function profileLabel(config: Config, profile: string): string {
  return config.profiles[profile]?.name ?? profile;
}

/** A deck's display name, for messages: its configured name, then the model, then the serial. */
export function deckLabel(config: Config, daemon: DaemonView, serial: string): string {
  return config.decks?.[serial]?.name ?? geometryFor(daemon, serial)?.productName ?? serial;
}

/** A page's display name inside a profile's layout, for messages across profiles. */
export function pageLabelIn(config: Config, profile: string, serial: string, page: string): string {
  return config.profiles[profile]?.layouts[serial]?.pages[page]?.name ?? page;
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
 *
 * `preferredDeck` is the Default deck setting, passed when a window opens:
 * that deck if it is connected and the profile has a layout for it; otherwise
 * the rule above, for this opening only.
 */
export function reconcileSelection(config: Config, daemon: DaemonView, current: Selection | null, preferredDeck: string | null = null): Selection {
  const profiles = Object.keys(config.profiles);
  const active = daemon.status?.activeProfile?.id;
  const profile =
    current && profiles.includes(current.profile) ? current.profile : active && profiles.includes(active) ? active : profiles[0];

  const decks = deckChoices(config, profile, daemon);
  const keepSerial = current && current.profile === profile && decks.some((d) => d.id === current.serial);
  const preferred = preferredDeck === null ? undefined : decks.find((d) => d.id === preferredDeck && d.hasLayout);
  const serial = keepSerial
    ? current!.serial
    : (preferred ?? decks.find((d) => d.connected && d.hasLayout) ?? decks.find((d) => d.hasLayout) ?? decks[0])?.id ?? '';

  const layout = layoutFor(config, profile, serial);
  let page = '';
  if (layout) {
    const keepPage = current && current.profile === profile && current.serial === serial && Object.prototype.hasOwnProperty.call(layout.pages, current.page);
    page = keepPage ? current!.page : startPageOf(layout);
  }
  const samePage = current && current.profile === profile && current.serial === serial && current.page === page;
  return samePage ? { profile, serial, page, key: current!.key, keys: current!.keys } : { profile, serial, page, key: null, keys: [] };
}

/**
 * The breadcrumb follows the deck: when the
 * selected deck is showing a page, the selection moves to that profile and
 * page, unconditionally. The selected key is kept only if the page did not
 * change. A deck with nothing to report (disconnected, no session, daemon
 * not connected) leaves the selection as it is.
 */
export function followDeck(config: Config, daemon: DaemonView, current: Selection): Selection {
  // Settle on a deck that exists *first*, then follow that one. Following
  // `current.serial` directly misses the deck's real page whenever the
  // selection names no deck that is here: until the daemon reports its decks
  // the serial is "", the lookup below finds nothing, and the editor would
  // open on the layout's start page instead of the page the deck is showing.
  const settled = reconcileSelection(config, daemon, current);
  const deck = daemon.connected ? daemon.status?.decks.find((d) => d.serial === settled.serial) : undefined;
  if (deck?.profile && deck.page && Object.prototype.hasOwnProperty.call(config.profiles, deck.profile)) {
    const moved = deck.profile !== settled.profile || deck.page !== settled.page;
    return reconcileSelection(config, daemon, { ...settled, profile: deck.profile, page: deck.page, ...(moved ? { key: null, keys: [] } : {}) });
  }
  return settled;
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

/**
 * The keys selected after clicking one, the way a file manager
 * selects icons:
 * - a plain click selects that key alone;
 * - Ctrl+click adds it, or takes it out if it was selected;
 * - Shift+click selects the run from the anchor (`key`) to it, in reading
 *   order, and keeps the anchor so the next Shift+click starts from the same
 *   place.
 */
export function clickKeys(
  grid: KeyGrid,
  current: Pick<Selection, 'key' | 'keys'>,
  index: number,
  modifiers: { ctrl: boolean; shift: boolean },
): Pick<Selection, 'key' | 'keys'> {
  if (modifiers.shift && current.key !== null) {
    return { key: current.key, keys: rangeSelection(grid, current.key, index) };
  }
  if (modifiers.ctrl) {
    if (!current.keys.includes(index)) return { key: index, keys: [...current.keys, index] };
    const keys = current.keys.filter((k) => k !== index);
    return { key: current.key === index ? (keys[keys.length - 1] ?? null) : current.key, keys };
  }
  return { key: index, keys: [index] };
}

/** "3 keys (“Jump”, “Sprint” and key 7)" — what the clipboard holds, for the line under the grid. */
export function clipboardSummary(clip: Clipboard): string {
  const names = clip.keys.map((k) => keyName(k.button, k.sourceIndex));
  const count = clip.keys.length === 1 ? '1 key' : `${clip.keys.length} keys`;
  const shown = names.length <= 3 ? joinNames(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${count} (${shown})`;
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a paste or copy did, in words — the status line has to name what was
 * skipped and what lost its navigation, because neither is
 * visible on the grid being looked at.
 */
export function placementMessage(verb: 'Pasted' | 'Copied', placement: Placement, destination: string): string {
  const written = placement.writes.length;
  const parts: string[] = [];
  if (written === 0) parts.push(`Nothing ${verb.toLowerCase()}: no copied key has a place on ${destination}.`);
  else parts.push(`${verb} ${written === 1 ? '1 key' : `${written} keys`} to ${destination}.`);
  if (written > 0 && placement.skipped.length > 0) {
    const names = joinNames(placement.skipped.map((k) => keyName(k.button, k.sourceIndex)));
    parts.push(`Skipped ${names}: ${placement.skipped.length === 1 ? 'it has' : 'they have'} no place on that deck.`);
  }
  if (placement.lostNavigation.length > 0) {
    const names = joinNames(placement.lostNavigation.map((l) => keyName(l.key.button, l.index)));
    const one = placement.lostNavigation.length === 1;
    parts.push(`${names} lost ${one ? 'its' : 'their'} Go to page: that page is not on this deck, so ${one ? 'it needs' : 'they need'} a new target.`);
  }
  return parts.join(' ');
}

/** A deck that Copy to device can send keys to, with its pages. */
export interface DeviceTarget {
  serial: string;
  label: string;
  /** Keys land by row and column, so a deck whose geometry the editor cannot see cannot be copied to. */
  connected: boolean;
  pages: Choice[];
}

/**
 * Where "Copy to device" can send keys: every other deck the profile being
 * edited has a layout for, in the Device dropdown's order. Another profile's
 * decks are reached with Copy, a profile switch and Paste — a copy that reached
 * into a profile you are not looking at would be one you cannot see land.
 */
export function deviceTargets(config: Config, daemon: DaemonView, selection: Selection): DeviceTarget[] {
  return deckChoices(config, selection.profile, daemon)
    .filter((deck) => deck.hasLayout && deck.id !== selection.serial)
    .map((deck) => ({
      serial: deck.id,
      label: deck.label,
      connected: deck.connected,
      pages: pageChoices(layoutFor(config, selection.profile, deck.id)!),
    }));
}

/** Whether a selection change can be shown on the deck right now. */
export function canSwitchDeck(daemon: DaemonView, serial: string): boolean {
  return daemon.connected && (daemon.status?.decks.some((d) => d.serial === serial && d.connected && d.page !== undefined) ?? false);
}

export type KeyKind = 'empty' | 'unbound' | 'hotkey' | 'other';

/**
 * - empty: no button.
 * - unbound: shows something (icon, label or background) but does nothing on
 *   press — marked in the grid, since it looks like a bound key.
 * - hotkey: a hotkey action.
 * - other: any other action.
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
 * The icon a key shows, as the config would write it: its own
 * icon — a path or `builtin:<name>` — when it has one; none when `icon` is
 * `null`; otherwise its action's built-in default, from the same
 * `defaultIconFor` the daemon draws with. A key with no action has no default.
 *
 * The editor has no mute or play state, so a state pair shows its resting
 * half (`mic`, `speaker`, `play`), and now playing shows its idle icon. The
 * deck is the truth.
 */
export function faceIcon(button: ButtonDef | undefined, latched = false): string | null {
  if (!button) return null;
  const action = button.action;
  // A state pair's own icon comes first on the deck (src/deck.ts); the grid
  // shows the resting half's — except a toggle, whose state the daemon reports
  // per key, so the grid can show the half the deck is really showing.
  const toggleIcon = action?.type === 'toggle' ? (latched ? action.iconOn : action.iconOff) : undefined;
  const resting = action?.type === 'media.control' ? action.iconPaused : action?.type === 'audio.micMute' || action?.type === 'audio.mute' ? action.iconUnmuted : toggleIcon;
  if (typeof resting === 'string' && pairIconFields(action).length > 0) return resting;
  // Present-but-null is "deliberately none"; `in` tells it from absent, which `??` cannot.
  if ('icon' in button) return typeof button.icon === 'string' ? button.icon : null;
  const name = defaultIconFor(action, action?.type === 'media.info' ? { idle: true } : { latched });
  return name === null ? null : builtinRef(name);
}

/**
 * The keys this deck is holding down right now, from the daemon's status.
 * Only while the grid is showing the page the deck is on: a latch is released
 * when the deck leaves the page, so a latch on another page cannot exist, and
 * drawing one would be a lie. The deck is the truth.
 */
export function latchedKeysOn(daemon: DaemonView, selection: Pick<Selection, 'profile' | 'serial' | 'page'>): number[] {
  const deck = daemon.status?.decks.find((d) => d.serial === selection.serial);
  if (!deck || deck.profile !== selection.profile || deck.page !== selection.page) return [];
  return deck.latched ?? [];
}

/**
 * An approximation of the key face; the deck is the truth. Live faces — clock
 * time, track, active output — are not drawn; default icons are (faceIcon).
 */
export function keyFace(config: Config, button: ButtonDef | undefined, iconSize: number | null, latched = false): KeyFace {
  const d = { ...DEFAULTS, ...config.defaults };
  const size = iconSize ?? 72;
  return {
    background: button?.background ?? d.background,
    icon: faceIcon(button, latched),
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
 * the inspector has no field for.
 */
const EDITABLE_FIELDS: Record<string, readonly string[]> = {
  // A sequence (keys as a list) and gapMs stay read-only: Multi action does sequences.
  hotkey: ['keys', 'holdMs', 'repeat'],
  text: ['text'],
  // `exec` and `wait` are hand-edited only.
  command: ['command'],
  // With its release action; see isPressRelease.
  keyHold: ['keys', 'state'],
  // The toggle: the combo, and the icon pair the picker sets (shared/icons.ts
  // pairIconFields). `labelOn`/`labelOff` and the backgrounds stay hand-edited.
  toggle: ['keys', 'iconOn', 'iconOff'],
  // Each step is checked on its own (MultiForm.tsx); one it cannot edit is shown read-only.
  multi: ['steps'],
  page: ['to', 'back'],
  profile: ['to'],
  // Settings left out here — `player`, `maxChars`, the mute backgrounds —
  // keep a hand-edited key read-only.
  clock: ['format'],
  noop: [],
  brightness: ['delta', 'value', 'showLevel'],
  'audio.volume': ['delta', 'showLevel'],
  'audio.micMute': ['iconMuted', 'iconUnmuted', 'labelMuted', 'labelUnmuted'],
  'audio.mute': ['iconMuted', 'iconUnmuted', 'labelMuted', 'labelUnmuted'],
  'media.control': ['method', 'iconPlaying', 'iconPaused'],
  'media.info': ['show', 'showArt', 'idleLabel', 'pressAction'],
  // `match` / `matches` are hand-edited config only: a key using them stays read-only.
  'audio.sink': ['node', 'label', 'moveStreams'],
  'audio.source': ['node', 'label', 'moveStreams'],
  'audio.cycle': ['devices', 'showCurrent', 'moveStreams'],
  'audio.cycleSource': ['devices', 'showCurrent', 'moveStreams'],
};

/** Whether the inspector has a form for this action type (src/renderer/inspector/). */
export function hasForm(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, type);
}

/**
 * Whether the inspector may edit this key's action as `type`. Only a type with
 * a form. True for a key with no action — it can become anything — and for a
 * key with **another** action: a library pick retargets it, and the form
 * writes the new action once its setting is chosen, keeping icon and label
 * For an action already of that type, only if it carries fields the form has
 * a control for, so editing cannot silently drop one. A key with onRelease is
 * editable only as the Press/Release pair.
 */
export function actionEditable(button: ButtonDef | undefined, type: string): boolean {
  const fields = EDITABLE_FIELDS[type];
  if (!fields) return false;
  // A release action belongs to Press/Release alone, and only as the pair it writes.
  if (button?.onRelease) return type === 'keyHold' && isPressRelease(button);
  const action = button?.action;
  if (!action) return true;
  if (action.type !== type) return true;
  // A hotkey sequence is an array; the form edits single combos only. No keys
  // at all is a hotkey dropped from the library, waiting to be recorded.
  if (type === 'hotkey' && action.keys !== undefined && typeof action.keys !== 'string') return false;
  return Object.keys(action).every((k) => k === 'type' || fields.includes(k));
}

/**
 * Whether a key is exactly what the Press/Release form writes: `keyHold` down
 * on press and `keyHold` up with the same keys on release, and nothing else on
 * either. Any other release action is read-only here.
 */
export function isPressRelease(button: ButtonDef | undefined): boolean {
  const press = button?.action;
  const release = button?.onRelease;
  const only = (a: ActionDef) => Object.keys(a).every((k) => k === 'type' || k === 'keys' || k === 'state');
  return (
    press?.type === 'keyHold' &&
    release?.type === 'keyHold' &&
    typeof press.keys === 'string' &&
    press.keys === release.keys &&
    press.state !== 'up' &&
    release.state === 'up' &&
    only(press) &&
    only(release)
  );
}

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * Whether an action lacks a setting it cannot run without — what an action
 * dragged from the library has until its form is filled in. The grid marks
 * such a key "not set up": it shows its default icon and looks
 * placed, while a press only logs an error.
 *
 * Mirrors the refusals in the daemon's src/actions/ — a copy, so
 * test/renderer-model.test.ts runs the daemon's own handler on each case here
 * and checks it refuses. A setting that is present but wrong (a device not
 * plugged in, a page that is gone) is not "not set up": other warnings cover
 * those.
 */
export function actionIncomplete(action: ActionDef | undefined): boolean {
  if (!action) return false;
  switch (action.type) {
    case 'hotkey':
      return Array.isArray(action.keys) ? action.keys.length === 0 || !nonEmpty(action.keys[0]) : !nonEmpty(action.keys);
    case 'keyHold':
    case 'toggle':
      return !nonEmpty(action.keys);
    case 'text':
      return typeof action.text !== 'string';
    case 'command':
      return !nonEmpty(action.command) && !(Array.isArray(action.exec) && nonEmpty(action.exec[0]));
    case 'page':
      return action.back !== true && typeof action.to !== 'string';
    case 'profile':
      return typeof action.to !== 'string';
    case 'multi':
      // A step missing its setting is refused when the key is pressed, and the rest still run.
      return !Array.isArray(action.steps) || action.steps.length === 0 || action.steps.some((step) => actionIncomplete(step as ActionDef));
    case 'brightness':
      return typeof action.value !== 'number' && typeof action.delta !== 'number';
    case 'audio.sink':
      return !nonEmpty(action.node) && !nonEmpty(action.match);
    case 'audio.source':
      return !nonEmpty(action.node);
    case 'audio.cycle':
      return !(Array.isArray(action.devices) && action.devices.length >= 2) && !(Array.isArray(action.matches) && action.matches.length >= 2);
    // No `matches` form for audio.cycleSource: it has only ever taken `devices`.
    case 'audio.cycleSource':
      return !(Array.isArray(action.devices) && action.devices.length >= 2);
    default:
      return false;
  }
}

/**
 * The decks a profile covers, by display name, so the UI can say plainly which
 * decks a profile switch changes. Connected decks it does not cover feed the
 * uncovered-deck warning.
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

/** Every serial any profile has a layout for — the same set the daemon calls `configured`. */
function configuredSerials(config: Config): string[] {
  const serials = new Set<string>();
  for (const profile of Object.values(config.profiles)) for (const serial of Object.keys(profile.layouts)) serials.add(serial);
  return [...serials];
}

/**
 * Why there is no grid to show. Five situations, each said differently:
 *
 * - `daemon-down` — the socket is not answering, so **nothing** is known:
 *   not which decks exist, not whether any is plugged in.
 * - `never-configured` — the daemon is there, no deck is plugged in, and no
 *   profile has a layout for any deck. The empty configuration a first
 *   install with no hardware writes.
 * - `all-unplugged` — decks are configured; **none** is plugged in.
 * - `no-layout` — a deck **is** plugged in and this profile has no layout for
 *   it. The only case where offering to add a layout means anything.
 * - `deck-unplugged` — **a guard, not a state you can reach by clicking.**
 *   The Device dropdown lists only connected decks, so the selection is
 *   always a deck that is present; this covers the instant in which the
 *   daemon's `decks` and `status` lists disagree, rather than a deck someone
 *   selected and unplugged. Kept because drawing a grid with no geometry is
 *   the alternative.
 *
 * The order matters as much as the list. "Nothing is connected" is tested
 * before anything per-deck, because with nothing plugged in the selection
 * names no deck (or, for an instant, a stale one), and a per-deck sentence
 * would either be about a deck that is not there or name one deck while
 * every deck is missing.
 *
 * Null means there is a grid to draw.
 */
export type EmptyStateKind = 'daemon-down' | 'never-configured' | 'all-unplugged' | 'no-layout' | 'deck-unplugged';

export interface EmptyState {
  kind: EmptyStateKind;
  /** The heading. */
  title: string;
  /** The sentence under it. */
  detail: string;
  /** Only `no-layout` offers it: there is no deck to add a layout for in the others. */
  canAddLayout: boolean;
}

export function emptyState(config: Config, daemon: DaemonView, selection: Pick<Selection, 'profile' | 'serial'>): EmptyState | null {
  // First, because it is the answer to every other question: with no daemon
  // the editor does not know what is plugged in, so it must not say.
  if (!daemon.connected) {
    return {
      kind: 'daemon-down',
      title: 'The Deckhand daemon is not running',
      // Carries what the Notices banner would otherwise repeat underneath:
      // App.tsx hides that one while this shows.
      detail: `${daemon.problem ?? 'The editor cannot reach it'}. Until it starts, the editor cannot see any deck. Your edits are still saved, and the decks pick them up when it runs.`,
      canAddLayout: false,
    };
  }

  // Before anything per-deck: with nothing plugged in at all, a sentence about
  // one deck understates it. Say what is true of the whole machine, then name
  // the decks it is waiting for.
  if ((daemon.decks ?? []).length === 0) {
    const configured = configuredSerials(config);
    if (configured.length === 0) {
      return {
        kind: 'never-configured',
        title: 'No Stream Deck is connected',
        detail: 'Nothing has been set up yet. Plug a deck in and it appears here — the daemon picks it up without a restart.',
        canAddLayout: false,
      };
    }
    const names = joinNames(configured.map((serial) => deckLabel(config, daemon, serial)));
    return {
      kind: 'all-unplugged',
      title: 'No Stream Deck is connected',
      detail: `${names} ${configured.length === 1 ? 'is' : 'are'} set up, but not plugged in. Plug one in to edit its layout.`,
      canAddLayout: false,
    };
  }

  // Something is plugged in, so from here the per-deck language is about a
  // deck that really is there, or really is the one missing.
  const layout = layoutFor(config, selection.profile, selection.serial);
  if (layout) {
    if (geometryFor(daemon, selection.serial) !== null) return null;
    return {
      kind: 'deck-unplugged',
      title: `${deckLabel(config, daemon, selection.serial)} is not connected`,
      detail: 'Its layout comes from the deck itself, so plug it in to edit this page.',
      canAddLayout: false,
    };
  }

  // A real, connected deck this profile does not cover: the one case where
  // this sentence is true and adding a layout makes sense.
  const name = deckLabel(config, daemon, selection.serial);
  return {
    kind: 'no-layout',
    title: `This profile has no layout for ${name}`,
    detail: `Switching to this profile leaves ${name} showing whatever it had.`,
    canAddLayout: true,
  };
}

/**
 * The toolbar's connection state. It does not depend on a deck being
 * selected: the case that most needs it, nothing connected at all, has none.
 */
export type ConnectionState = 'daemon-down' | 'no-decks' | 'connected' | 'disconnected';

export interface ConnectionPill {
  state: ConnectionState;
  label: string;
}

export function connectionPill(config: Config, daemon: DaemonView, selection: Pick<Selection, 'profile' | 'serial'>): ConnectionPill {
  if (!daemon.connected) return { state: 'daemon-down', label: 'Daemon not running' };
  // The same precedence emptyState() uses, so the pill and the card can never
  // disagree: with nothing plugged in at all, "Not connected" would read as
  // being about the selected deck and imply the others are fine.
  if ((daemon.decks ?? []).length === 0) return { state: 'no-decks', label: 'No decks connected' };
  // Past here at least one deck is plugged in, so "No decks connected" would
  // be false: a selection that is not among them is a *stale* selection, and
  // "Not connected" is the true thing to say about it.
  const selected = deckChoices(config, selection.profile, daemon).find((d) => d.id === selection.serial);
  if (!selected || !selected.connected) return { state: 'disconnected', label: 'Not connected' };
  return { state: 'connected', label: 'Connected' };
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
