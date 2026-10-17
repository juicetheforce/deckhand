import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ControlInput, DeckDevice, DeckDriver, FoundDevice, TouchState } from '../devices.js';
import { geometryOfPanel, type DeckGeometry } from '../geometry.js';
import { controlAt, type HitControl } from '../hit-test.js';
import { renderMessage } from '../render.js';
import { findScreen, listScreens, type Screen } from '../screens.js';
import * as sessionLock from '../services/session-lock.js';
import { watchScreensAndTouch } from '../services/hotplug.js';
import { findTouch, listInputNodes, readable, touchIdentity, type InputNode } from '../touchscreens.js';
import type { PairReply } from '../control/protocol.js';
import type { Config, LayoutDef, TouchDeviceDef } from '../types.js';
import { canvasFrame, clearFrame, imageFrame, quitFrame, touchFrame } from './panel-frames.js';

/**
 * Virtual decks: a screen the config names as one — `decks["<screen key>"]`
 * with `virtual` (src/screens.ts has the key) — shown by deckhand-panel
 * (panel/), one helper per connected screen, and pressed through the
 * touchscreen paired with it, read by the helper and grabbed. The daemon
 * renders every key and hit-tests every touch (src/hit-test.ts); the helper
 * only places images and reports where a finger went down.
 *
 * Costs nothing at rest: a scan reads sysfs (the screens, and the input nodes
 * while a virtual deck is open), and a helper runs only while its screen is
 * connected. No timer — the one-shot deadlines below are for a helper
 * starting or stopping, and for a pairing tap.
 *
 * **No touch runs an action unless the session is unlocked and active**
 * (services/session-lock.ts, failing closed); when that stops being so,
 * every touch in progress is let go, and the session lets go of every key.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The helper: beside the daemon in an install, or the checkout's build. */
export const PANEL_BIN = process.env.DECKHAND_PANEL_BIN ?? path.resolve(HERE, '../../panel/deckhand-panel');

/** How long a helper may take to show its surface. */
const READY_MS = 5000;
/** How long a helper may take to quit before it is stopped. */
const QUIT_MS = 2000;
/** After a helper failed, its deck is not listed again for this long, so a broken helper cannot respawn in a loop. */
const RETRY_AFTER_MS = 30_000;
/** How long a pairing waits for the tap. */
export const PAIR_MS = 60_000;

/** Siblings already said to be unreadable, by deck and node: once each per daemon run, not on every attach. */
const unreadSiblingsSaid = new Set<string>();

interface Ready {
  output: string;
  width: number;
  height: number;
  scale: number;
  transform: number;
  surface: string;
}

/** A helper line, parsed: an object with `ev`, or null. */
function parseLine(line: string): ({ ev: string } & Record<string, unknown>) | null {
  try {
    const event = JSON.parse(line);
    return event && typeof event.ev === 'string' ? event : null;
  } catch {
    return null;
  }
}

class PanelDevice implements DeckDevice {
  readonly driver = 'virtual';
  geometry: DeckGeometry;
  private rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  private controls: HitControl[] = [];
  /** The newest image for each key not yet sent: a key drawn twice before the first went keeps only the second. */
  private pending = new Map<string, Buffer>();
  private inFlight = false;
  private canvas: Buffer | null = null;
  private redrawListeners: Array<() => void> = [];
  private inputListeners: Array<(event: ControlInput) => void> = [];
  private letGoListeners: Array<(reason: string) => void> = [];
  private exited = false;
  private closing = false;
  readonly gone: Promise<void>;
  /** Each contact down, and the control it started on (null: it started on none). */
  private contacts = new Map<number, string | null>();
  /** How many contacts are down on each control: it goes up when the last lifts. */
  private pressedBy = new Map<string, number>();
  /** The touch devices last sent to the helper, as one string, so an unchanged scan sends nothing. */
  private touchSent = '';
  private touchscreen = '';
  private touch: Exclude<TouchState, 'locked' | 'inactive' | 'unknown'> = 'not-paired';
  private stopLock: () => void;
  private refusedLogged = false;

  constructor(
    readonly id: string,
    readonly connector: string,
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly productName: string,
    private ready: Ready,
    private readonly onExit: (expected: boolean, code: number | null) => void,
  ) {
    this.geometry = geometryOfPanel(undefined, productName);
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => this.onLine(line));
    this.gone = new Promise((resolve) => proc.on('exit', () => resolve()));
    proc.on('exit', (code) => {
      this.exited = true;
      this.stopLock();
      sessionLock.release();
      onExit(this.closing, code);
    });
    sessionLock.acquire();
    this.stopLock = sessionLock.onLockChange((state) => {
      if (state === 'open') {
        this.refusedLogged = false;
        console.log(`[virtual] ${this.id}: the session is unlocked; touches work`);
        return;
      }
      console.log(`[virtual] ${this.id}: the session is ${state === 'unknown' ? 'in an unknown state' : state}; touches do nothing`);
      this.letGoAll(`the session being ${state === 'unknown' ? 'unreadable' : state}`);
    });
  }

  private onLine(line: string): void {
    const event = parseLine(line);
    if (!event) return;
    switch (event.ev) {
      case 'drawn':
        this.inFlight = false;
        this.sendNext();
        break;
      case 'ready':
        // A resize: the helper's canvas is new and blank. Everything again.
        this.ready = event as unknown as Ready;
        this.pending.clear();
        this.inFlight = false;
        if (this.canvas) this.write(this.canvas);
        for (const listener of this.redrawListeners) listener();
        break;
      case 'touch':
        this.onTouch(event);
        break;
      case 'touch-open':
        if (event.device === this.touchscreen) {
          this.touch = 'ready';
          console.log(`[virtual] ${this.id}: reading touches from ${this.touchscreen}`);
        }
        break;
      case 'touch-failed':
        console.error(`[virtual] ${this.id}: ${String(event.message)}`);
        if (event.device === this.touchscreen) this.touch = 'failed';
        break;
      case 'touch-gone':
        if (event.device === this.touchscreen) {
          console.log(`[virtual] ${this.id}: its touchscreen went away; the panel stays, without touch`);
          this.touch = 'missing';
          // Sent again when a scan finds it back.
          this.touchSent = '';
        }
        break;
      case 'error':
        console.error(`[virtual] ${this.id}: ${String(event.message)}`);
        break;
    }
  }

  /** A contact down or up: hit-tested on its way down, and belonging to that control until it lifts. */
  private onTouch(event: Record<string, unknown>): void {
    const contact = Number(event.contact);
    if (event.edge === 'up') {
      if (!this.contacts.has(contact)) return; // never seen down, or let go already
      const control = this.contacts.get(contact) ?? null;
      this.contacts.delete(contact);
      if (control === null) return;
      const count = (this.pressedBy.get(control) ?? 1) - 1;
      if (count > 0) {
        this.pressedBy.set(control, count);
        return;
      }
      this.pressedBy.delete(control);
      this.emit({ control, edge: 'up' });
      return;
    }
    if (event.edge !== 'down' || this.contacts.has(contact)) return;
    const state = sessionLock.lockState();
    if (state !== 'open') {
      // Dropped, not queued. Said once per lock, not once per touch.
      if (!this.refusedLogged) console.log(`[virtual] ${this.id}: a touch while the session is ${state}: ignored`);
      this.refusedLogged = true;
      return;
    }
    const control = controlAt(this.controls, Number(event.x), Number(event.y));
    this.contacts.set(contact, control);
    if (control === null) return;
    const count = (this.pressedBy.get(control) ?? 0) + 1;
    this.pressedBy.set(control, count);
    if (count === 1) this.emit({ control, edge: 'down' });
  }

  private emit(event: ControlInput): void {
    for (const listener of this.inputListeners) listener(event);
  }

  /** Forget every touch in progress, and ask the session to let go of everything held. */
  private letGoAll(reason: string): void {
    this.contacts.clear();
    this.pressedBy.clear();
    for (const listener of this.letGoListeners) listener(reason);
  }

  private write(chunk: Buffer): void {
    if (!this.exited) this.proc.stdin.write(chunk);
  }

  private sendNext(): void {
    if (this.inFlight) return;
    const next = this.pending.entries().next();
    if (next.done) return;
    const [control, frame] = next.value;
    this.pending.delete(control);
    this.inFlight = true;
    this.write(frame);
  }

  /**
   * Give the helper the paired touchscreen and its siblings, or none: at
   * opening, and on each scan, so a touchscreen plugged back in is read
   * again. Sends nothing when nothing changed.
   */
  syncTouch(touch: TouchDeviceDef | undefined, nodes: () => InputNode[]): void {
    if (this.exited) return;
    if (!touch) {
      this.touch = 'not-paired';
      this.sendTouch('', []);
      return;
    }
    const found = findTouch(nodes(), touch);
    if (!found) {
      if (this.touch !== 'missing') console.log(`[virtual] ${this.id}: its touchscreen is not connected; the panel shows, without touch`);
      this.touch = 'missing';
      this.sendTouch('', []);
      return;
    }
    // A sibling this process may not open is expected — the udev rule grants
    // touchscreens only — so it is not sent to fail, and said once, not as an
    // error on every attach.
    const siblings = found.siblings.filter((sibling) => {
      if (readable(sibling)) return true;
      const said = `${this.id} ${sibling.devnode}`;
      if (!unreadSiblingsSaid.has(said)) {
        unreadSiblingsSaid.add(said);
        console.log(
          `[virtual] ${this.id}: not grabbing ${sibling.node} (${sibling.name}), another node of its touchscreen: Deckhand may not read it, ` +
            `as the udev rule covers touchscreens only. ${sibling.absolute ? 'It can report positions, so any touch the panel sent through it would reach the desktop.' : 'It cannot report positions.'}`,
        );
      }
      return false;
    });
    const entries: Array<['t' | 's', string]> = [['t', found.touchscreen.devnode], ...siblings.map((s) => ['s', s.devnode] as ['s', string])];
    const before = this.touchSent;
    this.sendTouch(found.touchscreen.devnode, entries);
    // Until the helper says it opened it.
    if (this.touchSent !== before) this.touch = 'opening';
  }

  private sendTouch(touchscreen: string, entries: Array<['t' | 's', string]>): void {
    const key = JSON.stringify(entries);
    if (key === this.touchSent) return;
    this.touchSent = key;
    this.touchscreen = touchscreen;
    // A touch in progress on a device being replaced will never lift.
    if (this.contacts.size > 0) this.letGoAll('its touchscreen changing');
    this.write(touchFrame(entries.length > 0 ? 1 : 0, entries));
  }

  touchState(): TouchState {
    const lock = sessionLock.lockState();
    if (this.touch === 'ready' && lock !== 'open') return lock;
    return this.touch;
  }

  onInput(listener: (event: ControlInput) => void): void {
    this.inputListeners.push(listener);
  }

  onError(_listener: (err: unknown) => void): void {}

  onRedraw(listener: () => void): void {
    this.redrawListeners.push(listener);
  }

  onLetGo(listener: (reason: string) => void): void {
    this.letGoListeners.push(listener);
  }

  layoutFrom(layout: LayoutDef): DeckGeometry {
    return geometryOfPanel(layout.panel, this.productName);
  }

  showGeometry(geometry: DeckGeometry): void {
    this.geometry = geometry;
    this.rects = new Map(geometry.keys.map((k) => [k.id, { x: k.x, y: k.y, w: k.width ?? 0, h: k.height ?? 0 }]));
    this.controls = geometry.keys.map((k) => ({ id: k.id, x: k.x, y: k.y, w: k.w, h: k.h, shape: k.shape }));
    // A touch that started on the old controls belongs to none of the new
    // ones; the session lets go of what was held on a panel change.
    this.contacts.clear();
    this.pressedBy.clear();
    this.pending.clear();
    const size = geometry.canvas ?? { width: 0, height: 0 };
    this.canvas = canvasFrame(size.width, size.height);
    this.write(this.canvas);
  }

  async draw(control: string, rgba: Buffer): Promise<void> {
    const rect = this.rects.get(control);
    if (!rect) throw new Error(`no key "${control}" on this panel`);
    this.pending.set(control, imageFrame(rect.x, rect.y, rect.w, rect.h, rgba));
    this.sendNext();
  }

  async clear(): Promise<void> {
    this.pending.clear();
    this.write(clearFrame());
  }

  /** The screen as the helper last reported it. */
  screen(): Ready {
    return this.ready;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.exited) return;
    this.write(quitFrame());
    this.proc.stdin.end();
    const deadline = setTimeout(() => this.proc.kill('SIGTERM'), QUIT_MS);
    await this.gone;
    clearTimeout(deadline);
  }
}

/** Start a helper on an output and wait until its surface is shown. Resolves null, logged, if it is not. */
function startHelper(id: string, output: string): Promise<{ proc: ChildProcessWithoutNullStreams; ready: Ready } | null> {
  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(PANEL_BIN, ['--output', output], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error(`[virtual] cannot start ${PANEL_BIN}: ${(err as Error).message}`);
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (value: { proc: ChildProcessWithoutNullStreams; ready: Ready } | null, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      lines.close();
      if (value === null) {
        console.error(`[virtual] ${id} on ${output}: ${why}`);
        proc.kill('SIGTERM');
      }
      resolve(value);
    };
    const deadline = setTimeout(() => settle(null, `the panel did not appear within ${READY_MS / 1000} s`), READY_MS);
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      const event = parseLine(line);
      if (event?.ev === 'ready') settle({ proc, ready: event as unknown as Ready });
      else if (event?.ev === 'error') settle(null, String(event.message));
    });
    proc.stderr.on('data', (chunk: Buffer) => console.error(`[virtual] ${id}: ${chunk.toString().trim()}`));
    proc.on('error', (err) => settle(null, `cannot start ${PANEL_BIN}: ${err.message}`));
    proc.on('exit', (code) => settle(null, `the panel exited (${code})`));
  });
}

/**
 * Whether a display event changed anything a virtual deck cares about. A
 * DRM "change" on the card is the GPU's hotplug signal, and some come in
 * bursts with no screen coming or going (seen on the laptop: one every ~9 s
 * for two minutes, nothing plugged — a monitor going in and out of standby,
 * probably). So: with no virtual deck configured, never; otherwise only when
 * the connected screens or their keys differ from the last look — a few small
 * sysfs reads, instead of a rescan of every driver.
 */
export function screenChangeFilter(wanted: () => boolean, drmDir?: string): () => boolean {
  const signature = () => listScreens(drmDir).map((s) => `${s.connector}=${s.key}`).join(',');
  let last = signature();
  return () => {
    if (!wanted()) return false;
    const now = signature();
    if (now === last) return false;
    last = now;
    return true;
  };
}

/** What a pairing found (control/protocol.ts). */
export type Pairing = PairReply;

/** Why a pairing did not pair. `code` is the control socket's. */
export class PairingError extends Error {
  constructor(
    readonly code: 'not_found' | 'busy' | 'action_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface VirtualDriver extends DeckDriver {
  /** The connected screens, and the touchscreens, for setting a virtual deck up. */
  screens(): { screens: Screen[]; touchscreens: InputNode[] };
  /**
   * Show "Tap this screen" on a connector and wait for a touchscreen to be
   * touched: the one touched is that screen's — nothing else links a
   * touchscreen to its screen. A virtual deck on that screen is closed meanwhile, and
   * comes back after. Ends early, rejected, when `signal` aborts.
   */
  pair(connector: string, signal?: AbortSignal): Promise<Pairing>;
}

/**
 * The driver. `config` is read at every scan, so a reload that adds or
 * removes a virtual deck takes effect on the scan the reload runs.
 */
export function createVirtualDriver(config: () => Config | null): VirtualDriver {
  const failedAt = new Map<string, number>();
  const open = new Map<string, PanelDevice>();
  /** Connectors being paired: no virtual deck is shown on them meanwhile. */
  const pairing = new Set<string>();
  const warnedAmbiguous = new Set<string>();
  let rescan: ((why: string) => void) | null = null;

  return {
    name: 'virtual',
    async list(): Promise<FoundDevice[]> {
      const found: FoundDevice[] = [];
      const screens = listScreens();
      // Read once per scan, and only if an open deck needs it.
      let nodes: InputNode[] | null = null;
      const inputNodes = () => (nodes ??= listInputNodes());
      for (const [id, deck] of Object.entries(config()?.decks ?? {})) {
        if (!deck.virtual) continue;
        const screen = findScreen(screens, id, deck.virtual.output);
        if (screen === 'ambiguous') {
          if (!warnedAmbiguous.has(id)) {
            warnedAmbiguous.add(id);
            console.error(`[virtual] ${id}: several identical screens are connected and none is on ${deck.virtual.output}, where it was set up; showing it on none`);
          }
          continue;
        }
        warnedAmbiguous.delete(id);
        if (!screen || pairing.has(screen.connector)) continue;
        const running = open.get(id);
        if (running) {
          running.syncTouch(deck.virtual.touch, inputNodes);
          found.push({ id, open: async () => null });
          continue;
        }
        if (Date.now() - (failedAt.get(id) ?? -Infinity) < RETRY_AFTER_MS) continue;
        const touch = deck.virtual.touch;
        found.push({
          id,
          open: async () => {
            const started = await startHelper(id, screen.connector);
            if (!started) {
              failedAt.set(id, Date.now());
              return null;
            }
            failedAt.delete(id);
            const name = deck.name ?? screen.edid?.name ?? `Virtual deck on ${screen.connector}`;
            const device = new PanelDevice(id, screen.connector, started.proc, name, started.ready, (expected, code) => {
              if (open.get(id) === device) open.delete(id);
              if (expected) return;
              // The screen went (exit 3), or the helper died: the scan this
              // asks for closes the session, letting every key go. A helper
              // that failed is not restarted for a while; a screen unplugged
              // comes back as soon as it is plugged in again.
              if (code !== 3) failedAt.set(id, Date.now());
              rescan?.(`virtual deck ${id}'s panel stopped`);
            });
            open.set(id, device);
            device.syncTouch(touch, inputNodes);
            return device;
          },
        });
      }
      return found;
    },

    watch(onChange) {
      rescan = onChange;
      const screensChanged = screenChangeFilter(() => Object.values(config()?.decks ?? {}).some((d) => d.virtual));
      const stop = watchScreensAndTouch((action, devpath) => {
        if (/\/card\d+$/.test(devpath) && !screensChanged()) return;
        onChange(`${action} ${devpath.split('/').pop()}`);
      });
      return () => {
        stop();
        rescan = null;
      };
    },

    screens() {
      return { screens: listScreens(), touchscreens: listInputNodes().filter((n) => n.touchscreen) };
    },

    async pair(connector, signal) {
      const screen = listScreens().find((s) => s.connector === connector);
      if (!screen) throw new PairingError('not_found', `no screen is connected on ${connector}`);
      const touchscreens = listInputNodes().filter((n) => n.touchscreen);
      if (touchscreens.length === 0) throw new PairingError('not_found', 'no touchscreen is connected');
      if (pairing.has(connector)) throw new PairingError('busy', `${connector} is being paired already`);
      pairing.add(connector);
      let proc: ChildProcessWithoutNullStreams | null = null;
      try {
        // A virtual deck on this screen goes first: its helper holds the grab,
        // and a grabbed touchscreen tells nobody else it was touched.
        const showing = [...open.values()].filter((d) => d.connector === connector);
        if (showing.length > 0) {
          rescan?.(`pairing ${connector}`);
          let deadline: NodeJS.Timeout | undefined;
          await Promise.race([Promise.all(showing.map((d) => d.gone)), new Promise((resolve) => (deadline = setTimeout(resolve, READY_MS)))]);
          clearTimeout(deadline);
        }
        const started = await startHelper(`pairing ${connector}`, connector);
        if (!started) throw new PairingError('action_failed', `the panel could not be shown on ${connector}`);
        proc = started.proc;
        const { width, height } = started.ready;
        const message = await renderMessage(['Tap this screen', 'to use it as a deck'], width, height);
        proc.stdin.write(canvasFrame(width, height));
        proc.stdin.write(imageFrame(0, 0, width, height, message));
        proc.stdin.write(touchFrame(2, touchscreens.map((n) => ['t', n.devnode] as ['t', string])));

        const helper = proc;
        const tapped = await new Promise<string>((resolve, reject) => {
          const failed = new Map<string, string>();
          const lines = readline.createInterface({ input: helper.stdout });
          const done = (fn: () => void) => {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', onAbort);
            lines.close();
            fn();
          };
          const onAbort = () => done(() => reject(new PairingError('action_failed', 'pairing was cancelled')));
          const deadline = setTimeout(() => done(() => reject(new PairingError('action_failed', `nothing was tapped within ${PAIR_MS / 1000} s`))), PAIR_MS);
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort);
          helper.on('exit', () => done(() => reject(new PairingError('action_failed', 'the panel closed before a tap'))));
          lines.on('line', (line) => {
            const event = parseLine(line);
            if (event?.ev === 'tap') done(() => resolve(String(event.device)));
            else if (event?.ev === 'touch-failed') {
              failed.set(String(event.device), String(event.message));
              // Every touchscreen refused: nothing can be tapped. Usually the
              // udev rule that lets Deckhand read touchscreens is not installed.
              if (failed.size === touchscreens.length) done(() => reject(new PairingError('action_failed', [...failed.values()].join('; '))));
            }
          });
        });
        const node = touchscreens.find((n) => n.devnode === tapped);
        if (!node) throw new PairingError('action_failed', `the helper named ${tapped}, which is not a touchscreen`);
        return {
          connector,
          screen: screen.key,
          touch: touchIdentity(node),
          touchName: node.name,
          width,
          height,
          widthMm: screen.edid?.widthMm ?? 0,
          heightMm: screen.edid?.heightMm ?? 0,
          ...(screen.edid?.name ? { name: screen.edid.name } : {}),
        };
      } finally {
        if (proc && proc.exitCode === null) {
          const gone = new Promise((resolve) => proc!.once('exit', resolve));
          proc.stdin.write(quitFrame());
          proc.stdin.end();
          const deadline = setTimeout(() => proc!.kill('SIGTERM'), QUIT_MS);
          await gone;
          clearTimeout(deadline);
        }
        pairing.delete(connector);
        rescan?.(`pairing ${connector} finished`);
      }
    },
  };
}
