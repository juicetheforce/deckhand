#!/usr/bin/env node
/**
 * A stand-in for helper/deckhand-input, for offline tests. It speaks the same
 * line protocol (READY, then TAP / DOWN / UP / PING, each answered OK), takes
 * the same time as the real helper for each command, and never touches
 * /dev/uinput. Instead it records every command, with the time it arrived and
 * finished and which keycodes are down afterwards, as JSON lines in the file
 * named by FAKE_INPUT_LOG.
 *
 * Timings copied from helper/deckhand-input.c: a single key uses
 * CHAIN_DELAY_US 1.5 ms and TAP_DELAY_US 12 ms; a combo uses COMBO_GAP_US
 * 30 ms and COMBO_HOLD_US 50 ms. Keep them in step if the C file changes.
 */
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const LOG = process.env.FAKE_INPUT_LOG;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const down = new Set();

function log(entry) {
  if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

process.stdout.write('READY\n');

// Commands are handled strictly one after another, as the real helper does.
const lines = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on('line', (line) => {
  chain = chain.then(() => handle(line));
});
lines.on('close', () => {
  chain.then(() => process.exit(0));
});

async function handle(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  const arrived = Date.now();
  if (cmd === 'PING') {
    process.stdout.write('OK\n');
    return;
  }
  const codes = rest.map(Number);
  if (codes.length === 0 || codes.some((c) => !Number.isInteger(c))) {
    process.stdout.write('ERR bad-codes\n');
    return;
  }
  const combo = codes.length > 1;
  const gap = combo ? 30 : 1.5;
  const hold = combo ? 50 : 12;

  if (cmd === 'TAP') {
    for (const code of codes) {
      down.add(code);
      await sleep(gap);
    }
    await sleep(hold);
    for (let i = codes.length - 1; i >= 0; i--) {
      down.delete(codes[i]);
      if (i > 0) await sleep(gap);
    }
  } else if (cmd === 'DOWN') {
    for (const code of codes) {
      down.add(code);
      await sleep(gap);
    }
  } else if (cmd === 'UP') {
    for (let i = codes.length - 1; i >= 0; i--) {
      down.delete(codes[i]);
      if (i > 0) await sleep(gap);
    }
  } else {
    process.stdout.write('ERR unknown-command\n');
    return;
  }
  log({ cmd, codes, arrived, finished: Date.now(), down: [...down].sort((a, b) => a - b) });
  process.stdout.write('OK\n');
}
