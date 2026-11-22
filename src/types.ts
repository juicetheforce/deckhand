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
  /**
   * The icon's scale, in percent of the control (src/icon-scale.ts): at 100
   * the whole image fits the control's box, centred; above, it zooms in and is
   * cut to the shape. 20–200. Absent: a built-in follows
   * `defaults.builtinIconSize`, a file is drawn at 100.
   */
  iconScale?: number;
  /**
   * Retired (src/icon-fit.ts): 'cover' cropped to fill the square, 'contain'
   * letterboxed. Read only in a config from before `"version": 2`, which the
   * editor converts to `iconScale` when it opens it.
   */
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
  /**
   * A virtual deck's controls on this page (types.ts PanelDef): every page of
   * a virtual deck has its own layout. Absent on a Stream Deck's pages, whose
   * controls are its own (src/panel-presets.ts pagePanelIn).
   */
  panel?: PanelDef;
  /**
   * A virtual deck page's background (round 3): the whole screen behind its
   * controls. Absent — every page before it, and a new page — is black and
   * opaque. Ignored on a Stream Deck's pages.
   */
  background?: PageBackgroundDef;
}

/**
 * A page's background on a virtual deck: a colour, an optional image over it,
 * and one opacity for the whole layer. Controls are never faded, and the
 * background never shows through one.
 */
export interface PageBackgroundDef {
  /** "#rrggbb". Black unless set. */
  color?: string;
  /** An image file, a path as an icon's is (never copied); it covers the whole screen. */
  image?: string;
  /** "fill" (the default): covers the screen, cropped. "fit": the whole image, the colour around it. */
  fit?: 'fill' | 'fit';
  /** 0–100, of the whole layer, colour and image together; 100 unless set. Below 100, what is behind the screen shows through. */
  opacity?: number;
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
   * Its default panel: the size chosen when it was added. Every page made
   * automatically for it gets a copy (src/panel-presets.ts). Absent in a
   * config written before defaults existed, until migratePagePanels sets it.
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
  /**
   * src/shapes.ts: a rectangle unless set. `"square"`, which every control
   * written before custom layouts carries, is a rectangle with square corners.
   */
  shape?: 'square' | 'rectangle' | 'round' | 'hexagon';
  /** A rectangle's corner radius in canvas pixels, from 0 to half its shorter side (a full pill). */
  radius?: number;
  /** Edit layout's Lock proportions: resizing keeps the box's proportions. The editor's only; the daemon ignores it. */
  keepRatio?: boolean;
}

/** A virtual deck's controls on one page. */
export interface PanelDef {
  /** The canvas, in pixels: the screen's size when it was laid out. Shown scaled to fit, centred, on any other. */
  size: { width: number; height: number };
  /**
   * In this order on the screen: where two overlap, the later is on top
   * (src/hit-test.ts). Bring to front and Send to back reorder this list.
   */
  controls: PanelControlDef[];
  /**
   * What made it: "small", "medium", "large" or "custom" (Grid Size) for a
   * fixed grid, which nothing can move or reshape; **"free" for a custom
   * layout**, positioned in Edit layout (src/panel-presets.ts isCustomLayout).
   */
  preset?: string;
}

/** An entry under a profile's "layouts", keyed by device serial: what one deck shows. */
export interface LayoutDef {
  /** Page ID or name. Defaults to the first page. */
  startPage?: string;
  pages: Record<string, PageDef>;
  /**
   * Before every page had its own: a virtual deck's controls for this whole
   * profile. Moved onto each page by migratePagePanels (src/panel-presets.ts)
   * whenever a config is loaded; never written any more.
   */
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
  /** Retired, as ButtonDef.iconFit: read only in a config from before `"version": 2`. */
  iconFit?: 'cover' | 'contain';
  /**
   * How big a built-in icon is drawn, in percent of the control, on the one
   * rule of a key's `iconScale` (src/icon-scale.ts), 25–100, 45.5 unless set:
   * Settings › General › Icon size, which shows the same figure. A key with
   * its own `iconScale` does not follow it, and neither does an icon file.
   */
  builtinIconSize?: number;
  /**
   * The label font for every key on every deck: an installed font family's
   * name (Settings › General › Label font). Absent: Deckhand's default,
   * `sans-serif`. A font that is not installed falls back to the default.
   */
  labelFont?: string;
  /**
   * Touch feedback on virtual decks: a touched button drawn pressed (a lighter
   * face at 95%) until it is let go. On unless false. Stream Decks are never
   * affected.
   */
  touchFeedback?: boolean;
  brightness?: number;
  /** Default refresh interval for buttons that render live state. */
  refreshMs?: number;
  /**
   * Deck sleep (src/sleep.ts). `onLock`: sleep when the screen locks, on unless
   * false. `dimAfter` and `sleepAfter`: seconds the desktop is idle before every
   * Stream Deck dims, and goes dark; off unless set. `dimTo`: a percent, 20 unless set.
   */
  sleep?: { onLock?: boolean; dimAfter?: number; dimTo?: number; sleepAfter?: number };
}

export interface Config {
  /**
   * The config's format: absent in every config from before round 4's icon
   * scale, `2` once the editor has converted `iconFit` (src/icon-fit.ts).
   */
  version?: number;
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
  /**
   * Saved layouts for virtual decks' pages (Edit layout's Save as template),
   * oldest first: offered when a page is added on any touchscreen, scaled to
   * fit it. The editor's alone; the daemon never reads them.
   */
  templates?: TemplateDef[];
}

/**
 * A template: a layout and nothing more — each control's place, size and
 * shape (src/shapes.ts), at the size of the screen it was saved on. No
 * actions, art, labels or background. A page made from one is not linked to it.
 */
export interface TemplateDef {
  /** Its name in the picker: unique, ignoring case. */
  name: string;
  panel: PanelDef;
}

/** What a button should look like right now, after dynamic state is applied. */
export interface Display {
  icon?: string;
  /**
   * The icon's scale (src/icon-scale.ts), percent of the control. Absent: a
   * built-in at `builtinIconSize`, a file at 100. 'cover': the old crop, kept
   * by drawing the image at coverScale() of its own proportions — an older
   * config's keys until the editor converts it, and Now playing's album art.
   */
  iconScale?: number | 'cover';
  /** Percent of the control a built-in icon is drawn at without the key's own scale (Defaults.builtinIconSize). */
  builtinIconSize: number;
  /** The label's font family; absent, Deckhand's default (sans-serif). */
  labelFont?: string;
  label?: string;
  labelColor: string;
  labelSize: number;
  labelPosition: 'top' | 'bottom' | 'center';
  /**
   * A live level ("40%": a volume, a brightness), when the key shows one
   * (`showLevel`). Drawn at the top of the key — the bottom, if the label is
   * at the top — in the label's style, **never in the label's place**: keys
   * sharing an icon are told apart by their labels (Ryan, 2026-10-23).
   */
  level?: string;
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
  /** Being touched on a virtual deck with Touch feedback on: drawn lighter, at 95%, inside its own shape. */
  pressed?: boolean;
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
   * Optional, for a key with states (src/state-icons.ts): whether it is in
   * its active state, when its `iconActive` is drawn. The one definition:
   * describe() draws by it, and the control socket's status reports it so the
   * editor's grid draws the same face. Cached state only — it runs on every
   * render of the key.
   */
  active?(params: ActionDef, ctx?: ActionContext): boolean;
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
