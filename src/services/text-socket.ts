import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

/**
 * A WebSocket client for text messages, written on node:net — what VTube
 * Studio is reached by (services/vts-client.ts).
 *
 * **Not Node's own WebSocket**, which cannot talk to VTS (VTS session 1,
 * `[confirmed]`): VTS's server (websocket-sharp) accepts the
 * permessage-deflate Node's client always offers, and Node 24.18.0's client
 * then decodes the first message and gives every later one as an empty
 * string. This client offers no extension at all, so nothing is compressed.
 * VTS also splits messages over 1016 bytes into fragments, which are put
 * back together here.
 *
 * RFC 6455, as much as one text-only client of one known server needs: the
 * HTTP upgrade and its accept check, masked text frames out, text frames in
 * (fragmented or not), ping answered with pong, close answered and reported.
 * A binary message is not something VTS sends, and is dropped.
 *
 * The one timer is a one-shot deadline for the handshake; nothing recurs.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A message larger than this closes the connection: VTS's largest are a few kilobytes. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface TextSocketOptions {
  host: string;
  port: number;
  /** How long the TCP connection and the upgrade together may take. */
  timeoutMs: number;
  onMessage(text: string): void;
  /** The connection closed after it opened, by either side. Not called for a failed open. */
  onClose(): void;
}

export interface TextSocket {
  send(text: string): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * Open the connection and upgrade it. Rejects with the socket's error
 * (`ECONNREFUSED` when nothing listens) or an Error saying what the server
 * answered instead of an upgrade.
 */
export function openTextSocket(options: TextSocketOptions): Promise<TextSocket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');
    const socket = net.connect({ host: options.host, port: options.port });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let open = false;
    let settled = false;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let fragmentOp: number | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      reject(err);
    };
    const deadline = setTimeout(() => fail(new Error(`no WebSocket upgrade from ${options.host}:${options.port} within ${options.timeoutMs} ms`)), options.timeoutMs);

    const write = (opcode: number, payload: Buffer) => {
      if (socket.destroyed) return;
      // A client's frames are masked (RFC 6455 §5.3).
      const mask = randomBytes(4);
      let head: Buffer;
      if (payload.length < 126) {
        head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(payload.length, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([head, mask, masked]));
    };

    const api: TextSocket = {
      send: (text) => write(OP_TEXT, Buffer.from(text, 'utf8')),
      close: () => {
        if (!open) return;
        open = false;
        const code = Buffer.alloc(2);
        code.writeUInt16BE(1000, 0);
        write(OP_CLOSE, code);
        socket.end();
      },
      get isOpen() {
        return open;
      },
    };

    /** Read every whole frame in the buffer; false if the connection must close. */
    const readFrames = (): boolean => {
      while (buffer.length >= 2) {
        const fin = (buffer[0] & 0x80) !== 0;
        const rsv = buffer[0] & 0x70;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return true;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return true;
          const long = buffer.readBigUInt64BE(2);
          if (long > BigInt(MAX_MESSAGE_BYTES)) return false;
          length = Number(long);
          offset = 10;
        }
        // Nothing was negotiated, so a reserved bit set is a protocol error.
        if (rsv !== 0 || length > MAX_MESSAGE_BYTES) return false;
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + length) return true;
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + length);
        if (masked) {
          // A server's frames are not masked; unmask one anyway rather than misread it.
          const mask = buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        }
        buffer = buffer.subarray(offset + maskBytes + length);

        if (opcode === OP_PING) {
          write(OP_PONG, payload);
        } else if (opcode === OP_PONG) {
          // Nothing pings from here; an unsolicited pong is allowed and ignored.
        } else if (opcode === OP_CLOSE) {
          if (open) {
            open = false;
            write(OP_CLOSE, payload.subarray(0, 2));
          }
          socket.end();
          return true;
        } else if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONTINUATION) {
          if (opcode !== OP_CONTINUATION) {
            if (fragmentOp !== null) return false; // a new message before the last one finished
            fragmentOp = opcode;
          } else if (fragmentOp === null) {
            return false; // a continuation of nothing
          }
          fragments.push(Buffer.from(payload));
          fragmentBytes += payload.length;
          if (fragmentBytes > MAX_MESSAGE_BYTES) return false;
          if (fin) {
            const whole = Buffer.concat(fragments);
            const wasText = fragmentOp === OP_TEXT;
            fragments = [];
            fragmentBytes = 0;
            fragmentOp = null;
            if (wasText) options.onMessage(whole.toString('utf8'));
          }
        } else {
          return false; // an opcode RFC 6455 reserves
        }
      }
      return true;
    };

    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\n` +
          `Host: ${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffer.length > 16384) fail(new Error(`not a WebSocket server at ${options.host}:${options.port}`));
          return;
        }
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
        buffer = buffer.subarray(end + 4);
        const headers = new Map(lines.slice(1).map((line) => [line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
        if (!/^HTTP\/1\.1 101\b/.test(lines[0])) {
          fail(new Error(`${options.host}:${options.port} answered "${lines[0]}", not a WebSocket upgrade`));
          return;
        }
        if (headers.get('sec-websocket-accept') !== expectedAccept) {
          fail(new Error(`${options.host}:${options.port} answered the upgrade with the wrong Sec-WebSocket-Accept`));
          return;
        }
        // None was offered, so none may be used.
        if (headers.has('sec-websocket-extensions')) {
          fail(new Error(`${options.host}:${options.port} chose an extension that was not offered`));
          return;
        }
        upgraded = true;
        open = true;
        settled = true;
        clearTimeout(deadline);
        resolve(api);
      }
      if (!readFrames()) {
        open = false;
        socket.destroy();
      }
    });

    socket.on('error', (err) => fail(err));
    socket.on('close', () => {
      if (!settled) {
        fail(new Error(`${options.host}:${options.port} closed the connection before the upgrade`));
        return;
      }
      if (!upgraded) return;
      upgraded = false;
      open = false;
      options.onClose();
    });
  });
}
