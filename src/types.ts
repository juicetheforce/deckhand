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
  /** Friendly name, shown in the editor and in logs. */
  name?: string;
  /** 0-100. */
  brightness?: number;
  /**
   * Present on a virtual deck: what makes a screen one on this computer
   * (src/drivers/virtual.ts). Its controls are the profile's layout's
   * `panel`, not here, so one screen can show a different panel per profile.
   */
  virtual?: VirtualDeckDef;
}

/**
 * A virtual deck: a screen, keyed under "decks" by what recognises it
 * (src/screens.ts — `GRA-6e4e`, `HPN-3469-CNK8231CGN`), and the touchscreen
 * paired with it by a tap.
 */
export interface VirtualDeckDef {
  /** The connector it was set up on ("DP-4"): tells identical screens apart (src/screens.ts findScreen). */
  output: string;
  /** Its touchscreen, from the pairing tap. Absent: the panel shows, and takes no touches. */
  touch?: TouchDeviceDef;
  /**
   * Its default panel: the size chosen when it was added. A profile shows it
   * with this unless its layout has a `panel` of its own (src/panel-presets.ts
   * panelIn). Absent in a config written before defaults existed.
   */
  panel?: PanelDef;
}

/** A touchscreen, as a pairing remembers it (src/touchscreens.ts): its serial when it has one, else its IDs and the port it hangs from. */
export interface TouchDeviceDef {
  /** USB (or other bus) vendor and product IDs, four hex digits each. */
  vendor: string;
  product: string;
  serial?: string;
  /** udev's ID_PATH, when the device has no serial. */
  path?: string;
}

/** One control on a virtual deck's panel, at its place on the panel's canvas. */
export interface PanelControlDef {
  /** Its control id (src/devices.ts): what the pages' `buttons` key it by. Never reused in this panel. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'square';
}

/** A virtual deck's controls for one profile: shared by every page of that layout. */
export interface PanelDef {
  /** The canvas, in pixels: the screen's size when it was laid out. Shown scaled to fit, centred, on any other. */
  size: { width: number; height: number };
  controls: PanelControlDef[];
  /** What generated it ("small", "medium", "large") — information only. */
  preset?: string;
}

/** An entry under a profile's "layouts", keyed by device serial: what one deck shows. */
export interface LayoutDef {
  /** Page ID or name. Defaults to the first page. */
  startPage?: string;
  pages: Record<string, PageDef>;
  /** A virtual deck's controls, for this profile (types.ts PanelDef). Absent on a Stream Deck, whose controls are its own. */
  panel?: PanelDef;
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
  /**
   * How big a built-in icon is drawn, in percent of the key, centred (28–70;
   * 45.5 unless set): what Settings › General › Icon size writes, though it
   * shows it relative to its largest (70 as 100%). An icon file chosen for a
   * key is never resized by it.
   */
  builtinIconSize?: number;
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
  /**
   * Desktop notifications for a key whose press failed with a message that
   * says what to do (src/action-error.ts). On unless false; set in the
   * editor's Settings.
   */
  notifications?: boolean;
  /**
   * Twitch. `clientId`: link with this developer app's client ID instead of
   * Deckhand's own — the escape hatch if Deckhand's is ever revoked:
   * register a *public* app at dev.twitch.tv, set its ID here, and link
   * again. Not secret. Changes the next link only; a saved link keeps the ID
   * it was made with. No Settings UI (REFERENCE).
   */
  twitch?: { clientId?: string };
}

/** What a button should look like right now, after dynamic state is applied. */
export interface Display {
  icon?: string;
  iconFit: 'cover' | 'contain';
  /** Percent of the key a built-in icon is drawn at (Defaults.builtinIconSize); files ignore it. */
  builtinIconSize: number;
  label?: string;
  labelColor: string;
  labelSize: number;
  labelPosition: 'top' | 'bottom' | 'center';
  background: string;
  /** The key's last press failed: drawn with a badge over everything else. */
  failed?: boolean;
  /** Its integration is connecting (Discord's slow handshake): drawn with the connecting badge, in the failed badge's place. */
  connecting?: boolean;
  /**
   * The integration the key needs (OBS) is not set up: its icon drawn at 40%,
   * like app-launch-unset, with the not-set-up badge instead of the failed one.
   */
  unset?: boolean;
}

/** Partial display override returned by an action's describe(). */
export type DisplayPatch = Partial<Display>;

export interface DeckHandle {
  serial: string;
  model: string;
  keyCount: number;
  /** The first screen's width; null on a deck with no screens. */
  iconSize: number | null;
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
  toggleLatch(key: string, combo: string): Promise<void>;
  /** Whether this key is latched down, for its face. */
  isLatched(key: string | null): boolean;
}

export interface ActionContext {
  deck: DeckHandle;
  /** The key pressed, by control id (src/devices.ts); null for an action run over the control socket, which belongs to no key. */
  key: string | null;
  /** A deck key press, or an action run over the control socket. Keys held are tracked per source. */
  source: 'deck' | 'socket';
  /** Switch the active profile on every connected deck, by ID or name. */
  switchProfile(profile: string): Promise<void>;
  /** Re-render buttons whose action type is in the given list. */
  invalidateByType(types: string[]): void;
  log(message: string): void;
}

export interface ActionHandler {
  /**
   * Run the action. Throw to fail the press: the caller logs it and marks the
   * key. Never kills the daemon. Resolve 'armed' when the press only armed
   * its release (obs.stream, live: a hold will stop it) — the release then
   * decides the key's mark. Any other success clears it.
   */
  execute?(ctx: ActionContext, params: ActionDef): Promise<void | 'armed'>;
  /**
   * Optional. Return live display overrides (track title, current sink, etc).
   * Presence of this method is what makes a button refresh on a timer —
   * unless `redraw` is 'events'.
   */
  describe?(ctx: ActionContext, params: ActionDef): Promise<DisplayPatch | null>;
  /**
   * Optional. 'events': the face changes only when something says so — its
   * service's state (index.ts's invalidateByType, from the service's
   * subscribe) or the key's own (a press, its failure mark, a preview, a page
   * shown) — so it is redrawn then, and never on refreshMs. OBS, VTube Studio
   * and Twitch keys: their faces read a state cache only their events change.
   * Without it, a key with describe() is redrawn every refreshMs while it is
   * shown, which a clock needs.
   */
  redraw?: 'events';
  /**
   * Optional. The state a default icon pair shows (src/default-icons.ts):
   * mute for audio.micMute and audio.mute, play state for media.control. Must
   * read cached state only — it runs on every render of the key.
   */
  iconState?(params: ActionDef, ctx?: ActionContext): IconState;
  /**
   * Optional. A file to draw when the key has no icon of its own, found at
   * draw time and never written to the config: the app action's app icon.
   * Null falls through to the built-in default (src/default-icons.ts). Must
   * answer from a cache after its first call — it runs on every render.
   */
  defaultIcon?(params: ActionDef, size: number): Promise<string | null>;
  /**
   * Optional. Run when the key is let go, with how long it was held, for a key
   * whose press and hold mean different things: obs.stream starts on a press
   * and stops only on a hold. Measured from two timestamps — no timer. Not run
   * when the page, profile or layout changed while the key was down. Throw to
   * fail the release, as execute() does. Resolves whether it acted: a release
   * with nothing to do (the press did not arm one) leaves the key's mark as
   * the press left it — the press's own failure must not be cleared by it.
   */
  release?(ctx: ActionContext, params: ActionDef, heldMs: number): Promise<boolean>;
}
