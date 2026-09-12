import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import { CONFIG_PATH, loadConfig, watchConfig } from './config.js';
import { DeckSession } from './deck.js';
import { input, INPUT_BIN } from './input.js';
import { clearRenderCache } from './render.js';
import * as audioService from './services/audio.js';
import * as mprisService from './services/mpris.js';
import type { Config } from './types.js';

const SCAN_INTERVAL_MS = 3000;

const sessions = new Map<string, DeckSession>();
let config: Config | null = null;
let shuttingDown = false;

/** `npm run decks` — print serials so you can paste them into config.json. */
async function printDecks(): Promise<void> {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    console.log('No Stream Decks found.');
    console.log('If one is plugged in, install udev/60-deckhand.rules and re-plug it.');
    return;
  }
  console.log('Connected Stream Decks:\n');
  for (const device of devices) {
    console.log(`  serial: ${device.serialNumber ?? '(unavailable)'}`);
    console.log(`  model:  ${device.model}`);
    console.log(`  path:   ${device.path}\n`);
  }
}

async function attach(devicePath: string): Promise<void> {
  let raw: Awaited<ReturnType<typeof openStreamDeck>>;
  try {
    raw = await openStreamDeck(devicePath);
  } catch (err) {
    console.error(`[main] cannot open ${devicePath}: ${(err as Error).message}`);
    return;
  }

  let serial: string;
  try {
    serial = (await raw.getSerialNumber()).trim();
  } catch {
    console.error(`[main] cannot read serial for ${devicePath}, skipping`);
    await raw.close().catch(() => undefined);
    return;
  }

  if (sessions.has(serial)) {
    await raw.close().catch(() => undefined);
    return;
  }

  const deckDef = config?.decks[serial];
  if (!deckDef) {
    console.warn(
      `[main] deck ${serial} (${raw.MODEL}) is connected but not in config.json — ` +
        `add a "${serial}" entry under "decks" to use it`,
    );
    await raw.close().catch(() => undefined);
    return;
  }

  const session = new DeckSession(
    raw as unknown as ConstructorParameters<typeof DeckSession>[0],
    serial,
    deckDef,
    config?.defaults ?? {},
  );

  try {
    await session.start();
  } catch (err) {
    console.error(`[main] failed to start deck ${serial}: ${(err as Error).message}`);
    await session.close();
    return;
  }

  sessions.set(serial, session);
  console.log(
    `[main] attached ${deckDef.name ?? session.model} (${serial}) — ` +
      `${session.keyCount} keys @ ${session.iconSize}px`,
  );
}

/**
 * Poll for devices. node-hid has no portable hotplug event, and a 3 second
 * scan is cheap — it means unplugging a deck mid-game and plugging it back
 * in just works instead of needing a daemon restart.
 */
async function scan(): Promise<void> {
  if (shuttingDown) return;
  let devices: Awaited<ReturnType<typeof listStreamDecks>>;
  try {
    devices = await listStreamDecks();
  } catch (err) {
    console.error(`[main] device scan failed: ${(err as Error).message}`);
    return;
  }

  const seen = new Set(devices.map((d) => d.serialNumber).filter(Boolean) as string[]);

  for (const [serial, session] of sessions) {
    if (!seen.has(serial)) {
      console.log(`[main] deck ${serial} disconnected`);
      await session.close();
      sessions.delete(serial);
    }
  }

  for (const device of devices) {
    const serial = device.serialNumber?.trim();
    if (serial && sessions.has(serial)) continue;
    await attach(device.path);
  }
}

async function reload(): Promise<void> {
  try {
    const next = await loadConfig();
    config = next;
    clearRenderCache();
    console.log('[main] config reloaded');

    for (const [serial, session] of sessions) {
      const deckDef = next.decks[serial];
      if (!deckDef) {
        console.log(`[main] deck ${serial} removed from config, detaching`);
        await session.close();
        sessions.delete(serial);
        continue;
      }
      await session.reconfigure(deckDef, next.defaults ?? {});
    }
    // Picks up decks that were connected but previously unconfigured.
    await scan();
  } catch (err) {
    // Keep running on the last good config — a typo while editing should
    // not take your deck down mid-game.
    console.error(`[main] config reload failed, keeping previous: ${(err as Error).message}`);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] ${signal}, shutting down`);
  for (const session of sessions.values()) await session.close();
  sessions.clear();
  input.stop();
  mprisService.disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes('--list') || process.argv.includes('--decks')) {
    await printDecks();
    return;
  }

  console.log(`[main] deckhand starting`);
  console.log(`[main] config: ${CONFIG_PATH}`);
  console.log(`[main] input helper: ${INPUT_BIN}`);

  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[main] cannot load config: ${(err as Error).message}`);
    process.exit(1);
  }

  input.start();

  const stopWatching = watchConfig(() => void reload());

  const invalidateAll = () => {
    for (const session of sessions.values()) session.invalidate();
  };
  const stopAudio = audioService.subscribe(() =>
    sessions.forEach((s) => s.invalidateByType(['audio.sink', 'audio.cycle', 'audio.micMute', 'audio.volume'])),
  );
  const stopMpris = mprisService.subscribe(() =>
    sessions.forEach((s) => s.invalidateByType(['media.control', 'media.info'])),
  );

  await scan();
  const scanner = setInterval(() => void scan(), SCAN_INTERVAL_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(scanner);
      stopWatching();
      stopAudio();
      stopMpris();
      void shutdown(signal);
    });
  }

  process.on('uncaughtException', (err) => {
    console.error(`[main] uncaught: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[main] unhandled rejection: ${String(reason)}`);
  });

  // Referenced so a future editor connection can force a full repaint.
  void invalidateAll;
}

void main();
