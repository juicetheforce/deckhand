#!/usr/bin/env node
/**
 * Stands in for `deckhand-panel --idle`: says what a test signals it to, and logs
 * how it was started to FAKE_IDLE_LOG. SIGUSR1: idle, dim. SIGUSR2: idle, sleep.
 * SIGHUP: resumed. FAKE_IDLE_UNAVAILABLE: a desktop without the protocol. It quits
 * when stdin closes, as the real one does.
 */
import { appendFileSync } from 'node:fs';

const log = (line) => process.env.FAKE_IDLE_LOG && appendFileSync(process.env.FAKE_IDLE_LOG, `${line}\n`);
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const args = process.argv.slice(2);
// Before the log line a test waits for: a signal must never arrive with nothing listening.
process.on('SIGUSR1', () => say({ ev: 'idled', level: 'dim' }));
process.on('SIGUSR2', () => say({ ev: 'idled', level: 'sleep' }));
process.on('SIGHUP', () => {
  say({ ev: 'resumed', level: 'dim' });
  say({ ev: 'resumed', level: 'sleep' });
});
log(`${process.pid} ${args.join(' ')}`);
if (process.env.FAKE_IDLE_UNAVAILABLE) {
  say({ ev: 'unavailable' });
  process.exit(3);
}
if (args[0] === '--idle-probe') {
  say({ ev: 'available' });
  process.exit(0);
}
say({ ev: 'ready' });
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
