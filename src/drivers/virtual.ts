import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ControlInput, DeckDevice, DeckDriver, FoundDevice } from '../devices.js';
import { geometryOfPanel, type DeckGeometry } from '../geometry.js';
import type { Config, LayoutDef } from '../types.js';
import { canvasFrame, clearFrame, imageFrame, quitFrame } from './panel-frames.js';

/**
 * Virtual decks: a screen the config names as one (`decks[id].virtual`),
 * shown by deckhand-panel (panel/), one helper per connected screen. The
 * daemon renders every key, as for a Stream Deck; the helper only places the
 * images on the screen.
 *
 * Costs nothing at rest: a scan reads one sysfs file per virtual deck, and a
 * helper runs only while its screen is connected. No timer — the one-shot
 * deadlines below are for a helper starting or stopping.
 *
 * Touch is not read yet (stage 1, S3), so a virtual deck shows and does not
 * press.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The helper: beside the daemon in an install, or the checkout's build. */
export const PANEL_BIN = process.env.DECKHAND_PANEL_BIN ?? path.resolve(HERE, '../../panel/deckhand-panel');
/** Where the screens are listed; a test points it at a scratch copy. */
const DRM_DIR = process.env.DECKHAND_DRM_DIR ?? '/sys/class/drm';

/** How long a helper may take to show its surface. */
const READY_MS = 5000;
/** How long a helper may take to quit before it is stopped. */
const QUIT_MS = 2000;
/** After a helper failed, its deck is not listed again for this long, so a broken helper cannot respawn in a loop. */
const RETRY_AFTER_MS = 30_000;

/** Whether the screen on this connector is connected now: /sys/class/drm/card*-<output>/status. */
export function outputConnected(output: string, drmDir = DRM_DIR): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(drmDir);
  } catch {
    return false;
  }
  return entries.some((name) => {
    if (!/^card\d+-/.test(name) || name.replace(/^card\d+-/, '') !== output) return false;
    try {
      return fs.readFileSync(path.join(drmDir, name, 'status'), 'utf8').trim() === 'connected';
    } catch {
      return false;
    }
  });
}

interface Ready {
  output: string;
  width: number;
  height: number;
  scale: number;
  transform: number;
  surface: string;
}

class PanelDevice implements DeckDevice {
  readonly driver = 'virtual';
  geometry: DeckGeometry;
  private rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** The newest image for each key not yet sent: a key drawn twice before the first went keeps only the second. */
  private pending = new Map<string, Buffer>();
  private inFlight = false;
  private canvas: Buffer | null = null;
  private redrawListeners: Array<() => void> = [];
  private exited = false;

  constructor(
    readonly id: string,
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly productName: string,
    private ready: Ready,
    private readonly onExit: (expected: boolean, code: number | null) => void,
  ) {
    this.geometry = geometryOfPanel(undefined, productName);
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => this.onLine(line));
    proc.on('exit', (code) => {
      this.exited = true;
      onExit(this.closing, code);
    });
  }

  private closing = false;

  private onLine(line: string): void {
    let event: { ev?: string; message?: string } & Partial<Ready>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.ev === 'drawn') {
      this.inFlight = false;
      this.sendNext();
    } else if (event.ev === 'ready') {
      // A resize: the helper's canvas is new and blank. Everything again.
      this.ready = event as Ready;
      this.pending.clear();
      this.inFlight = false;
      if (this.canvas) this.write(this.canvas);
      for (const listener of this.redrawListeners) listener();
    } else if (event.ev === 'error') {
      console.error(`[virtual] ${this.id}: ${event.message}`);
    }
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

  onInput(_listener: (event: ControlInput) => void): void {
    // Touch arrives in stage 1, S3.
  }

  onError(_listener: (err: unknown) => void): void {}

  onRedraw(listener: () => void): void {
    this.redrawListeners.push(listener);
  }

  layoutFrom(layout: LayoutDef): DeckGeometry {
    return geometryOfPanel(layout.panel, this.productName);
  }

  showGeometry(geometry: DeckGeometry): void {
    this.geometry = geometry;
    this.rects = new Map(geometry.keys.map((k) => [k.id, { x: k.x, y: k.y, w: k.width ?? 0, h: k.height ?? 0 }]));
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
    const gone = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.write(quitFrame());
    this.proc.stdin.end();
    const deadline = setTimeout(() => this.proc.kill('SIGTERM'), QUIT_MS);
    await gone;
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
      try {
        const event = JSON.parse(line);
        if (event.ev === 'ready') settle({ proc, ready: event as Ready });
        else if (event.ev === 'error') settle(null, event.message);
      } catch {
        // not a line of the protocol; ignored
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => console.error(`[virtual] ${id}: ${chunk.toString().trim()}`));
    proc.on('error', (err) => settle(null, `cannot start ${PANEL_BIN}: ${err.message}`));
    proc.on('exit', (code) => settle(null, `the panel exited (${code})`));
  });
}

/**
 * The driver. `config` is read at every scan, so a reload that adds or
 * removes a virtual deck takes effect on the scan the reload runs.
 */
export function createVirtualDriver(config: () => Config | null): DeckDriver {
  const failedAt = new Map<string, number>();
  let rescan: ((why: string) => void) | null = null;

  return {
    name: 'virtual',
    async list(): Promise<FoundDevice[]> {
      const found: FoundDevice[] = [];
      for (const [id, deck] of Object.entries(config()?.decks ?? {})) {
        const output = deck.virtual?.output;
        if (!output || !outputConnected(output)) continue;
        if (Date.now() - (failedAt.get(id) ?? -Infinity) < RETRY_AFTER_MS) continue;
        found.push({
          id,
          open: async () => {
            const started = await startHelper(id, output);
            if (!started) {
              failedAt.set(id, Date.now());
              return null;
            }
            failedAt.delete(id);
            return new PanelDevice(id, started.proc, deck.name ?? `Virtual deck on ${output}`, started.ready, (expected, code) => {
              if (expected) return;
              // The screen went (exit 3), or the helper died: the scan this
              // asks for closes the session, letting every key go. A helper
              // that failed is not restarted for a while; a screen unplugged
              // comes back as soon as it is plugged in again.
              if (code !== 3) failedAt.set(id, Date.now());
              rescan?.(`virtual deck ${id}'s panel stopped`);
            });
          },
        });
      }
      return found;
    },
    watch(onChange) {
      rescan = onChange;
      return () => {
        rescan = null;
      };
    },
  };
}
