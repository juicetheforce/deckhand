/**
 * Module hooks that make a child process see no Stream Decks, whatever is
 * plugged into the machine running the test.
 *
 * `src/index.ts` imports `listStreamDecks` and `openStreamDeck` straight from
 * '@elgato-stream-deck/node', so a test that spawns the real daemon would
 * otherwise take a different branch on a machine with decks attached than on
 * one without — and the working machine always has both decks attached
 * (CLAUDE.md). Rather than adding a test-only switch to the daemon, this
 * redirects that one specifier, in the child only.
 *
 * The stand-in **re-exports the real module** and overrides only those two
 * functions: other code imports other names from it (`src/services/hotplug.ts`
 * wants `VENDOR_ID` and `CORSAIR_VENDOR_ID`), and a stub that provided only
 * what `index.ts` uses made the daemon fail to load at all. An explicit local
 * export takes precedence over `export *`, so the overrides win.
 *
 * Registered by scripts/test/no-decks.mjs, which is what a child is given
 * with `--import`.
 */
const TARGET = '@elgato-stream-deck/node';
const PREFIX = 'deckhand-no-decks:';

export async function resolve(specifier, context, next) {
  if (specifier !== TARGET) return next(specifier, context);
  // Resolve it normally first, so the stand-in can re-export the real thing.
  const real = await next(specifier, context);
  return { url: PREFIX + real.url, format: 'module', shortCircuit: true };
}

export async function load(url, context, next) {
  if (!url.startsWith(PREFIX)) return next(url, context);
  const real = url.slice(PREFIX.length);
  return {
    format: 'module',
    shortCircuit: true,
    source: `
      export * from ${JSON.stringify(real)};
      export async function listStreamDecks() { return []; }
      export async function openStreamDeck() {
        throw new Error('no Stream Decks in this test (scripts/test/no-decks-hooks.mjs)');
      }
    `,
  };
}
