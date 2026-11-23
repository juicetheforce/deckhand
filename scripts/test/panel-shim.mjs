#!/usr/bin/env node
/**
 * The real display helper with a fake touchscreen, for tests that need what
 * the screen really shows (smoke-brightness-drag): run as DECKHAND_PANEL_BIN,
 * it starts PANEL_SHIM_BIN (panel/deckhand-panel) with the daemon's arguments
 * and passes every frame through, except:
 *
 * - 'T' (touch): not passed on — there is no touchscreen — and answered
 *   "touch-open" for each device, as the real helper answers one it opened;
 * - lines written to <PANEL_SHIM_INPUT_DIR>/<output>.sock are said on stdout
 *   as if the helper said them: a test's touches ("down", "move", "up").
 *
 * The helper's own lines go to stdout as they come. PANEL_SHIM_PRESENT_LOG
 * adds --present-log to its arguments; PANEL_SHIM_PID_FILE receives its pid.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
if (process.env.PANEL_SHIM_PRESENT_LOG) args.push('--present-log', process.env.PANEL_SHIM_PRESENT_LOG);
const helper = spawn(process.env.PANEL_SHIM_BIN, args, { stdio: ['pipe', 'pipe', 'inherit'] });
if (process.env.PANEL_SHIM_PID_FILE) fs.writeFileSync(process.env.PANEL_SHIM_PID_FILE, String(helper.pid));

// One writer for stdout: the helper's lines and the test's, never interleaved mid-line.
let pendingOut = '';
helper.stdout.on('data', (chunk) => {
  pendingOut += chunk;
  const nl = pendingOut.lastIndexOf('\n');
  if (nl < 0) return;
  process.stdout.write(pendingOut.slice(0, nl + 1));
  pendingOut = pendingOut.slice(nl + 1);
});
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');

let server = null;
if (process.env.PANEL_SHIM_INPUT_DIR) {
  const sock = path.join(process.env.PANEL_SHIM_INPUT_DIR, `${output}.sock`);
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

// Streamed as it comes, so the helper reads a large frame piece by piece as it would from the daemon;
// only a 'T' frame is held until whole, answered, and dropped.
let header = Buffer.alloc(0);
let remaining = 0;
let touch = null;
// The helper's pipe pushes back as the daemon's would: stop reading while it is full.
const forward = (bytes) => {
  if (!helper.stdin.write(bytes)) {
    process.stdin.pause();
    helper.stdin.once('drain', () => process.stdin.resume());
  }
};
const answerTouch = (body) => {
  let i = 1;
  while (i < body.length) {
    const role = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    const device = body.subarray(i + 1, end).toString();
    if (body[0] === 1 || (body[0] === 2 && role === 't')) say({ ev: 'touch-open', device });
    i = end + 1;
  }
};
process.stdin.on('data', (chunk) => {
  let at = 0;
  while (at < chunk.length) {
    if (remaining > 0) {
      const n = Math.min(remaining, chunk.length - at);
      if (touch) touch.push(chunk.subarray(at, at + n));
      else forward(chunk.subarray(at, at + n));
      remaining -= n;
      at += n;
      if (remaining === 0 && touch) {
        answerTouch(Buffer.concat(touch));
        touch = null;
      }
      continue;
    }
    const need = 5 - header.length;
    header = Buffer.concat([header, chunk.subarray(at, at + need)]);
    at += Math.min(need, chunk.length - at);
    if (header.length < 5) break;
    const length = header.readUInt32LE(0);
    const type = String.fromCharCode(header[4]);
    remaining = length - 1;
    if (type === 'T') touch = [];
    else forward(header);
    header = Buffer.alloc(0);
    if (remaining === 0 && touch) {
      answerTouch(Buffer.alloc(0));
      touch = null;
    }
  }
});
process.stdin.on('end', () => helper.stdin.end());
// The driver stops a helper that will not quit with SIGTERM: it reaches the real one too, never orphaned.
process.on('SIGTERM', () => {
  helper.kill('SIGTERM');
  process.exit(143);
});
helper.on('exit', (code) => {
  server?.close();
  if (pendingOut) process.stdout.write(pendingOut);
  process.exit(code ?? 1);
});
