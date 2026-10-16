#!/usr/bin/env node
/**
 * A stand-in for deckhand-panel (panel/panel.c): the same protocol, no
 * screen. Point the daemon at it with DECKHAND_PANEL_BIN.
 *
 *   FAKE_PANEL_LOG       file: one JSON line per frame received
 *                        ({ type, … }) and per start ({ type: 'start', output })
 *   FAKE_PANEL_SIZE      "1920x720" (default): the size it reports as ready
 *   FAKE_PANEL_ACK_MS    delay before each "drawn", so a test can pile up draws
 *   FAKE_PANEL_FAIL      "no-output": exits 2 at once, as the real one does for
 *                        an output it cannot find
 *
 * SIGUSR1: report a resize (ready again). SIGUSR2: exit 3, as when the output
 * goes away.
 */
import fs from 'node:fs';

const log = process.env.FAKE_PANEL_LOG;
const record = (entry) => {
  if (log) fs.appendFileSync(log, JSON.stringify(entry) + '\n');
};
const output = process.argv[process.argv.indexOf('--output') + 1];
const [width, height] = (process.env.FAKE_PANEL_SIZE ?? '1920x720').split('x').map(Number);
const ackMs = Number(process.env.FAKE_PANEL_ACK_MS ?? 0);
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');

record({ type: 'start', output, pid: process.pid });
if (process.env.FAKE_PANEL_FAIL === 'no-output') {
  say({ ev: 'error', message: `no output named ${output}` });
  process.exit(2);
}
const ready = () => say({ ev: 'ready', output, width, height, scale: 1, transform: 0, surface: 'layer-shell' });
ready();

process.on('SIGUSR1', ready);
process.on('SIGUSR2', () => {
  say({ ev: 'error', message: 'the output went away' });
  process.exit(3);
});

let buffer = Buffer.alloc(0);
let acks = Promise.resolve();
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 5) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const type = String.fromCharCode(buffer[4]);
    const body = buffer.subarray(5, 4 + length);
    buffer = buffer.subarray(4 + length);
    if (type === 'K') {
      record({ type, width: body.readUInt32LE(0), height: body.readUInt32LE(4), background: [body[8], body[9], body[10]] });
    } else if (type === 'I') {
      const w = body.readUInt32LE(8);
      const h = body.readUInt32LE(12);
      const px = body.subarray(16);
      // The first pixel, for checking what was drawn without logging megabytes.
      record({ type, x: body.readInt32LE(0), y: body.readInt32LE(4), w, h, bytes: px.length, first: [...px.subarray(0, 4)] });
      acks = acks.then(() => new Promise((resolve) => setTimeout(resolve, ackMs))).then(() => say({ ev: 'drawn' }));
    } else if (type === 'C') {
      record({ type });
    } else if (type === 'Q') {
      record({ type });
      acks.then(() => process.exit(0));
    }
  }
});
process.stdin.on('end', () => acks.then(() => process.exit(0)));
