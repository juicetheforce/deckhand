import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * The control socket: newline-delimited JSON over a Unix stream socket
 * (docs/scope.md §7, "M3 protocol design"). This file is transport only —
 * framing, limits, connections. What each command does is in commands.ts.
 *
 * Everything here runs on the same thread that handles deck key presses, so
 * nothing in it may block or wait on a client. See "Stall protections" in
 * §7 for why each limit below exists.
 */

export const PROTOCOL_VERSION = 1;

/** Stall protection 1 and 3: an inbound line, and a half-sent one, stay small. */
export const MAX_LINE_BYTES = 64 * 1024;
/** Stall protection 2: a client whose unsent output passes this has stopped reading. */
export const MAX_BACKLOG_BYTES = 1024 * 1024;
/** Stall protection 7. */
export const MAX_CONNECTIONS = 16;

export type ErrorCode =
  | 'bad_json'
  | 'bad_request'
  | 'unknown_command'
  | 'not_found'
  | 'deck_not_connected'
  | 'busy'
  | 'action_failed'
  | 'render_failed'
  | 'line_too_long'
  | 'too_many_connections'
  | 'internal';

/** Thrown by a command handler to send a specific error code back. */
export class ControlError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type EventName = 'state' | 'config' | 'audio';
export const EVENT_NAMES: readonly EventName[] = ['state', 'config', 'audio'];

type RequestId = string | number | null;

function failure(id: RequestId, code: ErrorCode, message: string) {
  return { id, ok: false, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One connected client. */
export class Connection {
  readonly id: number;
  /** Events this client asked for with "subscribe". */
  subscriptions = new Set<EventName>();
  private socket: net.Socket;
  private cleanups: Array<() => void> = [];

  constructor(id: number, socket: net.Socket) {
    this.id = id;
    this.socket = socket;
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  /**
   * Queue a message. Never waits: waiting on a client that has stopped
   * reading would wait forever. If the unsent backlog grows past the limit,
   * the client is disconnected instead of buffered for without end.
   */
  send(message: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(JSON.stringify(message) + '\n');
    if (this.socket.writableLength > MAX_BACKLOG_BYTES) {
      console.warn(
        `[control] connection ${this.id} is not reading ` +
          `(${this.socket.writableLength} bytes unsent); disconnecting`,
      );
      this.socket.destroy();
    }
  }

  /** Run when the connection closes, however it closes. */
  onClose(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  runCleanups(): void {
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[control] cleanup for connection ${this.id} failed: ${(err as Error).message}`);
      }
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export type Handler = (args: Record<string, unknown>, connection: Connection) => Promise<unknown>;

/** The socket path: $DECKHAND_SOCKET if set (tests, the CLI), else $XDG_RUNTIME_DIR/deckhand.sock. */
export function socketPath(): string | null {
  if (process.env.DECKHAND_SOCKET) return process.env.DECKHAND_SOCKET;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return runtimeDir ? path.join(runtimeDir, 'deckhand.sock') : null;
}

/**
 * Make the path usable. A leftover socket from a daemon that crashed is
 * removed; a socket something still answers on belongs to another daemon and
 * is left alone; anything that is not a socket is never deleted.
 */
async function prepareSocketPath(socketFile: string): Promise<'ready' | 'in-use' | 'not-a-socket'> {
  let stat;
  try {
    stat = await fs.lstat(socketFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'ready';
    throw err;
  }
  if (!stat.isSocket()) return 'not-a-socket';

  const answered = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketFile);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (answered) return 'in-use';

  await fs.unlink(socketFile);
  return 'ready';
}

export class ControlServer {
  private handlers: Record<string, Handler>;
  private server: net.Server | null = null;
  private connections = new Set<Connection>();
  private nextConnectionId = 1;
  private socketFile: string | null = null;

  constructor(handlers: Record<string, Handler>) {
    this.handlers = handlers;
  }

  /**
   * Listen on the socket. Returns false — after logging why — if the socket
   * cannot be used. The daemon carries on either way: the socket must never
   * be able to take the decks down.
   */
  async start(socketFile: string): Promise<boolean> {
    // Linux limits a socket path to 107 bytes (sun_path is 108 with the
    // terminator). Past that, listen() fails with a bare EINVAL.
    if (Buffer.byteLength(socketFile) > 107) {
      console.error(`[control] socket path is longer than 107 bytes, which Linux does not allow: ${socketFile}. No control socket.`);
      return false;
    }
    try {
      const state = await prepareSocketPath(socketFile);
      if (state === 'in-use') {
        console.error(`[control] ${socketFile} is in use by another process — is another deckhand running? No control socket.`);
        return false;
      }
      if (state === 'not-a-socket') {
        console.error(`[control] ${socketFile} exists and is not a socket; not touching it. No control socket.`);
        return false;
      }

      const server = net.createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketFile, () => {
          server.off('error', reject);
          resolve();
        });
      });
      // The runtime directory is already private (mode 700), so there is no
      // window in which another user could connect before this.
      await fs.chmod(socketFile, 0o600);
      server.on('error', (err) => console.error(`[control] server error: ${err.message}`));

      this.server = server;
      this.socketFile = socketFile;
      console.log(`[control] listening on ${socketFile}`);
      return true;
    } catch (err) {
      console.error(`[control] cannot listen on ${socketFile}: ${(err as Error).message}. No control socket.`);
      return false;
    }
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketFile) {
      await fs.unlink(this.socketFile).catch(() => undefined);
      this.socketFile = null;
    }
  }

  /** Send an event to every connection subscribed to it. */
  broadcast(event: EventName, data: unknown): void {
    for (const connection of this.connections) {
      if (connection.subscriptions.has(event)) connection.send({ event, data });
    }
  }

  private pendingEvents = new Map<EventName, () => unknown>();
  private flushScheduled = false;

  /**
   * Broadcast an event once this turn of the event loop is over. Several
   * notifications of the same event in one turn — a profile switch repaints
   * two decks and changes the active profile — become one event carrying the
   * state after all of them. setImmediate, not a timer: nothing is scheduled
   * unless something changed.
   */
  notify(event: EventName, snapshot: () => unknown): void {
    this.pendingEvents.set(event, snapshot);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const pending = [...this.pendingEvents];
      this.pendingEvents.clear();
      for (const [name, take] of pending) {
        if ([...this.connections].some((c) => c.subscriptions.has(name))) this.broadcast(name, take());
      }
    });
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private accept(socket: net.Socket): void {
    // A client vanishing mid-write (ECONNRESET, EPIPE) is normal, not an error
    // worth logging; 'close' follows and does the cleanup.
    socket.on('error', () => undefined);

    if (this.connections.size >= MAX_CONNECTIONS) {
      socket.end(
        JSON.stringify(failure(null, 'too_many_connections', `at most ${MAX_CONNECTIONS} connections`)) + '\n',
      );
      return;
    }

    const connection = new Connection(this.nextConnectionId++, socket);
    this.connections.add(connection);

    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      let newline: number;
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.length > MAX_LINE_BYTES) return rejectLongLine();
        this.handleLine(connection, line.toString('utf8'));
      }
      // No newline yet: a line still being sent may not grow past the limit either.
      if (buffered.length > MAX_LINE_BYTES) rejectLongLine();
    };
    const rejectLongLine = () => {
      socket.off('data', onData);
      buffered = Buffer.alloc(0);
      connection.send(failure(null, 'line_too_long', `a request line may be at most ${MAX_LINE_BYTES} bytes`));
      socket.end(() => socket.destroy());
    };
    socket.on('data', onData);

    socket.on('close', () => {
      this.connections.delete(connection);
      connection.runCleanups();
    });
  }

  private handleLine(connection: Connection, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch (err) {
      connection.send(failure(null, 'bad_json', `not valid JSON: ${(err as Error).message}`));
      return;
    }
    if (!isObject(request)) {
      connection.send(failure(null, 'bad_request', 'a request must be a JSON object'));
      return;
    }

    const id = request.id;
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) {
      connection.send(failure(null, 'bad_request', '"id" must be a string or a number'));
      return;
    }
    if (typeof request.cmd !== 'string') {
      connection.send(failure(id, 'bad_request', '"cmd" must be a string'));
      return;
    }
    const args = request.args ?? {};
    if (!isObject(args)) {
      connection.send(failure(id, 'bad_request', '"args" must be an object'));
      return;
    }
    const cmd = request.cmd;
    if (!Object.prototype.hasOwnProperty.call(this.handlers, cmd)) {
      connection.send(failure(id, 'unknown_command', `no command "${cmd}"`));
      return;
    }

    // Not awaited: requests on one connection run concurrently, and their
    // responses are matched by id.
    Promise.resolve()
      .then(() => this.handlers[cmd](args, connection))
      .then(
        (result) => connection.send({ id, ok: true, result: result ?? {} }),
        (err: unknown) => {
          if (err instanceof ControlError) {
            connection.send(failure(id, err.code, err.message));
          } else {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[control] "${cmd}" failed unexpectedly: ${message}`);
            connection.send(failure(id, 'internal', message));
          }
        },
      );
  }
}
