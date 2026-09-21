import { DEFAULTS, resolvePage, startPageOf } from './config.js';
import { describeAction, iconStateOf, isDynamic, runAction, runActionOrThrow } from './actions/index.js';
import { builtinIconRef } from './builtin-icons.js';
import { defaultIconFor } from './default-icons.js';
import type { KeyFailure } from './control/protocol.js';
import type { KeyFailures } from './key-failures.js';
import { productNameFor, geometryOf, type DeckGeometry, type RawControl } from './geometry.js';
import { input } from './input.js';
import { parseCombo } from './keymap.js';
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

/**
 * Minimal surface we need from the streamdeck library. Deliberately narrow:
 * v7 describes geometry through CONTROLS, older versions through NUM_KEYS /
 * ICON_SIZE, and both are handled so a library bump can't brick the daemon.
 */
interface RawDeck {
  MODEL?: string;
  PRODUCT_NAME?: string;
  CONTROLS?: ReadonlyArray<RawControl>;
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
  /** Called when what the control socket's "status" shows for this deck changes: page, brightness, previews, failed keys. */
  onStateChange?: () => void;
  /** Keys whose last press failed, held for the daemon (src/key-failures.ts). */
  failures: KeyFailures;
  /** The profile this deck is showing, which the failed keys are keyed by. */
  profileOf: () => string;
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
  /** Controls and their positions, as the control socket reports them. */
  readonly geometry: DeckGeometry;

  private raw: RawDeck;
  private hardware: DeckDef;
  private layout: LayoutDef;
  private defaults: Required<Defaults>;
  private switchProfile: (profile: string) => Promise<void>;
  private onStateChange: () => void;
  private failures: KeyFailures;
  private profileOf: () => string;
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
  /**
   * Latching toggles: key index → the combo it holds
   * down. Memory only, like failure marks — a restart starts with the helper's
   * virtual keyboard new, so nothing is held.
   */
  private latched = new Map<number, string>();
  /** Unsubscribe from input's keyboard-lost notice. */
  private stopWatchingKeyboard: (() => void) | null = null;
  /** Last level sent to this deck. Per deck, so a nudge on one never moves another. */
  private brightness: number;

  constructor(raw: RawDeck, options: DeckSessionOptions) {
    this.raw = raw;
    this.serial = options.serial;
    this.hardware = options.hardware;
    this.layout = options.layout;
    this.defaults = { ...DEFAULTS, ...options.defaults };
    this.switchProfile = options.switchProfile;
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.failures = options.failures;
    this.profileOf = options.profileOf;

    const modelKey = String(raw.MODEL ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const fallback = MODEL_FALLBACK[modelKey] ?? { keys: 15, icon: 72 };

    // Through the same correction the geometry uses, so the logs and the
    // `decks` command cannot disagree about what a deck is called.
    this.model = productNameFor(raw.MODEL ? String(raw.MODEL) : '', raw.PRODUCT_NAME);
    this.geometry = geometryOf(raw);

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

    // A latched key is only latched while there is a virtual keyboard holding
    // it: if the helper dies, the state goes with it.
    this.stopWatchingKeyboard = input.onKeyboardLost(() => this.forgetLatches());

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
      // A previewed key does nothing when pressed: it shows something unsaved,
      // so neither its saved action nor the previewed one should run.
      // (A release for a press that began before the preview still runs below,
      // so a held key cannot get stuck.)
      if (this.previews.has(index)) return;
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

  /**
   * Latch or unlatch a key's combo. A second key latching a combo that
   * overlaps one already latched is refused rather than allowed to steal the
   * release: `input`'s held keys are a set, not counted, so releasing one
   * would lift the other's key while its face still said it was down. The
   * refusal fails the press, which badges the key.
   */
  async toggleLatch(index: number, combo: string): Promise<void> {
    const held = this.latched.get(index);
    if (held !== undefined) {
      this.latched.delete(index);
      try {
        await input.up(held, 'deck');
      } finally {
        this.onStateChange();
      }
      return;
    }
    const wanted = new Set(parseCombo(combo));
    for (const [other, otherCombo] of this.latched) {
      if (parseCombo(otherCombo).some((code) => wanted.has(code))) {
        throw new Error(`"${combo}" overlaps "${otherCombo}", which key ${other + 1} is holding down`);
      }
    }
    await input.down(combo, 'deck');
    this.latched.set(index, combo);
    this.onStateChange();
  }

  isLatched(index: number): boolean {
    return this.latched.has(index);
  }

  /** The keys latched down on this deck, for the control socket's status. */
  latchedKeys(): number[] {
    return [...this.latched.keys()].sort((a, b) => a - b);
  }

  /**
   * Release every latched key, because the key that would release it is about
   * to be out of reach: the page or profile changing, the config replacing the
   * key, a preview covering it, the deck going away.
   */
  private async releaseLatches(reason: string): Promise<void> {
    const held = [...this.latched.entries()];
    if (held.length === 0) return;
    this.latched.clear();
    for (const [index, combo] of held) {
      try {
        await input.up(combo, 'deck');
      } catch (err) {
        console.error(`[${this.label()}] releasing latched key ${index + 1} on ${reason} failed: ${(err as Error).message}`);
      }
    }
    this.onStateChange();
    for (const [index] of held) void this.renderButtonAt(index, true);
  }

  /**
   * After a config reload that kept the page: a latch is kept only while the
   * key still carries the same toggle. Edited, cleared, swapped with another
   * key or pointed at another combo, and the key that would release it is
   * gone.
   */
  private async releaseLatchesOnChangedKeys(): Promise<void> {
    const buttons = this.currentButtons();
    for (const [index, combo] of [...this.latched]) {
      const action = buttons[String(index)]?.action;
      if (action?.type === 'toggle' && String(action.keys ?? '') === combo) continue;
      this.latched.delete(index);
      try {
        await input.up(combo, 'deck');
      } catch (err) {
        console.error(`[${this.label()}] releasing latched key ${index + 1} on a config reload failed: ${(err as Error).message}`);
      }
      this.onStateChange();
      void this.renderButtonAt(index, true);
    }
  }

  /**
   * The helper died and took the virtual keyboard with it, so nothing is held
   * any more: drop the latches rather than draw keys as down. No `up` is sent
   * — there is nothing to send it to.
   */
  private forgetLatches(): void {
    if (this.latched.size === 0) return;
    const keys = [...this.latched.keys()];
    this.latched.clear();
    console.error(`[${this.label()}] the virtual keyboard went away; ${keys.length} latched key(s) are no longer held`);
    this.onStateChange();
    for (const index of keys) void this.renderButtonAt(index, true);
  }

  /**
   * Fire every release a held key is still waiting for, instead of dropping
   * it. The page, the profile or the config changing under a finger used to
   * *discard* these (`heldRelease.clear()`), which left the combo down at the
   * evdev layer with no key left to release it — the stuck key the control
   * socket goes to lengths to rule out (docs/scope.md §7, M3). Found by
   * reading, 2026-09-20, before the latching toggle it also applies to.
   *
   * Failures are logged, not marked on the key: by the time this runs the key
   * may be on a page that is no longer shown, and a mark there would be
   * invisible and unclearable.
   */
  private async fireHeldReleases(reason: string): Promise<void> {
    const pending = [...this.heldRelease.entries()];
    this.heldRelease.clear();
    for (const [index, action] of pending) {
      try {
        await runActionOrThrow(this.context(index), action);
      } catch (err) {
        console.error(`[${this.label()}] releasing key ${index + 1} on ${reason} failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Run an action sent over the control socket, on this deck. Unlike a key
   * press, a failure propagates to the caller, and any key it holds down is
   * recorded as held by the socket. It belongs to no key, so no key repaints.
   */
  async runFromSocket(action: ActionDef): Promise<void> {
    if (this.closed) throw new Error('the deck has disconnected');
    await runActionOrThrow(this.context(-1, 'socket'), action);
  }

  /**
   * Run a key's action (its press, or its release). A failure marks the key and
   * a success clears its mark — keyed by the page and profile
   * it was pressed on, read before running, since a page or profile action
   * moves the deck. The repaint after every press, which was already here,
   * draws or removes the badge: no extra write, no timer.
   */
  private async dispatch(index: number, action: ActionDef): Promise<void> {
    const profile = this.profileOf();
    const page = this.page;
    const button = this.currentButtons()[String(index)];
    const failure = await runAction(this.context(index), action);
    const changed =
      failure === null
        ? this.failures.clear(this.serial, profile, page, index)
        : this.failures.mark(this.serial, { profile, page, key: index, error: failure }, button);
    if (changed) this.onStateChange();
    // Most actions change something visible; a cheap targeted repaint beats
    // waiting up to a full tick for the button to catch up.
    void this.renderButtonAt(index, true);
  }

  /** This deck's failed keys, on every page and profile, for the control socket's status. */
  failedKeys(): KeyFailure[] {
    return this.failures.forDeck(this.serial);
  }

  private context(index: number, source: ActionContext['source'] = 'deck'): ActionContext {
    return {
      deck: this,
      buttonIndex: index,
      source,
      switchProfile: (profile) => this.switchProfile(profile),
      invalidateByType: (types) => this.invalidateByType(types),
      log: (message) => console.log(`[${this.label()}] ${message}`),
    };
  }

  private currentButtons(): Record<string, ButtonDef> {
    return this.layout.pages[this.page]?.buttons ?? {};
  }

  /** What a key shows: its preview if it has one, otherwise the current page's button. */
  private buttonAt(index: number): ButtonDef | undefined {
    return this.previews.get(index) ?? this.currentButtons()[String(index)];
  }

  private baseDisplay(button: ButtonDef | undefined): Display {
    return {
      // null (deliberately no icon) and absent both start with no icon layer
      // here; drawKey() gives an absent one the action's default.
      icon: button?.icon ?? undefined,
      iconFit: button?.iconFit ?? this.defaults.iconFit,
      label: button?.label,
      labelColor: button?.labelColor ?? this.defaults.labelColor,
      labelSize: button?.labelSize ?? this.defaults.labelSize,
      labelPosition: button?.labelPosition ?? this.defaults.labelPosition,
      background: button?.background ?? this.defaults.background,
    };
  }

  private async renderButtonAt(index: number, force = false): Promise<void> {
    try {
      await this.drawKey(index, force, false);
    } catch (err) {
      console.error(`[${this.label()}] render of key ${index} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Render one key and write it to the deck. A render failure throws (the
   * caller decides whether to log it or report it); a USB write failure is
   * logged here, as before. strictIcon: see renderButton().
   */
  private async drawKey(index: number, force: boolean, strictIcon: boolean): Promise<void> {
    if (this.closed) return;
    const button = this.buttonAt(index);
    const display = this.baseDisplay(button);

    const patch = await describeAction(this.context(index), button?.action);
    if (patch) Object.assign(display, patch);
    // Not on a preview: it shows something unsaved, which has never been pressed.
    if (!this.previews.has(index) && this.failures.has(this.serial, this.profileOf(), this.page, index)) display.failed = true;

    // The action's built-in default, in this order: an icon
    // the action chose (iconMuted, album art) wins, then the key's own icon;
    // `icon: null` means deliberately none, so only an *absent* icon gets a
    // default; and a key with no action gets none — it stays blank.
    if (button?.action && button.icon === undefined && display.icon === undefined) {
      const name = defaultIconFor(button.action, iconStateOf(button.action, this.context(index)));
      if (name) display.icon = builtinIconRef(name);
    }

    const buffer = await renderButton(display, this.iconSize, strictIcon);

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

      for (let i = 0; i < this.keyCount; i++) {
        const button = this.buttonAt(i);
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
    for (let i = 0; i < this.keyCount; i++) {
      const type = this.buttonAt(i)?.action?.type;
      if (type && types.includes(type)) this.lastRenderAt[i] = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Previews: an unsaved button shown on a key
  // -------------------------------------------------------------------------

  /** Keys showing a preview, by index. Survives page changes, profile switches and reloads. */
  private previews = new Map<number, ButtonDef>();
  /** One preview render per key at a time, plus at most one follow-up. */
  private previewRenders = new Map<number, { running: Promise<void>; followUp: Promise<void> | null }>();

  /** True if `index` is one of this deck's keys. */
  hasKey(index: number): boolean {
    return this.geometry.keys.some((key) => key.index === index);
  }

  previewKeys(): number[] {
    return [...this.previews.keys()].sort((a, b) => a - b);
  }

  /**
   * Show `button` on a key without saving it. Resolves once it is drawn;
   * rejects if it cannot be drawn (e.g. an unreadable icon), in which case the
   * preview is removed again and the key goes back to what it showed.
   */
  async setPreview(index: number, button: ButtonDef): Promise<void> {
    // A previewed key does nothing when pressed (onKey), so a latch under one
    // could not be released by pressing it.
    if (this.latched.has(index)) await this.releaseLatches('a preview on the key');
    this.previews.set(index, button);
    this.onStateChange();
    try {
      await this.renderPreviewKey(index);
    } catch (err) {
      // Only undo this request's own preview: a newer one may have replaced it.
      if (this.previews.get(index) === button) {
        this.previews.delete(index);
        this.onStateChange();
        await this.renderButtonAt(index, true);
      }
      throw err;
    }
  }

  /** Remove previews — one key, or all — and redraw those keys. Returns the keys cleared. */
  async clearPreview(index?: number): Promise<number[]> {
    const cleared = index === undefined ? this.previewKeys() : this.previews.has(index) ? [index] : [];
    for (const key of cleared) this.previews.delete(key);
    if (cleared.length > 0) this.onStateChange();
    await Promise.all(cleared.map((key) => this.renderButtonAt(key, true)));
    return cleared;
  }

  /**
   * Draw a previewed key strictly (errors surface). A burst of previews on one
   * key renders only the latest: requests that arrive while a render runs
   * share one follow-up render of whatever the key holds by then.
   */
  private renderPreviewKey(index: number): Promise<void> {
    const ignore = () => undefined;
    const current = this.previewRenders.get(index);
    if (current) {
      current.followUp ??= current.running.then(ignore, ignore).then(() => {
        this.previewRenders.delete(index);
        return this.renderPreviewKey(index);
      });
      return current.followUp;
    }
    const entry = { running: this.drawKey(index, true, true), followUp: null as Promise<void> | null };
    this.previewRenders.set(index, entry);
    void entry.running.then(ignore, ignore).then(() => {
      if (this.previewRenders.get(index) === entry && entry.followUp === null) this.previewRenders.delete(index);
    });
    return entry.running;
  }

  private repaintRunning: Promise<void> | null = null;
  private repaintFollowUp: Promise<void> | null = null;

  /**
   * Repaint every key, resolving when done. Requests that arrive while a
   * repaint is running share one follow-up repaint, however many there are,
   * so a burst of requests cannot pile renders and USB writes up.
   */
  repaint(): Promise<void> {
    if (this.repaintFollowUp) return this.repaintFollowUp;
    if (this.repaintRunning) {
      this.repaintFollowUp = this.repaintRunning.then(() => {
        this.repaintFollowUp = null;
        return this.repaint();
      });
      return this.repaintFollowUp;
    }
    this.repaintRunning = (async () => {
      try {
        this.lastRenderAt.fill(0);
        await this.renderPage(true);
      } finally {
        this.repaintRunning = null;
      }
    })();
    return this.repaintRunning;
  }

  currentPage(): string {
    return this.page;
  }

  hasPage(ref: string): boolean {
    return resolvePage(this.layout, ref) !== null;
  }

  /** Go to a page by ID or name. */
  async goToPage(ref: string): Promise<void> {
    const id = resolvePage(this.layout, ref);
    if (id === null) {
      console.error(`[${this.label()}] no page with ID or name "${ref}"`);
      return;
    }
    if (id === this.page) return;
    // Before the page moves: a key held on the page being left still has its
    // release, and this is the last moment it can run.
    await this.fireHeldReleases('a page change');
    await this.releaseLatches('a page change');
    this.history.push(this.page);
    if (this.history.length > 32) this.history.shift();
    this.page = id;
    this.onStateChange();
    await this.renderPage(true);
  }

  async goBack(): Promise<void> {
    const previous = this.history.pop();
    if (!previous || !this.layout.pages[previous]) return;
    await this.fireHeldReleases('a page change');
    await this.releaseLatches('a page change');
    this.page = previous;
    this.onStateChange();
    await this.renderPage(true);
  }

  async setBrightness(value: number): Promise<void> {
    const level = clampBrightness(value);
    await this.raw.setBrightness(level);
    this.brightness = level;
    this.onStateChange();
  }

  currentBrightness(): number {
    return this.brightness;
  }

  /**
   * Show a different profile's layout: start page, empty back history. Used
   * when the active profile changes. Brightness is hardware and is untouched.
   */
  async setLayout(layout: LayoutDef): Promise<void> {
    await this.fireHeldReleases('a profile switch');
    await this.releaseLatches('a profile switch');
    this.layout = layout;
    this.page = startPageOf(layout);
    this.history = [];
    this.onStateChange();
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
      await this.fireHeldReleases('a config reload');
      await this.releaseLatches('a config reload');
      this.page = startPageOf(layout);
      this.history = [];
      this.onStateChange();
    } else {
      await this.releaseLatchesOnChangedKeys();
    }
    await this.setBrightness(hardware.brightness ?? this.defaults.brightness);
    this.lastSent.fill(null);
    await this.renderPage(true);
  }

  async close(): Promise<void> {
    // Before the flag: a key still held by this deck is released rather than
    // left down when the deck goes (unplugged, or the daemon shutting down).
    await this.fireHeldReleases('the deck closing');
    await this.releaseLatches('the deck closing');
    this.stopWatchingKeyboard?.();
    this.stopWatchingKeyboard = null;
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
