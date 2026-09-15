import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import { CONFIG_PATH, configMissing, loadConfig, watchConfig, writeNewConfig } from './config.js';
import { createHandlers, eventNotifiers, type ControlDeps, type ReloadResult } from './control/commands.js';
import { ControlServer, socketPath } from './control/server.js';
import { DeckSession } from './deck.js';
import { geometryOf, type DeckGeometry } from './geometry.js';
import { input, INPUT_BIN } from './input.js';
import { Profiles } from './profiles.js';
import { clearRenderCache } from './render.js';
import * as audioService from './services/audio.js';
import { watchHotplug } from './services/hotplug.js';
import * as mprisService from './services/mpris.js';
import type { Config } from './types.js';

/**
 * Decks are found by udev hotplug events (services/hotplug.ts). This poll is
 * only the safety net for a missed event or a missing udevadm. It used to run
 * every 3 s, and measured at ~0.65% of one core at rest (docs/code-state.md,
 * "Idle CPU"), about 20 ms of CPU per scan.
 */
const SAFETY_SCAN_INTERVAL_MS = 60000;

const sessions = new Map<string, DeckSession>();
let config: Config | null = null;
/** Created with the first config; updated on every reload. */
let profiles: Profiles | null = null;
let shuttingDown = false;
/** Reported by the control socket's "status" and "config" event. */
let lastReload: ReloadResult = { ok: true, at: new Date().toISOString() };
/**
 * Connected decks with no layout in any profile, and their geometry. attach()
 * opens such a deck, finds nothing to show, and closes it again — reading its
 * controls on the way, so the control socket can describe a deck the config
 * has never mentioned without holding it open.
 */
const unattached = new Map<string, DeckGeometry>();
let control: ControlServer | null = null;
/** Event notifications for the control socket; null until it exists, so calls before then do nothing. */
let events: ReturnType<typeof eventNotifiers> | null = null;
const notifyState = () => events?.state();

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

/**
 * The starter button's combo. Shift+D is chosen because it is harmless and
 * visible: in a text editor it types "D". A lowercase "d" means the key landed
 * but the modifier did not, which is a useful distinction on first bring-up.
 */
const STARTER_KEYS = 'shift+d';

/**
 * First run: no config.json exists. Write one keyed by the decks connected
 * right now — one profile, with one hotkey button on key 0 of each deck — so
 * the daemon starts lit rather than exiting. Returns false if there was
 * nothing to write.
 */
async function bootstrapConfig(): Promise<boolean> {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    console.error('[main] no config.json and no Stream Decks connected — nothing to bootstrap');
    return false;
  }

  const decks: NonNullable<Config['decks']> = {};
  const layouts: Config['profiles'][string]['layouts'] = {};

  for (const device of devices) {
    // Read the serial the same way attach() does, so the config key matches.
    let raw: Awaited<ReturnType<typeof openStreamDeck>>;
    try {
      raw = await openStreamDeck(device.path);
    } catch (err) {
      console.error(`[main] bootstrap: cannot open ${device.path}: ${(err as Error).message}`);
      continue;
    }
    try {
      const serial = (await raw.getSerialNumber()).trim();
      decks[serial] = { name: raw.PRODUCT_NAME };
      layouts[serial] = {
        startPage: 'main',
        pages: {
          main: {
            buttons: {
              '0': {
                label: STARTER_KEYS,
                action: { type: 'hotkey', keys: STARTER_KEYS },
              },
            },
          },
        },
      };
      console.log(`[main] bootstrap: ${raw.PRODUCT_NAME} (${serial})`);
    } catch (err) {
      console.error(`[main] bootstrap: cannot read serial for ${device.path}: ${(err as Error).message}`);
    } finally {
      await raw.close().catch(() => undefined);
    }
  }

  if (Object.keys(layouts).length === 0) {
    console.error('[main] bootstrap: no deck could be read — nothing written');
    return false;
  }

  const starter: Config = {
    decks,
    profiles: { default: { name: 'Default', layouts } },
    startProfile: 'default',
  };
  await writeNewConfig(starter);
  console.log(`[main] wrote starter config to ${CONFIG_PATH}`);
  return true;
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

  const profileId = profiles?.chooseProfileFor(serial) ?? null;
  if (!config || !profiles || profileId === null) {
    // "not in config" is matched by scripts/install.sh; keep the phrase.
    console.warn(
      `[main] deck ${serial} (${raw.MODEL}) is connected but not in config — ` +
        `no profile has a layout for it; add one under a profile's "layouts" to use it`,
    );
    unattached.set(serial, geometryOf(raw as unknown as Parameters<typeof geometryOf>[0]));
    notifyState();
    await raw.close().catch(() => undefined);
    return;
  }

  // A const copy: TypeScript does not carry the null check above into the
  // switchProfile callback, because the module-level variable could change.
  // It never does after main() sets it.
  const profileState = profiles;
  const hardware = config.decks?.[serial] ?? {};
  const session = new DeckSession(raw as unknown as ConstructorParameters<typeof DeckSession>[0], {
    serial,
    hardware,
    layout: profileState.layoutFor(profileId, serial),
    defaults: config.defaults ?? {},
    switchProfile: async (ref) => {
      await profileState.switchTo(ref, sessions);
    },
    onStateChange: notifyState,
  });

  try {
    await session.start();
  } catch (err) {
    console.error(`[main] failed to start deck ${serial}: ${(err as Error).message}`);
    await session.close();
    return;
  }

  sessions.set(serial, session);
  unattached.delete(serial);
  profileState.markShown(serial, profileId);
  notifyState();
  console.log(
    `[main] attached ${hardware.name ?? session.model} (${serial}) — ` +
      `${session.keyCount} keys @ ${session.iconSize}px, profile "${profileId}"`,
  );
}

/**
 * Reconcile open sessions with connected decks: close sessions for decks that
 * are gone, attach decks that are new. Called on a hotplug event, on config
 * reload, at startup, and by the safety-net poll — always through
 * requestScan(), never directly.
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

  const seen = new Set(devices.map((d) => d.serialNumber?.trim()).filter(Boolean) as string[]);

  for (const serial of unattached.keys()) {
    if (!seen.has(serial)) {
      unattached.delete(serial);
      notifyState();
    }
  }

  for (const [serial, session] of sessions) {
    if (!seen.has(serial)) {
      console.log(`[main] deck ${serial} disconnected`);
      await session.close();
      sessions.delete(serial);
      notifyState();
    }
  }

  for (const device of devices) {
    const serial = device.serialNumber?.trim();
    if (serial && sessions.has(serial)) continue;
    await attach(device.path);
  }
}

let scanRunning = false;
let scanQueued = false;

/**
 * Run scan(), never two at once. Scans now start from several places (a
 * hotplug event can land during the safety-net poll or a reload), and two
 * overlapping scans could both open the same new deck before either records
 * its session. A request that arrives mid-scan runs one more scan afterwards.
 */
async function requestScan(): Promise<void> {
  if (scanRunning) {
    scanQueued = true;
    return;
  }
  scanRunning = true;
  try {
    do {
      scanQueued = false;
      await scan();
    } while (scanQueued);
  } finally {
    scanRunning = false;
  }
}

async function reload(): Promise<void> {
  try {
    const next = await loadConfig();
    config = next;
    lastReload = { ok: true, at: new Date().toISOString() };
    events?.config();
    clearRenderCache();
    console.log('[main] config reloaded');

    await profiles?.applyReload(next, sessions);
    // Picks up decks that were connected but previously unconfigured.
    await requestScan();
  } catch (err) {
    // Keep running on the last good config — a typo while editing should
    // not take your deck down mid-game.
    lastReload = { ok: false, at: new Date().toISOString(), error: (err as Error).message };
    events?.config();
    console.error(`[main] config reload failed, keeping previous: ${(err as Error).message}`);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] ${signal}, shutting down`);
  await control?.stop();
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

  if (await configMissing()) {
    try {
      if (!(await bootstrapConfig())) process.exit(1);
    } catch (err) {
      console.error(`[main] bootstrap failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[main] cannot load config: ${(err as Error).message}`);
    process.exit(1);
  }
  profiles = new Profiles(config);
  profiles.setChangeListener(notifyState);
  console.log(`[main] starting on profile "${profiles.activeProfile()}"`);

  input.start();

  const stopWatching = watchConfig(() => void reload());

  const invalidateAll = () => {
    for (const session of sessions.values()) session.invalidate();
  };
  const stopAudio = audioService.subscribe(() => {
    sessions.forEach((s) => s.invalidateByType(['audio.sink', 'audio.cycle', 'audio.micMute', 'audio.volume']));
    events?.audio();
  });
  const stopMpris = mprisService.subscribe(() =>
    sessions.forEach((s) => s.invalidateByType(['media.control', 'media.info'])),
  );

  const stopHotplug = watchHotplug((action, devpath) => {
    console.log(`[hotplug] ${action} ${devpath.split('/').pop()}, rescanning`);
    void requestScan();
  });

  await requestScan();
  const scanner = setInterval(() => void requestScan(), SAFETY_SCAN_INTERVAL_MS);

  // After the decks, and not awaited by anything they need: the socket must
  // never be able to hold up or take down the decks.
  const controlPath = socketPath();
  if (controlPath === null) {
    console.error('[control] XDG_RUNTIME_DIR is not set; no control socket');
  } else {
    const deps: ControlDeps = {
      sessions,
      profiles: () => profiles,
      configPath: CONFIG_PATH,
      lastReload: () => lastReload,
      unattachedDecks: () => unattached,
      releaseSocketKeys: () => input.releaseAllHeldBy('socket'),
      audioState: () => audioService.cachedState(),
    };
    control = new ControlServer(createHandlers(deps));
    events = eventNotifiers(control, deps);
    void control.start(controlPath);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(scanner);
      stopHotplug();
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
