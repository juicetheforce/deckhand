import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { PANEL_BIN } from '../drivers/virtual.js';
import { Recovery } from '../recovery.js';
import { sleep, type IdleLevel } from '../sleep.js';

/**
 * Idle dimming's connection to the compositor: `deckhand-panel --idle`, which
 * asks for ext-idle-notify-v1's notifications and prints them (panel/idle.c).
 * The compositor counts, so nothing here is a timer. It runs only while dimming
 * is set and a Stream Deck is attached; otherwise nothing runs at all. A helper
 * that stops rides the 60-second scan after one quick retry (recovery.ts); one
 * that says the desktop lacks the protocol is not tried again until a change.
 */

let proc: ChildProcess | null = null;
let dimMs = 0;
let sleepMs = 0;
let decksAttached = false;
let unavailable = false;
const idled = new Set<IdleLevel>();

const recovery = new Recovery(() => start());

function report(): void {
  sleep.setIdle(idled.has('sleep') ? 'sleep' : idled.has('dim') ? 'dim' : null);
}

function wanted(): boolean {
  return decksAttached && (dimMs > 0 || sleepMs > 0) && !unavailable;
}

function start(): void {
  if (proc || !wanted()) return;
  recovery.started();
  const child = spawn(PANEL_BIN, ['--idle', String(dimMs), String(sleepMs)], { stdio: ['pipe', 'pipe', 'ignore'] });
  proc = child;
  child.on('error', (err) => console.error(`[idle] cannot start the helper: ${err.message}`));
  if (child.stdout) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event: { ev?: unknown; level?: unknown; message?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      const level = event.level === 'dim' || event.level === 'sleep' ? event.level : null;
      if (event.ev === 'idled' && level) idled.add(level);
      else if (event.ev === 'resumed' && level) idled.delete(level);
      else if (event.ev === 'unavailable') {
        unavailable = true;
        console.log('[idle] this desktop does not offer idle notifications; the decks still sleep when the screen locks');
        return;
      } else return;
      report();
    });
  }
  child.on('close', (code) => {
    if (proc !== child) return;
    proc = null;
    // Nobody says idle any more, so nothing stays dark on its word.
    idled.clear();
    report();
    if (unavailable) return;
    console.error(`[idle] the helper stopped (code=${code})`);
    recovery.lost();
  });
}

function stop(): void {
  recovery.cancel();
  const child = proc;
  proc = null;
  idled.clear();
  report();
  // Closing its stdin is what tells it to quit.
  child?.stdin?.end();
}

/** The settings, in seconds (0: off), and whether a Stream Deck is attached. Restarts it only for what changes its timeouts. */
export function configure(dimAfterSeconds: number, sleepAfterSeconds: number, attached: boolean): void {
  const dim = dimAfterSeconds * 1000;
  const sleepAfter = sleepAfterSeconds * 1000;
  const changed = dim !== dimMs || sleepAfter !== sleepMs;
  dimMs = dim;
  sleepMs = sleepAfter;
  decksAttached = attached;
  if (changed) unavailable = false;
  if (proc && (changed || !wanted())) stop();
  start();
}

/** The 60-second scan: start it again if it is gone. */
export function retry(): void {
  if (wanted()) recovery.retry();
}

/** Whether this desktop offers the protocol, for Settings: one short process, on request. Null if that cannot be told. */
export function probe(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const child = spawn(PANEL_BIN, ['--idle-probe'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const deadline = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 3000);
    child.on('error', () => {
      clearTimeout(deadline);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      resolve(code === 0 ? true : code === 3 ? false : null);
    });
  });
}
