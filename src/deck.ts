import { DEFAULTS, resolvePage, startPageOf } from './config.js';
import { describeAction, isDynamic, runAction } from './actions/index.js';
import { renderButton } from './render.js';
import type {
  ActionContext,
  ActionDef,
  ButtonDef,
  DeckDef,
  DeckHandle,
  Defaults,
  Display,
  LayoutDef,
} from './types.js';

interface ControlDef {
  type: string;
  index?: number;
  pixelSize?: { width: number; height: number };
}

/**
 * Minimal surface we need from the streamdeck library. Deliberately narrow:
 * v7 describes geometry through CONTROLS, older versions through NUM_KEYS /
 * ICON_SIZE, and both are handled so a library bump can't brick the daemon.
 */
interface RawDeck {
  MODEL?: string;
  PRODUCT_NAME?: string;
  CONTROLS?: ReadonlyArray<ControlDef>;
  NUM_KEYS?: number;
  ICON_SIZE?: number;
  on(event: string, cb: (...args: unknown[]) => void): void;
  fillKeyBuffer(index: number, buffer: Buffer, options: { format: string }): Promise<void>;
  clearPanel(): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  close(): Promise<void>;
}

/** Known geometry, used only if the library doesn't report it. */
const MODEL_FALLBACK: Record<string, { keys: number; icon: number }> = {
  original: { keys: 15, icon: 72 },
  originalv2: { keys: 15, icon: 72 },
  originalmk2: { keys: 15, icon: 72 },
  mini: { keys: 6, icon: 80 },
  xl: { keys: 32, icon: 96 },
  plus: { keys: 8, icon: 120 },
  pedal: { keys: 3, icon: 0 },
  neo: { keys: 8, icon: 96 },
};

const TICK_MS = 500;

export interface DeckSessionOptions {
  serial: string;
  /** This deck's entry under "decks" — hardware settings. Empty if it has none. */
  hardware: DeckDef;
  /** What the deck shows, from one profile. */
  layout: LayoutDef;
  defaults: Defaults;
  /** Called by the profile action. Switches every deck, not just this one. */
  switchProfile: (profile: string) => Promise<void>;
}

/** Brightness is kept between 5 and 100 so a deck can never be set fully dark. */
function clampBrightness(value: number): number {
  return Math.max(5, Math.min(100, Math.round(value)));
}

export class DeckSession implements DeckHandle {
  readonly serial: string;
  readonly model: string;
  readonly keyCount: number;
  readonly iconSize: number;

  private raw: RawDeck;
  private hardware: DeckDef;
  private layout: LayoutDef;
  private defaults: Required<Defaults>;
  private switchProfile: (profile: string) => Promise<void>;
  /** ID of the page shown. */
  private page: string;
  /** Page IDs, for "back". */
  private history: string[] = [];
  private lastSent: Array<Buffer | null>;
  private lastRenderAt: number[];
  private ticker: NodeJS.Timeout | null = null;
  /** True while tick() is running, so a slow render can't start a second pass. */
  private ticking = false;
  private closed = false;
  private heldRelease = new Map<number, ActionDef>();
  /** Last level sent to this deck. Per deck, so a nudge on one never moves another. */
  private brightness: number;

  constructor(raw: RawDeck, options: DeckSessionOptions) {
    this.raw = raw;
    this.serial = options.serial;
    this.hardware = options.hardware;
    this.layout = options.layout;
    this.defaults = { ...DEFAULTS, ...options.defaults };
    this.switchProfile = options.switchProfile;

    const modelKey = String(raw.MODEL ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const fallback = MODEL_FALLBACK[modelKey] ?? { keys: 15, icon: 72 };

    this.model = raw.PRODUCT_NAME ?? (raw.MODEL ? String(raw.MODEL) : 'unknown');

    const buttons = (raw.CONTROLS ?? []).filter(
      (c) => c.type === 'button' && typeof c.index === 'number',
    );

    if (buttons.length > 0) {
      this.keyCount = Math.max(...buttons.map((c) => c.index as number)) + 1;
      const sized = buttons.find((c) => c.pixelSize && c.pixelSize.width > 0);
      this.iconSize = sized?.pixelSize?.width ?? fallback.icon;
    } else {
      this.keyCount = typeof raw.NUM_KEYS === 'number' ? raw.NUM_KEYS : fallback.keys;
      this.iconSize = typeof raw.ICON_SIZE === 'number' ? raw.ICON_SIZE : fallback.icon;
    }

    this.lastSent = new Array(this.keyCount).fill(null);
    this.lastRenderAt = new Array(this.keyCount).fill(0);
    this.page = startPageOf(this.layout);
    this.brightness = clampBrightness(this.hardware.brightness ?? this.defaults.brightness);
  }

  async start(): Promise<void> {
    this.raw.on('down', (arg: unknown) => this.onKey(arg, 'down'));
    this.raw.on('up', (arg: unknown) => this.onKey(arg, 'up'));
    this.raw.on('error', (err: unknown) => {
      console.error(`[${this.label()}] device error: ${String(err)}`);
    });

    await this.setBrightness(this.brightness);
    await this.raw.clearPanel();
    await this.renderPage(true);

    this.ticker = setInterval(() => void this.tick(), TICK_MS);
  }

  private label(): string {
    return this.hardware.name ?? `${this.model} ${this.serial.slice(-4)}`;
  }

  /**
   * Library versions differ on whether key events carry a plain index or a
   * control object. Normalise both, and ignore non-button controls such as
   * the dials on a Plus.
   */
  private keyIndexOf(arg: unknown): number | null {
    if (typeof arg === 'number') return arg;
    if (arg && typeof arg === 'object') {
      const obj = arg as { index?: number; type?: string };
      if (obj.type && obj.type !== 'button') return null;
      if (typeof obj.index === 'number') return obj.index;
    }
    return null;
  }

  private onKey(arg: unknown, edge: 'down' | 'up'): void {
    const index = this.keyIndexOf(arg);
    if (index === null || this.closed) return;

    const button = this.currentButtons()[String(index)];

    if (edge === 'down') {
      if (button?.onRelease) this.heldRelease.set(index, button.onRelease);
      if (button?.action) void this.dispatch(index, button.action);
      return;
    }

    const release = this.heldRelease.get(index);
    if (release) {
      this.heldRelease.delete(index);
      void this.dispatch(index, release);
    }
  }

  private async dispatch(index: number, action: ActionDef): Promise<void> {
    await runAction(this.context(index), action);
    // Most actions change something visible; a cheap targeted repaint beats
    // waiting up to a full tick for the button to catch up.
    void this.renderButtonAt(index, true);
  }

  private context(index: number): ActionContext {
    return {
      deck: this,
      buttonIndex: index,
      switchProfile: (profile) => this.switchProfile(profile),
      invalidateByType: (types) => this.invalidateByType(types),
      log: (message) => console.log(`[${this.label()}] ${message}`),
    };
  }

  private currentButtons(): Record<string, ButtonDef> {
    return this.layout.pages[this.page]?.buttons ?? {};
  }

  private baseDisplay(button: ButtonDef | undefined): Display {
    return {
      icon: button?.icon,
      iconFit: button?.iconFit ?? this.defaults.iconFit,
      label: button?.label,
      labelColor: button?.labelColor ?? this.defaults.labelColor,
      labelSize: button?.labelSize ?? this.defaults.labelSize,
      labelPosition: button?.labelPosition ?? this.defaults.labelPosition,
      background: button?.background ?? this.defaults.background,
    };
  }

  private async renderButtonAt(index: number, force = false): Promise<void> {
    if (this.closed) return;
    const button = this.currentButtons()[String(index)];
    const display = this.baseDisplay(button);

    const patch = await describeAction(this.context(index), button?.action);
    if (patch) Object.assign(display, patch);

    let buffer: Buffer;
    try {
      buffer = await renderButton(display, this.iconSize);
    } catch (err) {
      console.error(`[${this.label()}] render of key ${index} failed: ${(err as Error).message}`);
      return;
    }

    this.lastRenderAt[index] = Date.now();

    // renderButton caches, so identical output is the same Buffer instance.
    // Skipping the USB write keeps the deck responsive under a 2 Hz refresh.
    if (!force && this.lastSent[index] === buffer) return;

    try {
      await this.raw.fillKeyBuffer(index, buffer, { format: 'rgba' });
      this.lastSent[index] = buffer;
    } catch (err) {
      console.error(`[${this.label()}] write to key ${index} failed: ${(err as Error).message}`);
      this.lastSent[index] = null;
    }
  }

  private async renderPage(force = false): Promise<void> {
    for (let i = 0; i < this.keyCount; i++) {
      await this.renderButtonAt(i, force);
    }
  }

  /**
   * Refresh dynamic buttons that are due. The interval fires every TICK_MS
   * whether or not the previous pass finished, so a slow describe() (a hung
   * pactl call, say) would otherwise stack passes on top of each other. If a
   * pass is still running, this one is skipped; the next interval tries again.
   */
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const buttons = this.currentButtons();

      for (let i = 0; i < this.keyCount; i++) {
        const button = buttons[String(i)];
        if (!isDynamic(button?.action)) continue;
        const interval = button?.refreshMs ?? this.defaults.refreshMs;
        if (now - this.lastRenderAt[i] >= interval) {
          await this.renderButtonAt(i);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  invalidateByType(types: string[]): void {
    const buttons = this.currentButtons();
    for (let i = 0; i < this.keyCount; i++) {
      const type = buttons[String(i)]?.action?.type;
      if (type && types.includes(type)) this.lastRenderAt[i] = 0;
    }
  }

  invalidate(): void {
    this.lastRenderAt.fill(0);
    void this.renderPage(true);
  }

  currentPage(): string {
    return this.page;
  }

  /** Go to a page by ID or name. */
  async goToPage(ref: string): Promise<void> {
    const id = resolvePage(this.layout, ref);
    if (id === null) {
      console.error(`[${this.label()}] no page with ID or name "${ref}"`);
      return;
    }
    if (id === this.page) return;
    this.history.push(this.page);
    if (this.history.length > 32) this.history.shift();
    this.page = id;
    this.heldRelease.clear();
    await this.renderPage(true);
  }

  async goBack(): Promise<void> {
    const previous = this.history.pop();
    if (!previous || !this.layout.pages[previous]) return;
    this.page = previous;
    this.heldRelease.clear();
    await this.renderPage(true);
  }

  async setBrightness(value: number): Promise<void> {
    const level = clampBrightness(value);
    await this.raw.setBrightness(level);
    this.brightness = level;
  }

  currentBrightness(): number {
    return this.brightness;
  }

  /**
   * Show a different profile's layout: start page, empty back history. Used
   * when the active profile changes. Brightness is hardware and is untouched.
   */
  async setLayout(layout: LayoutDef): Promise<void> {
    this.layout = layout;
    this.page = startPageOf(layout);
    this.history = [];
    this.heldRelease.clear();
    await this.renderPage(true);
  }

  /**
   * Apply an edited config without dropping the USB connection.
   *
   * keepPage is true when the layout is the same profile's layout as before
   * (edited, not replaced): the deck stays on its page if that page still
   * exists. When it is false — the deck now shows a different profile — it
   * goes to the start page, as it would on a profile switch.
   */
  async reconfigure(
    hardware: DeckDef,
    layout: LayoutDef,
    defaults: Defaults,
    keepPage: boolean,
  ): Promise<void> {
    this.hardware = hardware;
    this.layout = layout;
    this.defaults = { ...DEFAULTS, ...defaults };
    if (!keepPage || !layout.pages[this.page]) {
      this.page = startPageOf(layout);
      this.history = [];
      this.heldRelease.clear();
    }
    await this.setBrightness(hardware.brightness ?? this.defaults.brightness);
    this.lastSent.fill(null);
    await this.renderPage(true);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    try {
      await this.raw.clearPanel();
      await this.raw.close();
    } catch {
      // device may already be gone
    }
  }
}
