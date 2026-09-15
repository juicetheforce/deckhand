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
