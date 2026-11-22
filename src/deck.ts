import { sleep } from './sleep.js';
import { DEFAULTS, resolvePage, startPageOf } from './config.js';
import type { ResolvedDefaults } from './config-common.js';
import { activeOf, attempt, attemptValue, defaultIconFileOf, describeAction, hasRelease, iconStateOf, isDynamic, runActionOrThrow, runRelease, valueOf, type ActionFailure } from './actions/index.js';
import { anglesOf, angleAround, alongAxis, clamp01, fractionOf, takesValue, travelLength, turnBetween, valueAtPoint, valueOfFraction } from './value-controls.js';
import { composeValue, valueArt, type ValueArt } from './value-face.js';
import { builtinIconRef } from './builtin-icons.js';
import { defaultIconFor } from './default-icons.js';
import type { KeyFailure, LiveFace } from './control/protocol.js';
import type { KeyFailures } from './key-failures.js';
import type { DeckDevice, TouchState } from './devices.js';
import type { DeckGeometry, KeyPosition } from './geometry.js';
import { input } from './input.js';
import { parseCombo } from './keymap.js';
import { fillScreen, renderButton, renderFace } from './render.js';
import { hasStates } from './state-icons.js';
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
  /**
   * A key was newly marked with a failure whose message tells the person what
   * to do (src/action-error.ts) — not again while the same message stands.
   * The daemon shows it as a desktop notification, unless turned off.
   */
  onActionNeeded?: (failure: { slot: string; key: string; keyName: string; label: string | undefined; message: string; notSetUp?: boolean }) => void;
  /** Keys whose last press failed, held for the daemon (src/key-failures.ts). */
  failures: KeyFailures;
  /** The profile this deck is showing, which the failed keys are keyed by. */
  profileOf: () => string;
  /** The page to start on instead of the layout's start page, if the layout has it: a virtual deck turned back on. */
  page?: string;
  /** A key's failure mark was cleared (a press that worked, the editor's Clear): its next failure notifies as a first one. */
  onFailureCleared?: (slot: string) => void;
}

/**
 * A finger on a slider or dial (src/value-controls.ts): where it was last, the
 * value it has put the control at (0–1), and on a dial the finger's last
 * angle round the centre.
 */
interface ValueDrag {
  last: { x: number; y: number };
  value: number;
  angle: number;
  /** Whether it has written anything yet: a tap that moved nothing writes nothing. */
  wrote: boolean;
}

/**
 * A slider's or dial's writes: **one at a time**, the newest value waiting for
 * the one in flight — so however fast a finger moves, the service sees at most
 * one change outstanding, and never a queue. No timer: the next write starts
 * when the last one ends.
 */
interface ValueWrites {
  inFlight: boolean;
  next: { value: number; final: boolean } | null;
  /** Set when a write fails: the drag writes nothing more, and its face goes back to the real value. */
  stopped: boolean;
}

/** Brightness is kept between 5 and 100 so a deck can never be set fully dark. */
function clampBrightness(value: number): number {
  return Math.max(5, Math.min(100, Math.round(value)));
}

export class DeckSession implements DeckHandle {
  readonly serial: string;
  readonly model: string;
  keyCount: number;
  /** The first screen's width, for logs; null on a deck with no screens. Each key's own size is in `screens`. */
  iconSize: number | null;
  /** Controls and their positions, as the control socket reports them. A virtual deck's change with its layout (useGeometry). */
  geometry: DeckGeometry;

  private device: DeckDevice;
  /** Each control's place in reading order, for "key 5" in logs and messages, and for sorting. */
  private order: Map<string, number>;
  private hardware: DeckDef;
  private layout: LayoutDef;
  private defaults: ResolvedDefaults;
  private switchProfile: (profile: string) => Promise<void>;
  private onStateChange: () => void;
  private onActionNeeded: NonNullable<DeckSessionOptions['onActionNeeded']>;
  private onFailureCleared: NonNullable<DeckSessionOptions['onFailureCleared']>;
  private failures: KeyFailures;
  private profileOf: () => string;
  /** ID of the page shown. */
  private page: string;
  /** Page IDs, for "back". */
  private history: string[] = [];
  /**
   * The keys that have a screen, and its size: the only keys ever drawn.
   * A key without one (a Neo's touch keys, every Pedal key) is pressed but
   * never written to — the library refuses an image for it.
   */
  /** Each key's screen; on a virtual deck, its control's shape too (src/shapes.ts), which drawKey cuts the face to. */
  private screens = new Map<string, { width: number; height: number; shape?: string; radius?: number }>();
  private lastSent = new Map<string, Buffer>();
  private lastRenderAt = new Map<string, number>();
  /** Keys told their face may have changed (invalidateByType), drawn on the next tick whatever their kind. */
  private stale = new Set<string>();
  private ticker: NodeJS.Timeout | null = null;
  /** True while tick() is running, so a slow render can't start a second pass. */
  private ticking = false;
  private closed = false;
  private heldRelease = new Map<string, ActionDef>();
  /**
   * Keys down whose action acts on its release (ActionHandler.release), and
   * when they went down: how long a key was held is two timestamps, not a
   * timer. Dropped on every way off the page (fireHeldReleases) — a hold
   * holds nothing at the evdev layer, so dropping it leaves nothing down.
   */
  private holds = new Map<string, { at: number; action: ActionDef }>();
  /**
   * Latching toggles: key → the combo it holds
   * down. Memory only, like failure marks — a restart starts with the helper's
   * virtual keyboard new, so nothing is held.
   */
  private latched = new Map<string, string>();
  /**
   * Each shown key with states, as last drawn (liveFaces()): drawn in another
   * state, the editor is told, so its grid follows the deck. Set by a redraw
   * the key already had coming — no timer, nothing more at rest.
   */
  private drawnFaces = new Map<string, string>();
  /**
   * Controls a finger is on, drawn pressed (Touch feedback, render.ts
   * pressedLook): a virtual deck's only, while `defaults.touchFeedback` is
   * not false. Drawn on the touch and on its lift — nothing on a clock.
   */
  private pressed = new Set<string>();
  /** The sliders and dials on the deck, by id: their box, kind, direction and touch. */
  private valueKeys = new Map<string, KeyPosition>();
  /** A finger on each slider or dial being moved (ValueDrag). */
  private drags = new Map<string, ValueDrag>();
  /** Each slider's or dial's writes (ValueWrites). */
  private writes = new Map<string, ValueWrites>();
  /**
   * The value a slider or dial shows instead of its action's cache: while a
   * finger is on it, and after, until its last write has landed — so the face
   * never jumps back to a cache that has not caught up yet.
   */
  private shownValue = new Map<string, number>();
  /** Each slider's or dial's art for its last face, for its travel when a finger moves it. */
  private valueArts = new Map<string, ValueArt>();
  /** Each slider's or dial's value as the control socket last reported it (whole percent of its range). */
  private reportedValues = new Map<string, number>();
  /** Unsubscribe from input's keyboard-lost notice. */
  private stopWatchingKeyboard: (() => void) | null = null;
  /** Last level sent to this deck. Per deck, so a nudge on one never moves another. */
  private brightness: number;
  /** What src/sleep.ts has it showing instead of its brightness; null when awake. */
  private sleepLevel: number | null = null;

  constructor(device: DeckDevice, options: DeckSessionOptions) {
    this.device = device;
    this.serial = options.serial;
    this.hardware = options.hardware;
    this.layout = options.layout;
    this.defaults = { ...DEFAULTS, ...options.defaults };
    this.switchProfile = options.switchProfile;
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.onActionNeeded = options.onActionNeeded ?? (() => undefined);
    this.onFailureCleared = options.onFailureCleared ?? (() => undefined);
    this.failures = options.failures;
    this.profileOf = options.profileOf;

    // The geometry's name, so the logs and the `decks` command cannot
    // disagree about what a deck is called.
    this.geometry = device.geometry;
    this.model = this.geometry.productName;
    this.order = new Map();
    this.keyCount = 0;
    this.iconSize = null;
    this.page = options.page !== undefined && this.layout.pages[options.page] ? options.page : startPageOf(this.layout);
    this.useGeometry(device.layoutFrom?.(this.layout, this.page) ?? device.geometry);
    this.brightness = clampBrightness(this.ownBrightness(this.hardware));
  }

  async start(): Promise<void> {
    this.device.onInput((event) => {
      if (this.valueKeys.has(event.control)) this.onValue(event.control, event.edge, event.at);
      else if (event.edge !== 'move') this.onKey(event.control, event.edge);
    });
    this.device.onRedraw?.(() => void this.repaint());
    this.device.onLetGo?.((reason) => void this.letGo(reason));
    this.device.onError((err: unknown) => {
      console.error(`[${this.label()}] device error: ${String(err)}`);
    });

    // A latched key is only latched while there is a virtual keyboard holding
    // it: if the helper dies, the state goes with it.
    this.stopWatchingKeyboard = input.onKeyboardLost(() => this.forgetLatches());

    // A deck plugged in while the others sleep starts asleep.
    sleep.add(this);
    this.sleepLevel = sleep.levelFor(this);
    await this.setBrightness(this.brightness);
    await this.device.clear?.();
    await this.renderPage(true);

    this.ticker = setInterval(() => void this.tick(), TICK_MS);
  }

  private label(): string {
    return this.hardware.name ?? `${this.model} ${this.serial.slice(-4)}`;
  }

  /**
   * Take a set of controls: the device's own, or — for a virtual deck — the
   * ones its layout gives it. Anything kept per key for a control that is no
   * longer there goes; a preview on a control that stays is kept.
   */
  private useGeometry(geometry: DeckGeometry): void {
    this.geometry = geometry;
    this.keyCount = geometry.keyCount;
    this.iconSize = geometry.iconSize;
    this.order = new Map(geometry.keys.map((key, i) => [key.id, i]));
    this.screens = new Map(
      geometry.keys.flatMap((key) =>
        key.width && key.height ? [[key.id, geometry.units === 'pixels' ? { width: key.width, height: key.height, shape: key.shape, radius: key.radius } : { width: key.width, height: key.height }] as const] : [],
      ),
    );
    for (const id of [...this.previews.keys()]) if (!this.order.has(id)) this.previews.delete(id);
    for (const id of [...this.pressed]) if (!this.order.has(id)) this.pressed.delete(id);
    this.valueKeys = new Map(geometry.keys.filter((k) => k.kind === 'slider' || k.kind === 'dial').map((k) => [k.id, k]));
    this.valueArts.clear();
    this.reportedValues.clear();
    this.lastSent.clear();
    this.lastRenderAt.clear();
    this.stale.clear();
    this.device.showGeometry?.(geometry);
  }

  /**
   * The controls a page would have: a virtual deck's page's own panel
   * (src/devices.ts layoutFrom), or null for a device whose controls are its
   * own.
   */
  private geometryOf(layout: LayoutDef, page: string): DeckGeometry | null {
    return this.device.layoutFrom ? this.device.layoutFrom(layout, page) : null;
  }

  /**
   * Take a page's controls, **only when they differ from those shown**: a new
   * set clears the screen (the helper's canvas frame) before every key is
   * drawn, so two pages with the same grid switch as they always have. Call
   * with what was held already let go. Returns whether it changed.
   */
  private relayoutFor(layout: LayoutDef, page: string): boolean {
    const next = this.geometryOf(layout, page);
    if (!next || sameControls(next, this.geometry)) return false;
    this.useGeometry(next);
    return true;
  }

  /** "key 5": a key as people count them, in reading order from 1. */
  keyName(key: string): string {
    const at = this.order.get(key);
    return at === undefined ? `key "${key}"` : `key ${at + 1}`;
  }

  /** Keys in reading order, for the lists the control socket reports. */
  private sorted(keys: Iterable<string>): string[] {
    const at = (key: string) => this.order.get(key) ?? Number.MAX_SAFE_INTEGER;
    return [...keys].sort((a, b) => at(a) - at(b) || a.localeCompare(b));
  }

  private onKey(index: string, edge: 'down' | 'up'): void {
    if (this.closed || !this.order.has(index)) return;

    const button = this.currentButtons()[index];

    if (edge === 'down') {
      const woke = sleep.press(this);
      // Sleep all decks' own key, pressed while dimmed, has done its job by waking them.
      // Returning before anything is armed is what swallows the release too.
      if (woke === 'swallow' || (woke === 'woke' && button?.action?.type === 'sleep.all')) return;
      // Touch feedback: the control drawn pressed while the finger is on it, whatever it does.
      if (this.touchFeedback()) {
        this.pressed.add(index);
        void this.renderButtonAt(index);
      }
      // A previewed key does nothing when pressed: it shows something unsaved,
      // so neither its saved action nor the previewed one should run.
      // (A release for a press that began before the preview still runs below,
      // so a held key cannot get stuck.)
      if (this.previews.has(index)) return;
      if (button?.onRelease) this.heldRelease.set(index, button.onRelease);
      if (button?.action && hasRelease(button.action)) this.holds.set(index, { at: Date.now(), action: button.action });
      if (button?.action) void this.dispatch(index, button.action);
      return;
    }

    if (this.pressed.delete(index)) void this.renderButtonAt(index);

    const hold = this.holds.get(index);
    if (hold) {
      this.holds.delete(index);
      const heldMs = Date.now() - hold.at;
      void this.settleRelease(index, hold.action, heldMs);
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
  async toggleLatch(index: string, combo: string): Promise<void> {
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
        throw new Error(`"${combo}" overlaps "${otherCombo}", which ${this.keyName(other)} is holding down`);
      }
    }
    await input.down(combo, 'deck');
    this.latched.set(index, combo);
    this.onStateChange();
  }

  isLatched(index: string | null): boolean {
    return index !== null && this.latched.has(index);
  }

  /** The keys latched down on this deck, for the control socket's status. */
  latchedKeys(): string[] {
    return this.sorted(this.latched.keys());
  }

  /**
   * The keys with states on the page shown, and the state each is in now —
   * its built-in's and whether its active icon applies — for the control
   * socket's status, so the editor's grid draws the face the deck draws.
   * Cached state only, as a render reads it.
   */
  liveFaces(): Record<string, LiveFace> {
    const faces: Record<string, LiveFace> = {};
    for (const index of this.sorted(this.screens.keys())) {
      const face = this.liveFaceAt(index);
      if (face) faces[index] = face;
    }
    return faces;
  }

  private liveFaceAt(index: string): LiveFace | null {
    const action = this.buttonAt(index)?.action;
    if (!action || !hasStates(action)) return null;
    const ctx = this.context(index);
    return { state: iconStateOf(action, ctx), active: activeOf(action, ctx) };
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
        console.error(`[${this.label()}] releasing latched ${this.keyName(index)} on ${reason} failed: ${(err as Error).message}`);
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
      const action = buttons[index]?.action;
      if (action?.type === 'toggle' && String(action.keys ?? '') === combo) continue;
      this.latched.delete(index);
      try {
        await input.up(combo, 'deck');
      } catch (err) {
        console.error(`[${this.label()}] releasing latched ${this.keyName(index)} on a config reload failed: ${(err as Error).message}`);
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
   * it. When the page, the profile or the config changes under a finger, a
   * dropped release would leave the combo down at the evdev layer with no key
   * left to release it — the stuck key the control socket also goes to
   * lengths to rule out.
   *
   * Failures are logged, not marked on the key: by the time this runs the key
   * may be on a page that is no longer shown, and a mark there would be
   * invisible and unclearable.
   */
  private async fireHeldReleases(reason: string): Promise<void> {
    this.holds.clear();
    const pending = [...this.heldRelease.entries()];
    this.heldRelease.clear();
    for (const [index, action] of pending) {
      try {
        await runActionOrThrow(this.context(index), action);
      } catch (err) {
        console.error(`[${this.label()}] releasing ${this.keyName(index)} on ${reason} failed: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sliders and dials (src/value-controls.ts)
  // -------------------------------------------------------------------------

  /**
   * A finger on a slider or dial: down, moving, or lifted. The rules a key's
   * press has hold here too — a touch that only wakes the deck does nothing, a
   * previewed control does nothing — and **every way off the page ends a
   * drag with the value left where it is** (endDrags).
   */
  private onValue(index: string, edge: 'down' | 'up' | 'move', at: { x: number; y: number } | undefined): void {
    if (this.closed || !this.order.has(index)) return;
    const key = this.valueKeys.get(index)!;
    if (edge === 'down') {
      const woke = sleep.press(this);
      if (woke === 'swallow') return;
      const action = this.currentButtons()[index]?.action;
      if (this.previews.has(index) || !action || !valueOf(action) || !at) return;
      const value = this.valueFraction(index, action) ?? 0;
      const drag: ValueDrag = { last: at, value, angle: angleAround(at, this.artBox(index, key)), wrote: false };
      this.drags.set(index, drag);
      // A write of the last drag still in flight is this drag's too: one at a time, whichever drag it came from.
      const writes = this.writes.get(index) ?? { inFlight: false, next: null, stopped: false };
      writes.next = null;
      writes.stopped = false;
      this.writes.set(index, writes);
      this.shownValue.set(index, value);
      // Jump to touch: the level goes to the finger at once.
      if (key.kind === 'slider' && key.touch === 'jump') this.moveTo(index, drag, valueAtPoint(at, this.artBox(index, key), key.direction, this.travelOf(index, key)));
      void this.drawValue(index, true);
      return;
    }
    const drag = this.drags.get(index);
    if (!drag) return;
    if (edge === 'move' && at) {
      let next = drag.value;
      if (key.kind === 'dial') {
        const box = this.artBox(index, key);
        const angle = angleAround(at, box);
        const angles = anglesOf(this.currentButtons()[index]);
        // The knob follows the finger's turn round the centre, not its distance: a tap moves nothing.
        next = drag.value + turnBetween(drag.angle, angle) / (angles.end - angles.start);
        drag.angle = angle;
      } else if (key.touch === 'jump') {
        next = valueAtPoint(at, this.artBox(index, key), key.direction, this.travelOf(index, key));
      } else {
        const box = this.artBox(index, key);
        next = drag.value + (alongAxis(at, box, key.direction) - alongAxis(drag.last, box, key.direction)) / travelLength(this.travelOf(index, key));
      }
      drag.last = at;
      this.moveTo(index, drag, next);
      return;
    }
    if (edge === 'up') {
      this.drags.delete(index);
      // The last write of a drag is final: a service that skipped re-reading while it moved re-reads now.
      if (drag.wrote) this.queueWrite(index, drag.value, true);
      else this.settleValue(index);
      void this.drawValue(index, true);
    }
  }

  /** A drag's new value: drawn at once, and written — the newest replacing any not yet started. */
  private moveTo(index: string, drag: ValueDrag, value: number): void {
    const next = clamp01(value);
    const action = this.currentButtons()[index]?.action;
    const handler = valueOf(action);
    if (!action || !handler) return;
    // Only a change the action's units can show: a step smaller than one unit writes nothing
    // (the fraction still moves, so small steps add up to a write).
    const range = handler.range(action);
    const changed = valueOfFraction(next, range) !== valueOfFraction(drag.value, range);
    drag.value = next;
    // A drag whose write failed shows the real value, not the finger: nothing it does is written.
    if (this.writes.get(index)?.stopped) return;
    this.shownValue.set(index, next);
    void this.drawValue(index, true);
    if (changed) {
      drag.wrote = true;
      this.queueWrite(index, next, false);
    }
  }

  private queueWrite(index: string, value: number, final: boolean): void {
    const writes = this.writes.get(index);
    if (!writes || writes.stopped) return this.settleValue(index);
    writes.next = { value, final };
    void this.pumpWrites(index, writes);
  }

  /** Start the waiting write if none is in flight; when the last has landed, the face goes back to the action's own value. */
  private async pumpWrites(index: string, writes: ValueWrites): Promise<void> {
    if (writes.inFlight || !writes.next) return;
    const { value, final } = writes.next;
    writes.next = null;
    writes.inFlight = true;
    const profile = this.profileOf();
    const page = this.page;
    const button = this.currentButtons()[index];
    const action = button?.action;
    const handler = valueOf(action);
    let failure: ActionFailure | null = null;
    if (action && handler) failure = await attemptValue(this.context(index), action, valueOfFraction(value, handler.range(action)), final);
    writes.inFlight = false;
    if (this.writes.get(index) !== writes) return; // ended meanwhile (endDrags): nothing more for this drag
    if (failure) {
      // One failure per drag: the rest of it writes nothing, and the face shows the real value.
      writes.stopped = true;
      writes.next = null;
      this.shownValue.delete(index);
      void this.drawValue(index, true);
    }
    this.judgeValue(index, profile, page, button, failure);
    if (writes.next) return void this.pumpWrites(index, writes);
    if (!this.drags.has(index)) this.settleValue(index);
  }

  /** A slider's or dial's write judged as a press is: a failure marks it (and notifies if it says what to do), success clears a mark. */
  private judgeValue(index: string, profile: string, page: string, button: ButtonDef | undefined, failure: ActionFailure | null): void {
    const slot = this.slotOf(profile, page, index);
    if (failure?.notSetUp) {
      this.onActionNeeded({ slot, key: index, keyName: this.keyName(index), label: button?.label, message: failure.message, notSetUp: true });
      return;
    }
    const cleared = failure === null && this.failures.clear(this.serial, profile, page, index);
    const changed = cleared || (failure !== null && this.failures.mark(this.serial, { profile, page, key: index, error: failure.message }, button));
    if (changed) this.onStateChange();
    if (cleared) this.onFailureCleared(slot);
    if (failure?.actionNeeded) this.onActionNeeded({ slot, key: index, keyName: this.keyName(index), label: button?.label, message: failure.message });
    if (changed) void this.drawValue(index, true);
  }

  /** No finger and no write left: the face follows the action's own value again. */
  private settleValue(index: string): void {
    if (this.drags.has(index)) return;
    const writes = this.writes.get(index);
    if (writes?.inFlight || writes?.next) return;
    this.writes.delete(index);
    this.shownValue.delete(index);
    void this.drawValue(index, true);
  }

  /**
   * Every finger off every slider and dial, at once: a lock, a page or panel
   * change, the deck closing. **The value is left where it is**: what has been
   * written stays, a write not started is dropped, and the face goes back to
   * the action's own value once the one in flight lands.
   */
  private endDrags(): void {
    if (this.drags.size === 0 && this.writes.size === 0) return;
    const was = [...new Set([...this.drags.keys(), ...this.writes.keys()])];
    this.drags.clear();
    for (const index of was) {
      const writes = this.writes.get(index);
      this.writes.delete(index);
      this.shownValue.delete(index);
      if (writes) writes.next = null;
      if (this.screens.has(index) && this.valueKeys.has(index)) void this.drawValue(index, true);
    }
  }

  /** The control's value now, 0–1: where a finger has put it, else its action's cache; null when not known. */
  private valueFraction(index: string, action: ActionDef | undefined): number | null {
    const shown = this.shownValue.get(index);
    if (shown !== undefined) return shown;
    const handler = valueOf(action);
    if (!action || !handler) return null;
    const value = handler.read(action, this.context(index));
    return value === null ? null : fractionOf(value, handler.range(action));
  }

  /** The art's area of a slider or dial: its box less the label's band, from its last drawn art; the box until it has one. */
  private artBox(index: string, key: KeyPosition): { w: number; h: number } {
    const art = this.valueArts.get(index);
    return art ? { w: art.width, h: art.artH } : { w: key.width ?? key.w, h: key.height ?? key.h };
  }

  private travelOf(index: string, key: KeyPosition) {
    const art = this.valueArts.get(index);
    const box = this.artBox(index, key);
    return art?.travel ?? { start: 0, end: key.direction === 'horizontal' ? box.w : box.h, thumb: 0 };
  }

  /**
   * Draw a slider or dial: its art (drawn once per change of art, label or
   * badge), put together at its value (value-face.ts). While a finger drags
   * it, this is all a step costs: no describe(), no icon lookup.
   */
  private async drawValue(index: string, force: boolean): Promise<void> {
    if (this.closed) return;
    const key = this.valueKeys.get(index);
    const screen = this.screens.get(index);
    if (!key || !screen) return;
    this.stale.delete(index);
    const page = this.page;
    const button = this.buttonAt(index);
    const action = button?.action && takesValue(button.action.type) ? button.action : undefined;
    const patch = action ? await describeAction(this.context(index), action) : null;
    const display = this.baseDisplay(button);
    let art: ValueArt;
    try {
      art = await valueArt({
        kind: key.kind!,
        width: screen.width,
        height: screen.height,
        shape: screen.shape,
        radius: screen.radius,
        ...(key.direction ? { direction: key.direction } : {}),
        angles: anglesOf(button),
        ...(button?.layers ? { layers: button.layers } : {}),
        ...(action ? { type: action.type } : {}),
        ...(display.label ? { label: display.label } : {}),
        labelColor: display.labelColor,
        labelSize: display.labelSize,
        ...(display.labelFont ? { labelFont: display.labelFont } : {}),
        background: button?.background ?? null,
        failed: !this.previews.has(index) && this.failures.has(this.serial, this.profileOf(), this.page, index),
        unset: patch?.unset === true,
        connecting: patch?.connecting === true,
      });
    } catch (err) {
      console.error(`[${this.label()}] render of ${this.keyName(index)} failed: ${(err as Error).message}`);
      return;
    }
    if (this.closed || this.page !== page || this.valueKeys.get(index) !== key) return;
    this.valueArts.set(index, art);
    const value = this.valueFraction(index, action) ?? 0;
    const held = this.drags.has(index) && this.touchFeedback();
    const buffer = composeValue(art, value, held);
    this.lastRenderAt.set(index, Date.now());
    // The editor's grid draws the level too: told when it settles on another whole percent, never per step of a drag.
    if (!this.drags.has(index)) {
      const percent = Math.round(value * 100);
      if (this.reportedValues.get(index) !== percent) {
        this.reportedValues.set(index, percent);
        this.onStateChange();
      }
    }
    if (!force && this.lastSent.get(index) === buffer) return;
    if (force && this.lastSent.get(index) === buffer && this.drags.has(index)) return;
    try {
      await this.device.draw(index, buffer);
      this.lastSent.set(index, buffer);
    } catch (err) {
      console.error(`[${this.label()}] write to ${this.keyName(index)} failed: ${(err as Error).message}`);
      this.lastSent.delete(index);
    }
  }

  /** The sliders and dials on the page shown, and each one's value as a whole percent of its range, for the control socket's status. */
  values(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const index of this.sorted(this.valueKeys.keys())) {
      const value = this.reportedValues.get(index);
      if (value !== undefined) out[index] = value;
    }
    return out;
  }

  /** Whether a touch draws its control pressed: a virtual deck's, with Touch feedback on (the default). Never a Stream Deck's. */
  private touchFeedback(): boolean {
    return this.geometry.units === 'pixels' && this.defaults.touchFeedback !== false;
  }

  /** Every control drawn pressed drawn at rest again: its touch let go without a lift (a lock, a page or panel change). */
  private unpressAll(): void {
    const was = [...this.pressed];
    this.pressed.clear();
    for (const index of was) if (this.screens.has(index)) void this.renderButtonAt(index);
  }

  /** Everything held let go, at the device's asking (DeckDevice.onLetGo): a locked session. */
  private async letGo(reason: string): Promise<void> {
    if (this.closed) return;
    this.unpressAll();
    this.endDrags();
    await this.fireHeldReleases(reason);
    await this.releaseLatches(reason);
  }

  /** How a virtual deck's screen is shown (DeckDevice.surfaceKind); undefined for a Stream Deck. */
  surfaceKind(): 'layer-shell' | 'fullscreen-window' | undefined {
    return this.device.surfaceKind?.();
  }

  /** Whether a virtual deck's touches work now (DeckDevice.touchState); undefined for a Stream Deck. */
  touchState(): TouchState | undefined {
    return this.device.touchState?.();
  }

  /**
   * Run an action sent over the control socket, on this deck. Unlike a key
   * press, a failure propagates to the caller, and any key it holds down is
   * recorded as held by the socket. It belongs to no key, so no key repaints.
   */
  async runFromSocket(action: ActionDef): Promise<void> {
    if (this.closed) throw new Error('the deck has disconnected');
    await runActionOrThrow(this.context(null, 'socket'), action);
  }

  /**
   * Run a key's action (its press, or its release). A failure marks the key
   * and a success clears its mark — keyed by the page and profile it was
   * pressed on, read before running, since a page or profile action moves the
   * deck. The repaint after every press draws or removes the badge: no extra
   * write, no timer.
   */
  private dispatch(index: string, action: ActionDef): Promise<void> {
    // A press that armed a release (a hold: Stream, live) is judged by the
    // release: its success alone must not clear a mark the release will set
    // again, or every short press would flicker the badge and notify afresh.
    // A press that did the whole action — Stream starting — is judged here,
    // so a start that worked clears a start that failed.
    let armed = false;
    return this.settle(index, (ctx) => attempt(ctx, action, () => (armed = true)), () => !armed);
  }

  /** A hold's release: judged only if it acted — one with nothing to do leaves the press's mark alone. */
  private async settleRelease(index: string, action: ActionDef, heldMs: number): Promise<void> {
    let acted = false;
    const run = async (ctx: ActionContext) => {
      const outcome = await runRelease(ctx, action, heldMs);
      acted = outcome !== undefined;
      return outcome ?? null;
    };
    await this.settle(index, run, () => true, () => acted);
  }

  /** Run a key's press or release and mark or clear its failure (dispatch, above). */
  private async settle(
    index: string,
    run: (ctx: ActionContext) => Promise<ActionFailure | null>,
    clearOnSuccess: () => boolean = () => true,
    judged: () => boolean = () => true,
  ): Promise<void> {
    const profile = this.profileOf();
    const page = this.page;
    const button = this.currentButtons()[index];
    const failure = await run(this.context(index));
    if (!judged()) return;
    const slot = this.slotOf(profile, page, index);
    if (failure?.notSetUp) {
      // Not this key's failure: its face says the integration is not set up,
      // and a mark would outlast the setup. Notified as any failed press is.
      this.onActionNeeded({ slot, key: index, keyName: this.keyName(index), label: button?.label, message: failure.message, notSetUp: true });
      return;
    }
    const cleared = failure === null && clearOnSuccess() && this.failures.clear(this.serial, profile, page, index);
    const changed = cleared || (failure !== null && this.failures.mark(this.serial, { profile, page, key: index, error: failure.message }, button));
    if (changed) this.onStateChange();
    if (cleared) this.onFailureCleared(slot);
    // Every failed press whose message says what to do, not only a new mark:
    // a repeat is counted on the key's one notification (services/notifications.ts).
    if (failure?.actionNeeded) {
      this.onActionNeeded({ slot, key: index, keyName: this.keyName(index), label: button?.label, message: failure.message });
    }
    // Most actions change something visible; a cheap targeted repaint beats
    // waiting up to a full tick for the button to catch up.
    void this.renderButtonAt(index, true);
  }

  /**
   * Clear a key's failure mark because the person said so (the editor's
   * Clear) — the one way besides a press that works or an edit. Repaints the
   * key when its page is the one shown. Returns whether it had a mark.
   */
  clearFailure(profile: string, page: string, key: string): boolean {
    const changed = this.failures.clear(this.serial, profile, page, key);
    if (!changed) return false;
    this.onStateChange();
    this.onFailureCleared(this.slotOf(profile, page, key));
    if (page === this.page && profile === this.profileOf()) void this.renderButtonAt(key, true);
    return true;
  }

  /** A key's notification slot: one per key, on its page and profile. */
  private slotOf(profile: string, page: string, key: string): string {
    return `${this.serial}:${profile}:${page}:${key}`;
  }

  /** This deck's failed keys, on every page and profile, for the control socket's status. */
  failedKeys(): KeyFailure[] {
    return this.failures.forDeck(this.serial);
  }

  private context(index: string | null, source: ActionContext['source'] = 'deck'): ActionContext {
    return {
      deck: this,
      key: index,
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
  private buttonAt(index: string): ButtonDef | undefined {
    return this.previews.get(index) ?? this.currentButtons()[index];
  }

  private baseDisplay(button: ButtonDef | undefined): Display {
    return {
      // null (deliberately no icon) and absent both start with no icon layer
      // here; drawKey() gives an absent one the action's default.
      icon: button?.icon ?? undefined,
      // Its own scale; else, in an older config not yet converted, the old crop (icon-fit.ts legacyIconFit).
      ...(button?.iconScale !== undefined ? { iconScale: button.iconScale } : button?.iconFit === 'cover' ? { iconScale: 'cover' as const } : {}),
      builtinIconSize: this.defaults.builtinIconSize,
      ...(this.defaults.labelFont ? { labelFont: this.defaults.labelFont } : {}),
      label: button?.label,
      labelColor: button?.labelColor ?? this.defaults.labelColor,
      labelSize: button?.labelSize ?? this.defaults.labelSize,
      labelPosition: button?.labelPosition ?? this.defaults.labelPosition,
      background: button?.background ?? this.defaults.background,
    };
  }

  private async renderButtonAt(index: string, force = false): Promise<void> {
    try {
      await this.drawKey(index, force, false);
    } catch (err) {
      console.error(`[${this.label()}] render of ${this.keyName(index)} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Render one key and write it to the deck. A render failure throws (the
   * caller decides whether to log it or report it); a USB write failure is
   * logged here. strictIcon: see renderButton().
   */
  private async drawKey(index: string, force: boolean, strictIcon: boolean): Promise<void> {
    if (this.closed) return;
    const screen = this.screens.get(index);
    if (!screen) return;
    if (this.valueKeys.has(index)) return this.drawValue(index, force);
    // Drawn now, from the state as it is now: anything that changes it after this marks it again.
    this.stale.delete(index);
    // Drawn square at the shorter side, then filled out to the screen in the
    // key's background: the same face as on a square key, never stretched.
    const side = Math.min(screen.width, screen.height);
    const button = this.buttonAt(index);
    const display = this.baseDisplay(button);
    const page = this.page;
    if (this.pressed.has(index)) display.pressed = true;

    const patch = await describeAction(this.context(index), button?.action);
    if (patch) Object.assign(display, patch);
    // Not on a preview: it shows something unsaved, which has never been pressed.
    if (!this.previews.has(index) && this.failures.has(this.serial, this.profileOf(), this.page, index)) display.failed = true;

    // The action's built-in default, in this order: an icon
    // the action chose (its active state's icon, album art) wins, then the key's own icon;
    // `icon: null` means deliberately none, so only an *absent* icon gets a
    // default; and a key with no action gets none — it stays blank. An
    // action's own file (an app's icon) comes before its built-in.
    if (button?.action && button.icon === undefined && display.icon === undefined) {
      const file = await defaultIconFileOf(button.action, side);
      const name = file ? null : defaultIconFor(button.action, iconStateOf(button.action, this.context(index)));
      if (file) display.icon = file;
      else if (name) display.icon = builtinIconRef(name);
    }

    const face = this.liveFaceAt(index);
    const drawn = face ? JSON.stringify(face) : undefined;
    if (drawn !== this.drawnFaces.get(index)) {
      if (drawn === undefined) this.drawnFaces.delete(index);
      else this.drawnFaces.set(index, drawn);
      this.onStateChange();
    }

    // A virtual deck's control is drawn at its own box and cut to its shape
    // (render.ts renderFace): fill over the whole shape, the label in its
    // largest inner rectangle, transparent outside it, with its outline
    // inside its edge (render.ts OUTLINE_PX). A Stream Deck's key is
    // drawn exactly as before: square, filled out to a screen that is not.
    const buffer = this.geometry.units === 'pixels'
      ? await renderFace(display, { ...screen, outline: true }, strictIcon)
      : await fillScreen(await renderButton(display, side, strictIcon), side, screen.width, screen.height, display.background);

    this.lastRenderAt.set(index, Date.now());
    // Drawn for a page the deck has since left (a touch's pressed face, under a page action): the new page's own draw is what shows.
    if (this.page !== page) return;
    // Drawn pressed or at rest for a touch that has changed since (Codex, PR #11): a quick tap's lift
    // can finish first — its resting face cached and skipped as already sent — and the press's slower
    // face must not land after it and stay. The draw for the current state is the one that shows.
    if ((display.pressed === true) !== this.pressed.has(index)) return;

    // renderButton caches, so identical output is the same Buffer instance.
    // Skipping the USB write keeps the deck responsive under a 2 Hz refresh.
    if (!force && this.lastSent.get(index) === buffer) return;

    try {
      await this.device.draw(index, buffer);
      this.lastSent.set(index, buffer);
    } catch (err) {
      console.error(`[${this.label()}] write to ${this.keyName(index)} failed: ${(err as Error).message}`);
      this.lastSent.delete(index);
    }
  }

  private async renderPage(force = false): Promise<void> {
    // Every page shown — a start, a page change, a profile switch, a reload —
    // is a forced render: a virtual deck takes the page's background first
    // (the same again does nothing), then every key is sent over it.
    if (force) this.device.setBackground?.(this.layout.pages[this.page]?.background);
    for (const i of this.screens.keys()) {
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

      for (const i of this.screens.keys()) {
        // Told it changed: drawn once, whatever kind of key it is.
        if (this.stale.has(i)) {
          await this.renderButtonAt(i);
          continue;
        }
        // On a clock only: a key whose face depends on the time (a clock), or
        // on state nothing announces. Keys redrawn on events (OBS, VTube
        // Studio, Twitch) are not dynamic, and cost nothing here at rest.
        const button = this.buttonAt(i);
        if (!isDynamic(button?.action)) continue;
        const interval = button?.refreshMs ?? this.defaults.refreshMs;
        if (now - (this.lastRenderAt.get(i) ?? 0) >= interval) {
          await this.renderButtonAt(i);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  invalidateByType(types: string[]): void {
    for (const i of this.screens.keys()) {
      const type = this.buttonAt(i)?.action?.type;
      if (type && types.includes(type)) this.stale.add(i);
    }
  }

  // -------------------------------------------------------------------------
  // Previews: an unsaved button shown on a key
  // -------------------------------------------------------------------------

  /** Keys showing a preview, by index. Survives page changes, profile switches and reloads. */
  private previews = new Map<string, ButtonDef>();
  /** One preview render per key at a time, plus at most one follow-up. */
  private previewRenders = new Map<string, { running: Promise<void>; followUp: Promise<void> | null }>();

  /**
   * Whether the page shown has a key whose action type starts with `prefix`
   * ("obs."), pressed or released: what a service that connects only while a
   * key needs it asks (services/obs.ts). A multi action's steps are not
   * counted — they have no face to keep current, and a press connects anyway.
   */
  shows(prefix: string): boolean {
    return this.shownActions(prefix).length > 0;
  }

  /** The actions of this type family on the shown page, press and release: what services/obs.ts is told the keys name. */
  shownActions(prefix: string): ActionDef[] {
    return Object.values(this.currentButtons()).flatMap((button) =>
      [button.action, button.onRelease].filter((a): a is ActionDef => a?.type.startsWith(prefix) === true),
    );
  }

  /**
   * The actions of this type family on **every page** of the layout this deck
   * shows, press and release, a multi action's steps included: what
   * services/discord.ts is kept connected for (ARCHITECTURE, the Discord
   * exception to "only while shown").
   */
  layoutActions(prefix: string): ActionDef[] {
    const of = (a: ActionDef | undefined): ActionDef[] => {
      if (!a) return [];
      if (a.type === 'multi' && Array.isArray(a.steps)) return (a.steps as ActionDef[]).flatMap(of);
      return a.type.startsWith(prefix) ? [a] : [];
    };
    return Object.values(this.layout.pages).flatMap((page) => Object.values(page.buttons ?? {}).flatMap((button) => [...of(button.action), ...of(button.onRelease)]));
  }

  /** True if `key` is one of this deck's keys. */
  hasKey(key: string): boolean {
    return this.order.has(key);
  }

  previewKeys(): string[] {
    return this.sorted(this.previews.keys());
  }

  /**
   * Show `button` on a key without saving it. Resolves once it is drawn;
   * rejects if it cannot be drawn (e.g. an unreadable icon), in which case the
   * preview is removed again and the key goes back to what it showed.
   */
  async setPreview(index: string, button: ButtonDef): Promise<void> {
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
  async clearPreview(index?: string): Promise<string[]> {
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
  private renderPreviewKey(index: string): Promise<void> {
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
        this.lastRenderAt.clear();
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
    // Every page of a virtual deck has its own layout (types.ts PageDef.panel).
    this.relayoutFor(this.layout, id);
    // A key under a finger on the page left is not pressed on the new one.
    this.pressed.clear();
    this.endDrags();
    this.page = id;
    this.onStateChange();
    await this.renderPage(true);
  }

  async goBack(): Promise<void> {
    const previous = this.history.pop();
    if (!previous || !this.layout.pages[previous]) return;
    await this.fireHeldReleases('a page change');
    await this.releaseLatches('a page change');
    this.relayoutFor(this.layout, previous);
    // A key under a finger on the page left is not pressed on the new one.
    this.pressed.clear();
    this.endDrags();
    this.page = previous;
    this.onStateChange();
    await this.renderPage(true);
  }

  async setBrightness(value: number): Promise<void> {
    const level = clampBrightness(value);
    // A device without a backlight keeps the number, so the socket still reports what was asked.
    await this.device.setBrightness?.(this.sleepLevel === null ? level : Math.min(this.sleepLevel, level));
    this.brightness = level;
    this.onStateChange();
  }

  /**
   * A slider's or dial's brightness: 0–100, dark included — the one way
   * besides src/sleep.ts below clampBrightness's 5. Touch still works at 0,
   * so the control that set it can turn it back up.
   */
  async setBrightnessLevel(value: number): Promise<void> {
    const level = Math.max(0, Math.min(100, Math.round(value)));
    await this.device.setBrightness?.(this.sleepLevel === null ? level : Math.min(this.sleepLevel, level));
    this.brightness = level;
    this.onStateChange();
  }

  /** A virtual deck is drawn at full brightness unless it is set: defaults.brightness is for a backlight. */
  private ownBrightness(hardware: DeckDef): number {
    return hardware.brightness ?? (this.device.dimsInSoftware ? 100 : this.defaults.brightness);
  }

  /** Below clampBrightness on purpose: only src/sleep.ts sets a deck dark. */
  applySleep(level: number | null): void {
    if (level === this.sleepLevel || this.closed) return;
    this.sleepLevel = level;
    void Promise.resolve(this.device.setBrightness?.(level === null ? this.brightness : Math.min(level, this.brightness))).catch((err: unknown) => {
      console.error(`[${this.label()}] could not change its brightness for sleep: ${String(err)}`);
    });
    this.onStateChange();
  }

  canDim(): boolean {
    return this.device.setBrightness !== undefined;
  }

  followsDesktop(): boolean {
    return this.device.dimsInSoftware !== true;
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
    this.endDrags();
    this.layout = layout;
    this.page = startPageOf(layout);
    this.relayoutFor(layout, this.page);
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
    const stays = keepPage && layout.pages[this.page] !== undefined;
    const page = stays ? this.page : startPageOf(layout);
    // A virtual deck's panel may have changed with the page's layout: a key
    // gone from under a finger is let go first, as on any way off a page.
    const next = this.geometryOf(layout, page);
    if (next && !sameControls(next, this.geometry)) {
      await this.fireHeldReleases('a panel change');
      await this.releaseLatches('a panel change');
      this.endDrags();
      this.useGeometry(next);
    }
    if (!stays) {
      await this.fireHeldReleases('a config reload');
      await this.releaseLatches('a config reload');
      this.endDrags();
      // A key under a finger on the page left is not pressed on the new one.
      this.pressed.clear();
      this.page = page;
      this.history = [];
      this.onStateChange();
    } else {
      await this.releaseLatchesOnChangedKeys();
    }
    await this.setBrightness(this.ownBrightness(hardware));
    this.lastSent.clear();
    await this.renderPage(true);
  }

  async close(): Promise<void> {
    // Before the flag: a key still held by this deck is released rather than
    // left down when the deck goes (unplugged, or the daemon shutting down).
    await this.fireHeldReleases('the deck closing');
    await this.releaseLatches('the deck closing');
    this.endDrags();
    sleep.remove(this);
    this.stopWatchingKeyboard?.();
    this.stopWatchingKeyboard = null;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    try {
      await this.device.clear?.();
      await this.device.close();
    } catch {
      // device may already be gone
    }
  }
}

/** Whether two sets of controls are the same, key for key: where each is, its size and its shape. */
function sameControls(a: DeckGeometry, b: DeckGeometry): boolean {
  return JSON.stringify(a.keys) === JSON.stringify(b.keys) && JSON.stringify(a.canvas ?? null) === JSON.stringify(b.canvas ?? null);
}
