/**
 * The frames the daemon sends deckhand-panel on its stdin (panel/panel.c has
 * the whole protocol): u32 length of what follows, u8 type, then the body,
 * little-endian. Pure, so the tests encode exactly what the daemon does.
 */

/** A frame's first five bytes: the length of what follows them, and the type. */
function frameHead(type: string, bodyLength: number): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(bodyLength + 1, 0);
  head.write(type, 4, 'latin1');
  return head;
}

function frame(type: string, body: Buffer): Buffer {
  return Buffer.concat([frameHead(type, body.length), body]);
}

/** The panel's canvas: its size in its own units and its background. Clears the screen. */
export function canvasFrame(width: number, height: number, background: [number, number, number] = [0, 0, 0]): Buffer {
  const body = Buffer.alloc(11);
  body.writeUInt32LE(width, 0);
  body.writeUInt32LE(height, 4);
  body[8] = background[0];
  body[9] = background[1];
  body[10] = background[2];
  return frame('K', body);
}

/** One key's image, RGBA, at its place on the canvas. */
export function imageFrame(x: number, y: number, width: number, height: number, rgba: Buffer): Buffer {
  return Buffer.concat(imageFrameParts(x, y, width, height, rgba));
}

/**
 * imageFrame() as two chunks to write one after the other: its 21-byte head,
 * and the pixels themselves, not copied. What the driver sends: a copy of
 * every key's pixels on every draw — two, by concatenation — was garbage
 * enough to hold the daemon's memory ~60 MB higher on a panel whose output
 * keeps going away, as each time it comes back every key is drawn again (a
 * probe of 1,200 cycles, 24 keys of 211 px: a plateau of 180 MB, against 118).
 */
export function imageFrameParts(x: number, y: number, width: number, height: number, rgba: Buffer): [Buffer, Buffer] {
  if (rgba.length !== width * height * 4) throw new Error(`an image of ${width}×${height} needs ${width * height * 4} bytes, not ${rgba.length}`);
  const place = Buffer.alloc(16);
  place.writeInt32LE(Math.round(x), 0);
  place.writeInt32LE(Math.round(y), 4);
  place.writeUInt32LE(width, 8);
  place.writeUInt32LE(height, 12);
  return [Buffer.concat([frameHead('I', place.length + rgba.length), place]), rgba];
}

export const clearFrame = (): Buffer => frame('C', Buffer.alloc(0));
export const quitFrame = (): Buffer => frame('Q', Buffer.alloc(0));

/**
 * The touch devices to read: mode 1 a deck (each grabbed; 't' the
 * touchscreen, whose contacts are reported, 's' a sibling only grabbed),
 * mode 2 pairing (each 't' read without a grab, the first touched named), 0
 * none. Replaces whatever was read before.
 */
export function touchFrame(mode: 0 | 1 | 2, entries: ReadonlyArray<readonly ['t' | 's', string]>): Buffer {
  const parts = [Buffer.from([mode])];
  for (const [role, path] of entries) parts.push(Buffer.from(role, 'latin1'), Buffer.from(path, 'utf8'), Buffer.from([0]));
  return frame('T', Buffer.concat(parts));
}
