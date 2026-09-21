/**
 * Module hooks that give a child process running the real `dist/index.js` a
 * fake Stream Deck it can plug in and out, and a way to force a device scan.
 *
 * The sibling of scripts/test/no-decks-hooks.mjs, and the same technique for
 * the same reason (see that file): the daemon imports `listStreamDecks` and
 * `openStreamDeck` straight from '@elgato-stream-deck/node', and a test must
 * not depend on what is plugged in, so it redirects that specifier. As there,
 * the stand-in **re-exports the real module** and overrides only what it
 * must — other code imports `VENDOR_ID` and `CORSAIR_VENDOR_ID` from it.
 *
 * Two specifiers are redirected:
 *
 * - '@elgato-stream-deck/node' → scripts/test/fake-deck-device.mjs, whose
 *   decks come from `FAKE_DECKS_FILE` and which logs every open and close.
 * - the daemon's own `services/hotplug.js` → a `watchHotplug` that fires on
 *   **SIGUSR2**. That is how a test forces `requestScan()` without waiting out
 *   the 60 s safety-net interval and without a test-only switch in the daemon:
 *   a hotplug event and the safety-net poll run the very same scan().
 *
 * Registered by scripts/test/fake-decks.mjs, which is what a child is given
 * with `--import`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVICE_URL = pathToFileURL(path.join(HERE, 'fake-deck-device.mjs')).href;

const DECK_PACKAGE = '@elgato-stream-deck/node';
const HOTPLUG_SUFFIX = '/dist/services/hotplug.js';
const PREFIX = 'deckhand-fake-decks:';

export async function resolve(specifier, context, next) {
  const real = await next(specifier, context);
  const wanted = specifier === DECK_PACKAGE || real.url.endsWith(HOTPLUG_SUFFIX);
  if (!wanted || real.url.startsWith(PREFIX)) return real;
  return { url: PREFIX + real.url, format: 'module', shortCircuit: true };
}

export async function load(url, context, next) {
  if (!url.startsWith(PREFIX)) return next(url, context);
  const real = url.slice(PREFIX.length);
  const source = real.endsWith(HOTPLUG_SUFFIX)
    ? `
      export * from ${JSON.stringify(real)};
      // SIGUSR2 stands in for a udev event. The daemon's own handler runs the
      // same requestScan() the safety-net timer does, so this exercises the
      // scan path without a 60 s wait.
      export function watchHotplug(onChange) {
        const fire = () => onChange('add', '/fake/hotplug/hidraw0');
        process.on('SIGUSR2', fire);
        return () => process.off('SIGUSR2', fire);
      }
    `
    : `
      export * from ${JSON.stringify(real)};
      export { listStreamDecks, openStreamDeck } from ${JSON.stringify(DEVICE_URL)};
    `;
  return { format: 'module', shortCircuit: true, source };
}
