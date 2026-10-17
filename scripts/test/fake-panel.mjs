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
 *   FAKE_PANEL_INPUT_DIR directory: the fake listens on <dir>/<output>.sock,
 *                        and every line a test writes there it says on
 *                        stdout, as the real helper reports touches
 *                        ({"ev":"touch",…}, {"ev":"tap",…}, {"ev":"touch-gone",…})
 *   FAKE_PANEL_TOUCH     "open" (default): answers a touch frame with
 *                        "touch-open" for each device; "fail": "touch-failed"
 *
 * SIGUSR1: report a resize (ready again). SIGUSR2: the output goes away
 * ("output-lost"), as KWin does when a screen wakes; SIGHUP: it is back
 * (ready again). The real helper waits for its output rather than exiting.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

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

let server = null;
if (process.env.FAKE_PANEL_INPUT_DIR) {
  const sock = path.join(process.env.FAKE_PANEL_INPUT_DIR, `${output}.sock`);
  fs.rmSync(sock, { force: true });
  server = net.createServer((conn) => {
    let text = '';
    conn.on('data', (chunk) => {
      text += chunk;
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        process.stdout.write(text.slice(0, nl + 1));
        text = text.slice(nl + 1);
      }
    });
  });
  server.listen(sock);
  server.unref();
}
process.on('SIGUSR2', () => say({ ev: 'output-lost' }));
process.on('SIGHUP', () => ready());

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
    } else if (type === 'T') {
      const entries = [];
      let at = 1;
      while (at < body.length) {
        const role = String.fromCharCode(body[at]);
        const end = body.indexOf(0, at + 1);
        entries.push([role, body.subarray(at + 1, end).toString()]);
        at = end + 1;
      }
      record({ type, mode: body[0], entries });
      for (const [role, device] of entries) {
        if (body[0] === 2 && role !== 't') continue;
        if (process.env.FAKE_PANEL_TOUCH === 'fail') say({ ev: 'touch-failed', device, message: `cannot open ${device}: Permission denied` });
        else say({ ev: 'touch-open', device });
      }
    } else if (type === 'C') {
      record({ type });
    } else if (type === 'Q') {
      record({ type });
      acks.then(() => process.exit(0));
    }
  }
});
process.stdin.on('end', () => acks.then(() => process.exit(0)));
