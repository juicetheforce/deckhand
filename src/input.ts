import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { parseCombo, textToTaps } from './keymap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BIN =
  process.env.DECKHAND_INPUT_BIN ??
  path.resolve(HERE, '..', 'helper', 'deckhand-input');

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Owns the lifetime of the C helper process. Commands are serialized: one
 * outstanding at a time, which keeps modifier state coherent and costs
 * nothing at human press rates.
 */
class InputBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private queue: Pending[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  start(): void {
    if (this.proc || this.stopped) return;

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error(`[input] cannot spawn helper at ${BIN}: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line.trim()));

    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      console.error(`[input] ${line}`);
    });

    proc.on('error', (err) => {
      console.error(`[input] helper error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      console.error(`[input] helper exited (code=${code} signal=${signal})`);
      this.ready = false;
      this.proc = null;
      this.failAllPending(new Error('input helper exited'));
      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    if (line === 'READY') {
      this.ready = true;
      console.log('[input] virtual keyboard ready');
      for (const w of this.readyWaiters) w();
      this.readyWaiters = [];
      return;
    }
    const pending = this.queue.shift();
    if (!pending) return;
    if (line === 'OK') pending.resolve();
    else pending.reject(new Error(`input helper replied: ${line}`));
  }

  private failAllPending(err: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) p.reject(err);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      console.log('[input] restarting helper');
      this.start();
    }, 2000);
  }

  private waitReady(timeoutMs = 5000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('input helper not ready')), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async send(command: string): Promise<void> {
    await this.waitReady();
    const proc = this.proc;
    if (!proc) throw new Error('input helper not running');
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      proc.stdin.write(`${command}\n`, (err) => {
        if (err) reject(err);
      });
    });
  }

  /** Press and release a combo, e.g. "ctrl+alt+3". */
  async tap(combo: string): Promise<void> {
    await this.send(`TAP ${parseCombo(combo).join(' ')}`);
  }

  /** Press a combo and leave it held. Caller is responsible for up(). */
  async down(combo: string): Promise<void> {
    await this.send(`DOWN ${parseCombo(combo).join(' ')}`);
  }

  /** Release a combo previously pressed with down(). */
  async up(combo: string): Promise<void> {
    await this.send(`UP ${parseCombo(combo).join(' ')}`);
  }

  /** Press and hold a combo for `ms`, then release. */
  async hold(combo: string, ms: number): Promise<void> {
    const codes = parseCombo(combo).join(' ');
    await this.send(`DOWN ${codes}`);
    await new Promise((r) => setTimeout(r, ms));
    await this.send(`UP ${codes}`);
  }

  /** Type a literal string (US layout). */
  async type(text: string, delayMs = 8): Promise<void> {
    for (const codes of textToTaps(text)) {
      await this.send(`TAP ${codes.join(' ')}`);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}

export const input = new InputBridge();
export const INPUT_BIN = BIN;
