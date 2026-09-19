/**
 * What the shell shows, worked out from the config and the daemon view.
 * Pure functions with no DOM, so test/renderer-model.test.ts runs them in Node.
 *
 * Device knowledge comes from the daemon (scope §3): key positions and counts
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
 * the error (Ship piece 6). The deck draws a badge on them, and the grid
 * mirrors the deck (scope §10), so the grid draws one too. Keyed by the
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
   * Every selected key, `key` included (M4 phase B3, multi-select). Empty
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
 * `preferredDeck` is the Default deck setting (Ship piece 3), passed when a
 * window opens: that deck if the profile has a layout for it, connected or
 * not; otherwise the rule above, for this opening only (the maintainer, 2026-09-18).
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
    return reconcileSelection(config, daemon, { ...current, profile: deck.profile, page: deck.page, ...(moved ? { key: null, keys: [] } : {}) });
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

/**
 * The keys selected after clicking one (M4 phase B3), the way a file manager
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
 * skipped and what lost its navigation (the maintainer, 2026-09-16), because neither is
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

/** A deck keys can be copied to, with its pages (M4 phase B3, Copy to device). */
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
 * The icon a key shows, as the config would write it (scope §3, §10): its own
 * icon — a path or `builtin:<name>` — when it has one; none when `icon` is
 * `null`; otherwise its action's built-in default, from the same
 * `defaultIconFor` the daemon draws with. A key with no action has no default.
 *
 * The editor has no mute or play state, so a state pair shows its resting
 * half (`mic`, `speaker`, `play`), and now playing shows its idle icon. The
 * deck is the truth (§10).
 */
export function faceIcon(button: ButtonDef | undefined): string | null {
  if (!button) return null;
  // Present-but-null is "deliberately none"; `in` tells it from absent, which `??` cannot.
  const action = button.action;
  // A state pair's own icon comes first on the deck (src/deck.ts); the grid shows the resting half's.
  const resting = action?.type === 'media.control' ? action.iconPaused : action?.type === 'audio.micMute' || action?.type === 'audio.mute' ? action.iconUnmuted : undefined;
  if (typeof resting === 'string' && pairIconFields(action).length > 0) return resting;
  if ('icon' in button) return typeof button.icon === 'string' ? button.icon : null;
  const name = defaultIconFor(action, action?.type === 'media.info' ? { idle: true } : {});
  return name === null ? null : builtinRef(name);
}

/**
 * An approximation of the key face (scope §10: the grid is an approximation,
 * the deck is the truth). Live faces — clock time, track, active output — are
 * not drawn; default icons are (faceIcon).
 */
export function keyFace(config: Config, button: ButtonDef | undefined, iconSize: number | null): KeyFace {
  const d = { ...DEFAULTS, ...config.defaults };
  const size = iconSize ?? 72;
  return {
    background: button?.background ?? d.background,
    icon: faceIcon(button),
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
  // A sequence (keys as a list) and gapMs stay read-only: Multi action does sequences.
  hotkey: ['keys', 'holdMs', 'repeat'],
  text: ['text'],
  // `exec` and `wait` are hand-edited only.
  command: ['command'],
  // With its release action; see isPressRelease.
  keyHold: ['keys', 'state'],
  // Each step is checked on its own (MultiForm.tsx); one it cannot edit is shown read-only.
  multi: ['steps'],
  page: ['to', 'back'],
  profile: ['to'],
  // C2 piece 4 (docs/code-state.md): settings left out here — `player`,
  // `maxChars`, the mute backgrounds — keep a hand-edited key read-only.
  clock: ['format'],
  noop: [],
  brightness: ['delta', 'value', 'showLevel'],
  'audio.volume': ['delta', 'showLevel'],
  'audio.micMute': ['iconMuted', 'iconUnmuted', 'labelMuted', 'labelUnmuted'],
  'audio.mute': ['iconMuted', 'iconUnmuted', 'labelMuted', 'labelUnmuted'],
  'media.control': ['method', 'iconPlaying', 'iconPaused'],
  'media.info': ['show', 'showArt', 'idleLabel', 'pressAction'],
  // `match` / `matches` are hand-edited config only (scope §3): a key using them stays read-only.
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
 * (C2 call 3). For an action already of that type, only if it carries fields
 * the form has a control for, so editing cannot silently drop one. Anything
 * with onRelease is read-only: a two-phase key has no form yet.
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
 * such a key "not set up" (C2 call 7): it shows its default icon and looks
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
    // No `matches` form: audio.cycleSource is new, so there is no hand-edited
    // config to keep working (scope §6).
    case 'audio.cycleSource':
      return !(Array.isArray(action.devices) && action.devices.length >= 2);
    default:
      return false;
  }
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
