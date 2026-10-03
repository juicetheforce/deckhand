/**
 * The server side of a WebSocket, frame by frame, for the tests' fake
 * servers (fake-obs.mjs, fake-vts.mjs). Node has a WebSocket client but no
 * server, so it is written here, as RFC 6455 says: frames from us unmasked,
 * frames from a client masked. No dependency.
 */

export function closeSocket(socket, code, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  writeFrame(socket, 0x8, payload);
  socket.end();
}

export function writeFrame(socket, opcode, payload) {
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

/** One whole frame from the front of the buffer, unmasked, or null if it has not all arrived. `fin`: the last frame of its message. */
export function readFrame(buffer) {
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
  return { opcode, fin: (buffer[0] & 0x80) !== 0, payload, length: offset + length };
}

/**
 * A text message split into frames of at most `size` bytes, as VTube
 * Studio's server (websocket-sharp) sends anything over 1016 bytes: the
 * first frame text with FIN clear, the rest continuations, FIN on the last.
 */
export function writeFragmented(socket, text, size = 1016) {
  const payload = Buffer.from(text);
  if (payload.length <= size) return writeFrame(socket, 0x1, payload);
  if (socket.destroyed || socket.writableEnded) return;
  for (let at = 0; at < payload.length; at += size) {
    const part = payload.subarray(at, at + size);
    const fin = at + size >= payload.length;
    const opcode = at === 0 ? 0x1 : 0x0;
    const header = part.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, part.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, part.length >> 8, part.length & 0xff]);
    socket.write(Buffer.concat([header, part]));
  }
}
