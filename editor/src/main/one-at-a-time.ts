/**
 * Runs the editor's own socket actions one after another. The daemon runs one
 * socket action at a time and refuses a second with "busy" rather than queue
 * it (REFERENCE, stall protection 4). The editor is one client, so it must not
 * collide with itself: two page tabs clicked within a switch's round trip
 * sent two action.run requests, the daemon refused the second, and the
 * earlier switch's success then cleared the error — a click lost without a
 * word (check:one-deck, step 2).
 *
 * Each call starts once the one before it has settled, whether it succeeded
 * or failed. Nothing is dropped or merged: every click is shown on the deck,
 * in the order it was made.
 */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = last.then(run, run);
    last = next.catch(() => undefined);
    return next;
  };
}
