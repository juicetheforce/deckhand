/**
 * Virtual decks turned off: a screen that also runs widgets, given back to
 * the desktop. Off, the virtual driver leaves the deck out of every scan
 * (src/drivers/virtual.ts), so its session closes as an unplugged screen's
 * does — its helper quits, the touchscreen's grab ends and the desktop has
 * its touches again, every held key is let go — and nothing runs for it at
 * rest. Its pairing, its layouts and the touchscreen's access are kept, so
 * turning it on again is instant and asks for no password.
 *
 * **For this run of the daemon only**: a restart, an update or a reboot
 * brings every virtual deck back on. Nothing is written — the daemon never
 * writes config.json — and whether it should be kept is open (scope §7).
 */

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
  for (const listener of listeners) listener(deck);
  return want;
}

/** Forget a deck that is no longer a virtual deck (removed in Settings): it comes back on if it is added again. */
export function forgetMissing(): void {
  for (const deck of [...off]) if (!known().has(deck)) off.delete(deck);
}
