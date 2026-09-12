export interface ActionDef {
  type: string;
  [param: string]: unknown;
}

export interface ButtonDef {
  /** Absolute path (or ~/...) to any image file. Resized to fit automatically. */
  icon?: string;
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

export interface PageDef {
  /** Button index (as a string) -> definition. Index 0 is top-left. */
  buttons: Record<string, ButtonDef>;
}

export interface DeckDef {
  /** Friendly name, only used in logs. */
  name?: string;
  /** 0-100. */
  brightness?: number;
  startPage?: string;
  pages: Record<string, PageDef>;
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
  decks: Record<string, DeckDef>;
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
}

/** Partial display override returned by an action's describe(). */
export type DisplayPatch = Partial<Display>;

export interface DeckHandle {
  serial: string;
  model: string;
  keyCount: number;
  iconSize: number;
  /** Switch to a named page on this deck. */
  goToPage(page: string): Promise<void>;
  /** Return to the previously shown page. */
  goBack(): Promise<void>;
  setBrightness(value: number): Promise<void>;
  /** Force a re-render of every button on the current page. */
  invalidate(): void;
  currentPage(): string;
}

export interface ActionContext {
  deck: DeckHandle;
  buttonIndex: number;
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
}
