import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../backups.js';

/**
 * Virtual decks turned off: a screen that also runs widgets, given back to
 * the desktop. Off, the virtual driver leaves the deck out of every scan
 * (src/drivers/virtual.ts), so its session closes as an unplugged screen's
 * does — its helper quits, the touchscreen's grab ends and the desktop has
 * its touches again, every held key is let go — and nothing runs for it at
 * rest. Its pairing, its layouts and the touchscreen's access are kept, so
 * turning it on again is instant and asks for no password.
 *
 * **Off stays off across a restart, an update and a reboot**: turning a deck
 * off is the person's intent (Ryan, 2026-10-23). Kept in the state
 * directory (`virtual-off.json`), never config.json, which the daemon does
 * not write; read once at start, written on each change.
 */

/** Where the decks turned off are kept, beside the backups and credentials. */
export const OFF_PATH = path.join(STATE_DIR, 'virtual-off.json');

const off = new Set<string>();
const listeners = new Set<(deck: string) => void>();
/** The virtual decks the config has, by their key in "decks": set by src/index.ts. */
let known: () => ReadonlySet<string> = () => new Set();

export function setKnownDecks(decks: () => ReadonlySet<string>): void {
  known = decks;
}

/** Called with the deck whenever one is turned on or off. Returns the unsubscribe. */
export function subscribe(listener: (deck: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Read the decks turned off, at start, before the first scan. A file that is
 * missing is none; one that cannot be read is said and treated as none, so a
 * broken file can never leave a deck dark for good.
 */
export function load(): void {
  let text: string;
  try {
    text = readFileSync(OFF_PATH, 'utf8');
  } catch {
    return;
  }
  try {
    const saved = JSON.parse(text) as { off?: unknown };
    if (!Array.isArray(saved.off)) throw new Error('no "off" list');
    for (const deck of saved.off) if (typeof deck === 'string' && deck !== '') off.add(deck);
    if (off.size > 0) console.log(`[virtual] turned off, as left: ${[...off].join(', ')}`);
  } catch (err) {
    console.error(`[virtual] ignoring ${OFF_PATH}: ${(err as Error).message}`);
  }
}

/** One write at a time, each of the set as it is then, by temp file and rename. */
let writing: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  writing = writing.then(async () => {
    const temp = `${OFF_PATH}.${process.pid}.tmp`;
    try {
      await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
      await fs.writeFile(temp, JSON.stringify({ off: [...off].sort() }, null, 2) + '\n');
      await fs.rename(temp, OFF_PATH);
    } catch (err) {
      console.error(`[virtual] cannot keep which virtual decks are off (${OFF_PATH}): ${(err as Error).message}`);
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
  return writing;
}

/** Settled once every change so far is on disk: for the tests. */
export function saved(): Promise<void> {
  return writing;
}

export function isOff(deck: string): boolean {
  return off.has(deck);
}

/** The decks turned off, for the control socket's status. */
export function offDecks(): string[] {
  return [...off];
}

/**
 * Turn a virtual deck on or off; `on` undefined turns it the other way.
 * Returns whether it is on now. Throws for a deck the config has no virtual
 * deck by that key.
 */
export function setPower(deck: string, on?: boolean): boolean {
  if (!known().has(deck)) throw new Error(`there is no virtual deck "${deck}": choose it again in the editor`);
  const want = on ?? off.has(deck);
  if (want === !off.has(deck)) return want;
  if (want) off.delete(deck);
  else off.add(deck);
  void save();
  for (const listener of listeners) listener(deck);
  return want;
}

/** Forget a deck that is no longer a virtual deck (removed in Settings): it comes back on if it is added again. */
export function forgetMissing(): void {
  const before = off.size;
  for (const deck of [...off]) if (!known().has(deck)) off.delete(deck);
  if (off.size !== before) void save();
}
