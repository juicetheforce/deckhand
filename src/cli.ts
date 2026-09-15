import net from 'node:net';
import type { AudioList, DecksResult, StatusResult, SwitchResult } from './control/protocol.js';
import { socketPath } from './control/server.js';

/**
 * deckhand — command-line client for the daemon's control socket
 * (docs/scope.md §7, "CLI"). Installed as ~/.local/bin/deckhand by
 * scripts/install.sh, as a wrapper that runs this file.
 *
 * It only talks to the socket; it never touches the decks, the config file or
 * the service. Exit codes: 0 success, 1 the daemon answered with an error,
 * 2 usage error, 3 the daemon could not be reached or did not answer.
 */

const USAGE = `usage: deckhand <command> [--json]

  status                              what the daemon is doing
  decks                               connected decks and their keys
  profile <id or name>                switch the active profile
  repaint [serial]                    repaint one deck, or all
  run [--deck <serial>] '<action>'    run an action without saving it, e.g.
                                        deckhand run '{"type":"hotkey","keys":"ctrl+1"}'
  sinks                               audio outputs you can pick
  sources                             audio inputs you can pick
  watch                               print state, config and audio events until Ctrl+C
  raw '<request>'                     send one request as JSON and print the reply

  --json   print the daemon's reply as JSON instead of text`;

/** How long to wait for a reply. "run" may hold keys or type text, so it gets longer. */
const REPLY_TIMEOUT_MS = 10_000;
const RUN_REPLY_TIMEOUT_MS = 60_000;

class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Reply {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One connection to the daemon, sending requests and matching replies by id. */
class Client {
  private socket: net.Socket;
  private buffer = '';
  private nextId = 1;
  private waiting = new Map<unknown, (reply: Reply) => void>();
  onEvent: (message: { event: string; data: unknown }) => void = () => undefined;
  private closedWith: CliExit | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => {
      this.closedWith ??= new CliExit(3, 'the daemon closed the connection');
      for (const resolve of this.waiting.values()) resolve({ id: null, ok: false, error: { code: 'closed', message: this.closedWith.message } });
      this.waiting.clear();
    });
  }

  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      socket.once('connect', () => resolve(new Client(socket)));
      socket.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new CliExit(3, `Deckhand is not running (nothing listening on ${path}).\nCheck with: systemctl --user status deckhand`));
        } else {
          reject(new CliExit(3, `cannot connect to ${path}: ${err.message}`));
        }
      });
    });
  }

  private receive(chunk: string): void {
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
        this.onEvent(message as { event: string; data: unknown });
        continue;
      }
      const resolve = this.waiting.get(message.id);
      if (resolve) {
        this.waiting.delete(message.id);
        resolve(message as unknown as Reply);
      } else if (message.id === null && message.ok === false) {
        // An error the daemon could not tie to a request, e.g. too_many_connections.
        const error = message.error as Reply['error'];
        this.closedWith = new CliExit(3, `the daemon refused the connection: ${error?.message ?? 'unknown reason'}`);
      }
    }
  }

  /** Send a request; resolves with the reply, or rejects if none comes in time. */
  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = REPLY_TIMEOUT_MS): Promise<Reply> {
    return this.send({ cmd, args }, timeoutMs);
  }

  /** Send a request object as given, adding an id if it has none. */
  send(request: Record<string, unknown>, timeoutMs = REPLY_TIMEOUT_MS): Promise<Reply> {
    const id = request.id ?? `cli-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CliExit(3, `no reply from the daemon within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error?.code === 'closed') reject(this.closedWith ?? new CliExit(3, reply.error.message));
        else resolve(reply);
      });
      this.socket.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }

  close(): void {
    this.socket.end();
  }
}

/** The result of a successful reply; an error reply becomes exit code 1. */
function resultOf<T>(reply: Reply): T {
  if (!reply.ok) throw new CliExit(1, `error (${reply.error?.code}): ${reply.error?.message}`);
  return reply.result as T;
}

function parseJsonArgument(text: string | undefined, what: string): Record<string, unknown> {
  if (text === undefined) throw new CliExit(2, `missing ${what}\n\n${USAGE}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliExit(2, `${what} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliExit(2, `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function print(json: boolean, value: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text());
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const command = args[0];
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    throw new CliExit(command === undefined ? 2 : 0, USAGE);
  }
  const known = ['status', 'decks', 'profile', 'repaint', 'run', 'sinks', 'sources', 'watch', 'raw'];
  if (!known.includes(command)) throw new CliExit(2, `unknown command "${command}"\n\n${USAGE}`);

  const path = socketPath();
  if (path === null) throw new CliExit(3, 'XDG_RUNTIME_DIR is not set, so the control socket cannot be found.');
  if (Buffer.byteLength(path) > 107) {
    throw new CliExit(3, `the socket path is longer than the 107 bytes Linux allows: ${path}`);
  }
  const client = await Client.connect(path);

  try {
    switch (command) {
      case 'status': {
        const s = resultOf<StatusResult>(await client.request('status'));
        print(json, s, () => {
          const lines = [
            `active profile: ${s.activeProfile ? `${s.activeProfile.name ?? s.activeProfile.id} (${s.activeProfile.id})` : 'none'}`,
            `config: ${s.config.path}`,
            `last reload: ${s.config.lastReload.ok ? 'ok' : `REFUSED — ${s.config.lastReload.error}`} at ${s.config.lastReload.at}`,
          ];
          const b = s.config.backups;
          if (b) {
            const summary = b.count === 0 ? 'none yet' : `${b.count} kept, newest ${b.newest}`;
            lines.push(`backups: ${b.dir} (${summary})`);
            if (b.error) lines.push(`backups: LAST ATTEMPT FAILED — ${b.error}`);
          }
          lines.push('decks:');
          for (const d of s.decks) {
            const where = d.page !== undefined ? `profile ${d.profile}, page ${d.page}, brightness ${d.brightness}` : '';
            const flags = [d.connected ? 'connected' : 'not connected', d.configured ? '' : 'no layout'].filter(Boolean).join(', ');
            const previews = d.previews?.length ? `, previewing keys ${d.previews.join(' ')}` : '';
            lines.push(`  ${d.serial}  ${flags}${where ? ` — ${where}` : ''}${previews}`);
          }
          return lines.join('\n');
        });
        break;
      }
      case 'decks': {
        const decks = resultOf<DecksResult>(await client.request('decks'));
        print(json, decks, () =>
          decks.length === 0
            ? 'no decks connected'
            : decks
                .map(
                  (d) =>
                    `${d.serial}  ${d.productName} (${d.model}) — ${d.keyCount} keys, ${d.rows}×${d.columns}` +
                    `${d.iconSize ? `, ${d.iconSize} px` : ', no screens'}` +
                    `${d.unsupported.length ? `, ${d.unsupported.length} unsupported control(s)` : ''}`,
                )
                .join('\n'),
        );
        break;
      }
      case 'profile': {
        if (args[1] === undefined) throw new CliExit(2, `missing profile\n\n${USAGE}`);
        const r = resultOf<SwitchResult>(await client.request('profile.switch', { to: args[1] }));
        print(json, r, () => `${r.changed ? 'switched to' : 'already on'} ${r.active.name ?? r.active.id} (${r.active.id})`);
        break;
      }
      case 'repaint': {
        const r = resultOf<{ repainted: string[] }>(await client.request('repaint', args[1] === undefined ? {} : { serial: args[1] }));
        print(json, r, () => `repainted ${r.repainted.join(', ') || 'nothing (no decks)'}`);
        break;
      }
      case 'run': {
        let deck: string | undefined;
        const rest = args.slice(1);
        const deckFlag = rest.indexOf('--deck');
        if (deckFlag !== -1) {
          deck = rest[deckFlag + 1];
          if (deck === undefined) throw new CliExit(2, '--deck needs a serial');
          rest.splice(deckFlag, 2);
        }
        const action = parseJsonArgument(rest[0], 'action');
        if (deck === undefined) {
          const s = resultOf<StatusResult>(await client.request('status'));
          const running = s.decks.filter((d) => d.page !== undefined).map((d) => d.serial);
          if (running.length !== 1) {
            throw new CliExit(2, running.length === 0 ? 'no deck is running' : `several decks are running; pick one with --deck: ${running.join(', ')}`);
          }
          deck = running[0];
        }
        const r = resultOf<Record<string, never>>(await client.request('action.run', { serial: deck, action }, RUN_REPLY_TIMEOUT_MS));
        print(json, r, () => 'done');
        break;
      }
      case 'sinks':
      case 'sources': {
        const r = resultOf<AudioList>(await client.request(command === 'sinks' ? 'audio.sinks' : 'audio.sources'));
        print(json, r, () =>
          r.devices
            .map((d) => `${d.node === r.default ? '*' : ' '} ${d.label}${d.available === 'no' ? '  (unavailable)' : ''}\n    ${d.node}`)
            .join('\n'),
        );
        break;
      }
      case 'raw': {
        const request = parseJsonArgument(args[1], 'request');
        const reply = await client.send(request, RUN_REPLY_TIMEOUT_MS);
        console.log(JSON.stringify(reply, null, 2));
        if (!reply.ok) throw new CliExit(1, '');
        break;
      }
      case 'watch': {
        client.onEvent = (message) => {
          console.log(json ? JSON.stringify(message) : `${new Date().toISOString()} ${message.event} ${JSON.stringify(message.data)}`);
        };
        resultOf<{ events: string[] }>(await client.request('subscribe', { events: ['state', 'config', 'audio'] }));
        if (!json) console.error('watching; Ctrl+C to stop');
        await new Promise<never>(() => undefined);
      }
    }
  } finally {
    if (command !== 'watch') client.close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof CliExit) {
      if (err.message) (err.code === 0 ? console.log : console.error)(err.message);
      process.exit(err.code);
    }
    console.error(`deckhand: ${(err as Error).message}`);
    process.exit(1);
  },
);
