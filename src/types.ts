import type { IconState } from './default-icons.js';

export interface ActionDef {
  type: string;
  [param: string]: unknown;
}

export interface ButtonDef {
  /**
   * Three states: **absent** means nothing is chosen, so
   * the action's built-in default renders (src/default-icons.ts); **null**
   * means deliberately no icon, for a label-only button; a **string** is an
   * absolute path, or ~/..., to any image file, resized to fit automatically —
   * or `builtin:<name>`, one of the icons shipped with the app.
   */
  icon?: string | null;
  /** 'cover' crops to fill the square, 'contain' letterboxes. */
  iconFit?: 'cover' | 'contain';
  label?: string;
  labelColor?: string;
  labelSize?: number;
  labelPosition?: 'top' | 'bottom' | 'center';
  background?: string;
  action?: ActionDef;
  /** Fired on release instead of press. Useful for hold-to-talk style keys. */
  onRelease?: ActionDef;
  /** Override the automatic refresh interval for dynamic buttons, in ms. */
  refreshMs?: number;
}

/** An entry under a layout's "pages", keyed by page ID. */
export interface PageDef {
  /** Display name. Optional: a page without one is known by its ID. */
  name?: string;
  /** Button index (as a string) -> definition. Index 0 is top-left. */
  buttons: Record<string, ButtonDef>;
}

/**
 * An entry under "decks", keyed by device serial. Hardware settings only —
 * what the deck shows lives in a profile's layout, so these are not repeated
 * in every profile.
 */
export interface DeckDef {
  /** Friendly name, only used in logs. */
  name?: string;
  /** 0-100. */
  brightness?: number;
}

/** An entry under a profile's "layouts", keyed by device serial: what one deck shows. */
export interface LayoutDef {
  /** Page ID or name. Defaults to the first page. */
  startPage?: string;
  pages: Record<string, PageDef>;
}

/** An entry under "profiles", keyed by profile ID. */
export interface ProfileDef {
  /** Display name. Optional: a profile without one is known by its ID. */
  name?: string;
  /**
   * Keyed by device serial. A connected deck with no layout here keeps
   * whatever it was showing when this profile becomes active.
   */
  layouts: Record<string, LayoutDef>;
}

export interface Defaults {
  background?: string;
  labelColor?: string;
  labelSize?: number;
  labelPosition?: 'top' | 'bottom' | 'center';
  iconFit?: 'cover' | 'contain';
  brightness?: number;
  /** Default refresh interval for buttons that render live state. */
  refreshMs?: number;
}

export interface Config {
  defaults?: Defaults;
  /** Keyed by device serial number. Use `npm run decks` to discover yours. */
  decks?: Record<string, DeckDef>;
  profiles: Record<string, ProfileDef>;
  /** Profile ID or name. Defaults to the first profile. */
  startProfile?: string;
}

/** What a button should look like right now, after dynamic state is applied. */
export interface Display {
  icon?: string;
  iconFit: 'cover' | 'contain';
  label?: string;
  labelColor: string;
  labelSize: number;
  labelPosition: 'top' | 'bottom' | 'center';
  background: string;
  /** The key's last press failed: drawn with a badge over everything else. */
  failed?: boolean;
}

/** Partial display override returned by an action's describe(). */
export type DisplayPatch = Partial<Display>;

export interface DeckHandle {
  serial: string;
  model: string;
  keyCount: number;
  iconSize: number;
  /** Switch to a page on this deck, by ID or name. */
  goToPage(page: string): Promise<void>;
  /** Whether this deck's layout has a page with this ID or name. */
  hasPage(page: string): boolean;
  /** Return to the previously shown page. */
  goBack(): Promise<void>;
  setBrightness(value: number): Promise<void>;
  /** The brightness this deck was last set to, 5-100. */
  currentBrightness(): number;
  /** The ID of the page currently shown. */
  currentPage(): string;
  /**
   * Latching toggle: press once and the combo stays
   * down, press again and it releases. The session owns the state because it
   * owns the lifecycle — leaving the page, the deck going away or the helper
   * restarting all have to release it, and nothing may leave a key held.
   * Throws if another key on this deck already latches an overlapping combo.
   */
  toggleLatch(index: number, combo: string): Promise<void>;
  /** Whether this key is latched down, for its face. */
  isLatched(index: number): boolean;
}

export interface ActionContext {
  deck: DeckHandle;
  buttonIndex: number;
  /** A deck key press, or an action run over the control socket. Keys held are tracked per source. */
  source: 'deck' | 'socket';
  /** Switch the active profile on every connected deck, by ID or name. */
  switchProfile(profile: string): Promise<void>;
  /** Re-render buttons whose action type is in the given list. */
  invalidateByType(types: string[]): void;
  log(message: string): void;
}

export interface ActionHandler {
  /** Run the action. Errors are caught and logged; they never kill the daemon. */
  execute?(ctx: ActionContext, params: ActionDef): Promise<void>;
  /**
   * Optional. Return live display overrides (track title, current sink, etc).
   * Presence of this method is what makes a button refresh on a timer.
   */
  describe?(ctx: ActionContext, params: ActionDef): Promise<DisplayPatch | null>;
  /**
   * Optional. The state a default icon pair shows (src/default-icons.ts):
   * mute for audio.micMute and audio.mute, play state for media.control. Must
   * read cached state only — it runs on every render of the key.
   */
  iconState?(params: ActionDef, ctx?: ActionContext): IconState;
}
