/**
 * A fake OBS Studio for the tests: an obs-websocket v5 server on a port of
 * its own, speaking enough of the protocol for src/services/obs-client.ts and
 * src/services/obs.ts — Hello with an auth challenge, Identify checked against
 * the password (closing 4009 when wrong), requests answered from a small model
 * of OBS's outputs, and the events OBS sends when they change.
 *
 * Node has a WebSocket client but no server, so the server side is written
 * here: the HTTP upgrade, and text, close and ping frames — unmasked from us,
 * masked from the client, as RFC 6455 says. No dependency.
 *
 *   const obs = await startFakeObs({ password: 'secret' });
 *   obs.port; obs.requests; obs.connections; obs.identified;
 *   obs.setStream(true);   // as if OBS went live by itself: sends the events
 *   await obs.stop();      // as if OBS quit: closes every client, frees the port
 *
 * The protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sha256base64 = (text) => createHash('sha256').update(text).digest('base64');

export async function startFakeObs({ password = null, port = 0 } = {}) {
  const sockets = new Set();
  const obs = {
    port: 0,
    password,
    /** Every request received, in order: { type, data }. */
    requests: [],
    /** Connections accepted, and connections that got as far as Identified. */
    connections: 0,
    identified: 0,
    /** The last Identify's eventSubscriptions. */
    eventSubscriptions: null,
    streaming: false,
    recording: false,
    paused: false,
    setStream(on) {
      obs.streaming = on;
      broadcast('StreamStateChanged', { outputActive: on, outputState: on ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    },
    /** Clients connected right now. */
    get open() {
      return [...sockets].filter((s) => s.identifiedAt !== undefined).length;
    },
    stop,
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!key || !protocols.includes('obswebsocket.json')) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n` +
        'Sec-WebSocket-Protocol: obswebsocket.json\r\n\r\n',
    );
    obs.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const challenge = randomBytes(16).toString('base64');
    const salt = randomBytes(16).toString('base64');
    socket.auth = { challenge, salt };
    send(socket, 0, {
      obsStudioVersion: '32.1.1-fake',
      obsWebSocketVersion: '5.7.3',
      rpcVersion: 1,
      ...(obs.password ? { authentication: { challenge, salt } } : {}),
    });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x8) {
          closeSocket(socket, 1000);
          return;
        }
        if (frame.opcode === 0x9) writeFrame(socket, 0xa, frame.payload);
        if (frame.opcode === 0x1) onMessage(socket, JSON.parse(frame.payload.toString('utf8')));
      }
    });
  });

  function onMessage(socket, message) {
    const d = message.d ?? {};
    if (message.op === 1) {
      if (obs.password) {
        const expected = sha256base64(sha256base64(obs.password + socket.auth.salt) + socket.auth.challenge);
        if (d.authentication !== expected) {
          closeSocket(socket, 4009, 'Authentication failed.');
          return;
        }
      }
      obs.eventSubscriptions = d.eventSubscriptions;
      obs.identified++;
      socket.identifiedAt = Date.now();
      send(socket, 2, { negotiatedRpcVersion: 1 });
      return;
    }
    if (message.op !== 6 || socket.identifiedAt === undefined) return;
    obs.requests.push({ type: d.requestType, data: d.requestData });
    const reply = (ok, responseData, comment) =>
      send(socket, 7, {
        requestType: d.requestType,
        requestId: d.requestId,
        requestStatus: ok ? { result: true, code: 100 } : { result: false, code: 501, comment },
        ...(responseData ? { responseData } : {}),
      });
    switch (d.requestType) {
      case 'GetStreamStatus':
        return reply(true, { outputActive: obs.streaming, outputReconnecting: false, outputDuration: 0 });
      case 'GetRecordStatus':
        return reply(true, { outputActive: obs.recording, outputPaused: obs.paused });
      case 'StartStream':
        if (obs.streaming) return reply(false, null, 'The stream output is already running.');
        reply(true);
        broadcast('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
        obs.streaming = true;
        return broadcast('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
      case 'StopStream':
        if (!obs.streaming) return reply(false, null, 'The stream output is not running.');
        reply(true);
        broadcast('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
        obs.streaming = false;
        return broadcast('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      // The four states in the order a real OBS sends them, outputActive as it
      // reports it: STARTING false, STARTED true, STOPPING false, STOPPED false
      // (OBS 32.1.1, seen 2026-10-01; code-state, OBS session 1). Streaming is
      // given the same shape, unobserved.
      case 'ToggleRecord':
        obs.recording = !obs.recording;
        if (!obs.recording) obs.paused = false;
        reply(true, { outputActive: obs.recording });
        if (obs.recording) {
          broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
          return broadcast('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
        }
        broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
        return broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      case 'ToggleRecordPause':
        if (!obs.recording) return reply(false, null, 'The record output is not running.');
        obs.paused = !obs.paused;
        reply(true);
        return broadcast('RecordStateChanged', { outputActive: true, outputState: obs.paused ? 'OBS_WEBSOCKET_OUTPUT_PAUSED' : 'OBS_WEBSOCKET_OUTPUT_RESUMED' });
      default:
        return reply(false, null, `fake OBS does not know ${d.requestType}`);
    }
  }

  /** Events go to identified clients that asked for Outputs (1 << 6), as OBS's do. */
  function broadcast(eventType, eventData) {
    for (const socket of sockets) {
      if (socket.identifiedAt === undefined || !(obs.eventSubscriptions & (1 << 6))) continue;
      send(socket, 5, { eventType, eventIntent: 1 << 6, eventData });
    }
  }

  async function stop() {
    for (const socket of sockets) closeSocket(socket, 1001);
    await new Promise((resolve) => server.close(resolve));
  }

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  obs.port = server.address().port;
  return obs;
}

function send(socket, op, d) {
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify({ op, d })));
}

function closeSocket(socket, code, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  writeFrame(socket, 0x8, payload);
  socket.end();
}

function writeFrame(socket, opcode, payload) {
  if (socket.destroyed || socket.writableEnded) return;
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** One whole frame from the front of the buffer, unmasked, or null if it has not all arrived. */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
  return { opcode, payload, length: offset + length };
}
