import net from 'node:net';
import type { AudioList, DecksResult, ReloadResult, StateSnapshot, StatusResult, SwitchResult } from '../../../src/control/protocol.js';
import type { ButtonDef } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';

export type { DaemonView };

/**
 * The editor's connection to the daemon's control socket (docs/scope.md §7,
 * "M3 protocol design"). Main process only.
 *
 * The editor is a config producer (scope §3): it reads state and geometry,
 * shows previews, and never controls the daemon's lifecycle. Config reaches
 * the daemon only through config.json (config-store.ts), never this socket.
 *
 * - Subscribes to "state", "config" and "audio" events and keeps a view of
 *   the daemon: status, the geometry of connected decks (re-read when the set
 *   of connected decks changes), and the audio device lists the audio forms
 *   pick from. The daemon answers those from its cache, never by running
 *   pactl, so asking costs it nothing.
 * - Reconnects on its own when the daemon goes away (a restart, an update),
 *   retrying after 1 s, doubling to at most 10 s, while disconnected only.
 *   The daemon clears a connection's previews when it closes, so the editor
 *   re-sends whatever preview it wants after onChange reports connected.
 */

/** An error reply from the daemon, with its stable code (scope §7, "Error codes"). */
export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DaemonClientOptions {
  /** From socketPath() in src/control/server.ts; null when $XDG_RUNTIME_DIR is not set. */
  socketPath: string | null;
  onChange?: (view: DaemonView) => void;
  replyTimeoutMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

interface Reply {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

type Waiter = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class DaemonClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private waiting = new Map<number, Waiter>();
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs: number;
  private stopped = false;
  /** The reason from the latest socket error, reported by the 'close' that follows it. */
  private lastError: string | null = null;
  private reloadWaiters = new Set<{ since: string | null; resolve: (result: ReloadResult | null) => void; timer: NodeJS.Timeout }>();
  private current: DaemonView = { connected: false, problem: 'connecting…', status: null, decks: null, audio: null };

  private readonly socketPath: string | null;
  private readonly onChange: (view: DaemonView) => void;
  private readonly replyTimeoutMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;

  constructor(options: DaemonClientOptions) {
    this.socketPath = options.socketPath;
    this.onChange = options.onChange ?? (() => {});
    this.replyTimeoutMs = options.replyTimeoutMs ?? 10_000;
    this.retryInitialMs = options.retryInitialMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 10_000;
    this.retryMs = this.retryInitialMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null; // before destroy(), so its 'close' is ignored as a stale socket's
    socket?.destroy();
    this.update({ connected: false, problem: 'disconnected', status: null, decks: null, audio: null });
  }

  view(): DaemonView {
    return this.current;
  }

  /** Show a button on a key without saving it. Resolves once the daemon has rendered it. */
  async previewSet(serial: string, key: number, button: ButtonDef): Promise<void> {
    await this.request('preview.set', { serial, key, button });
  }

  /** Clear one previewed key, or every preview on the deck. */
  async previewClear(serial: string, key?: number): Promise<void> {
    await this.request('preview.clear', key === undefined ? { serial } : { serial, key });
  }

  /** Make a profile active on the decks (scope §10, live switching). */
  async switchProfile(to: string): Promise<SwitchResult> {
    return (await this.request('profile.switch', { to })) as SwitchResult;
  }

  /**
   * Show a page on one deck, by page ID. Uses action.run with a page action —
   * the M3 socket has no page command, and this needs none (confirmed against
   * the harness, docs/scope.md §10). Like every socket action it gets "busy"
   * while another socket action runs.
   */
  async showPage(serial: string, page: string): Promise<void> {
    await this.request('action.run', { serial, action: { type: 'page', to: page } });
  }

  /** When the daemon last loaded config.json, or null if not known. */
  lastReloadAt(): string | null {
    return this.current.status?.config.lastReload.at ?? null;
  }

  /**
   * Resolve with the first config load reported after `since` (a lastReload
   * time read earlier), or null after `timeoutMs`. Read `since` before writing
   * the file, so a fast reload cannot be missed.
   */
  waitForReloadAfter(since: string | null, timeoutMs: number): Promise<ReloadResult | null> {
    const now = this.current.status?.config.lastReload;
    if (now && now.at !== since) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter = {
        since,
        resolve: (result: ReloadResult | null) => {
          clearTimeout(waiter.timer);
          this.reloadWaiters.delete(waiter);
          resolve(result);
        },
        timer: setTimeout(() => waiter.resolve(null), timeoutMs),
      };
      this.reloadWaiters.add(waiter);
    });
  }

  private update(change: Partial<DaemonView>): void {
    this.current = { ...this.current, ...change };
    const reload = this.current.status?.config.lastReload;
    if (reload) {
      for (const waiter of [...this.reloadWaiters]) if (reload.at !== waiter.since) waiter.resolve(reload);
    }
    this.onChange(this.current);
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.socketPath === null) {
      this.update({ connected: false, problem: 'the daemon socket is unavailable: $XDG_RUNTIME_DIR is not set', status: null, decks: null, audio: null });
      return; // nothing to retry: the path will not appear
    }
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(socket, chunk));
    socket.once('connect', () => void this.handshake(socket));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (socket !== this.socket) return;
      // Only the reason is recorded here. 'close' always follows 'error' and
      // is the one place that marks the client disconnected and drops the
      // daemon's state, so the view never says "disconnected" with stale state.
      this.lastError =
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? 'Deckhand is not running (check: systemctl --user status deckhand)'
          : `cannot reach the daemon: ${err.message}`;
    });
    socket.on('close', () => this.closed(socket));
  }

  private async handshake(socket: net.Socket): Promise<void> {
    try {
      await this.request('subscribe', { events: ['state', 'config', 'audio'] });
      const status = (await this.request('status')) as StatusResult;
      const decks = (await this.request('decks')) as DecksResult;
      const audio = await this.readAudio();
      if (socket !== this.socket) return;
      this.retryMs = this.retryInitialMs;
      this.update({ connected: true, problem: null, status, decks, audio });
    } catch (err) {
      if (socket !== this.socket) return;
      this.update({ connected: false, problem: `the daemon did not answer: ${(err as Error).message}` });
      socket.destroy();
    }
  }

  private closed(socket: net.Socket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    for (const waiter of this.waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new DaemonError('closed', 'the connection to the daemon closed'));
    }
    this.waiting.clear();
    this.update({
      connected: false,
      problem: this.lastError ?? this.current.problem ?? 'the connection to the daemon closed',
      status: null,
      decks: null,
      audio: null,
    });
    this.lastError = null;
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.retryMaxMs);
  }

  private request(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new DaemonError('not_connected', 'not connected to the daemon'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DaemonError('timeout', `no reply to "${cmd}" within ${this.replyTimeoutMs / 1000} s`));
      }, this.replyTimeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      // Never awaited: a slow daemon must not hold up the editor, and the
      // daemon drops a client that stops reading, not one that writes.
      socket.write(JSON.stringify(args === undefined ? { id, cmd } : { id, cmd, args }) + '\n');
    });
  }

  private receive(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.event === 'string') {
        this.event(message.event, message.data);
        continue;
      }
      const reply = message as unknown as Reply;
      if (reply.id === null && reply.ok === false) {
        // Not tied to a request, e.g. too_many_connections before a close.
        this.update({ problem: `the daemon refused the connection: ${reply.error?.message ?? 'unknown reason'}` });
        continue;
      }
      const waiter = typeof reply.id === 'number' ? this.waiting.get(reply.id) : undefined;
      if (!waiter) continue;
      this.waiting.delete(reply.id as number);
      clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply.result);
      else waiter.reject(new DaemonError(reply.error?.code ?? 'unknown', reply.error?.message ?? 'unknown error'));
    }
  }

  private event(name: string, data: unknown): void {
    const status = this.current.status;
    if (!status) return; // before the handshake finished; status will be fresh
    if (name === 'state') {
      const snapshot = data as StateSnapshot;
      this.update({ status: { ...status, activeProfile: snapshot.activeProfile, decks: snapshot.decks } });
      const connected = snapshot.decks.filter((d) => d.connected).map((d) => d.serial).sort().join(',');
      const known = (this.current.decks ?? []).map((d) => d.serial).sort().join(',');
      if (connected !== known) void this.refreshDecks();
    } else if (name === 'config') {
      this.update({ status: { ...status, config: { ...status.config, lastReload: data as ReloadResult } } });
    } else if (name === 'audio') {
      this.update({ audio: data as { sinks: AudioList; sources: AudioList } });
    }
  }

  /**
   * Both device lists, or null if the daemon has not read its audio state yet
   * (it answers "internal" then). The "audio" event fills them in later, when
   * the state first changes.
   */
  private async readAudio(): Promise<{ sinks: AudioList; sources: AudioList } | null> {
    try {
      const sinks = (await this.request('audio.sinks')) as AudioList;
      const sources = (await this.request('audio.sources')) as AudioList;
      return { sinks, sources };
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'internal') return null;
      throw err;
    }
  }

  private async refreshDecks(): Promise<void> {
    try {
      const decks = (await this.request('decks')) as DecksResult;
      if (this.current.connected) this.update({ decks });
    } catch {
      // A closed connection reconnects and re-reads decks in the handshake.
    }
  }
}
