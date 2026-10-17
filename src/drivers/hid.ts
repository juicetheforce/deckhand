import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import type { ControlInput, DeckDevice, DeckDriver, FoundDevice } from '../devices.js';
import { geometryOf, type DeckGeometry, type RawControl } from '../geometry.js';
import { watchHotplug } from '../services/hotplug.js';

/**
 * Stream Decks, through the Elgato library: the "hid" driver. Everything the
 * daemon knows about the library is here — discovery, opening, the serial,
 * hotplug — so nothing above src/devices.ts depends on it.
 */

/**
 * The minimal surface needed from the library's deck object. Deliberately
 * narrow. What a deck has — its keys, which have screens, and each screen's
 * size — comes from CONTROLS alone, through geometryOf(): no model is known
 * here.
 */
export interface RawDeck {
  MODEL?: string;
  PRODUCT_NAME?: string;
  CONTROLS?: ReadonlyArray<RawControl>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  fillKeyBuffer(index: number, buffer: Buffer, options: { format: string }): Promise<void>;
  clearPanel(): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Library versions differ on whether key events carry a plain index or a
 * control object. Normalise both, and ignore non-button controls such as the
 * dials on a Plus.
 */
function keyIndexOf(arg: unknown): number | null {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object') {
    const obj = arg as { index?: number; type?: string };
    if (obj.type && obj.type !== 'button') return null;
    if (typeof obj.index === 'number') return obj.index;
  }
  return null;
}

/** A Stream Deck already opened, as a DeckDevice. Exported for the tests, which drive fake library objects through it. */
export function hidDevice(raw: RawDeck, serial: string): DeckDevice {
  const geometry: DeckGeometry = geometryOf(raw);
  const indexOf = new Map(geometry.keys.map((key) => [key.id, key.index]));
  return {
    id: serial,
    driver: 'hid',
    geometry,
    onInput(listener: (event: ControlInput) => void) {
      for (const edge of ['down', 'up'] as const) {
        raw.on(edge, (arg: unknown) => {
          const index = keyIndexOf(arg);
          if (index !== null) listener({ control: String(index), edge });
        });
      }
    },
    onError(listener) {
      raw.on('error', listener);
    },
    async draw(control, rgba) {
      const index = indexOf.get(control);
      if (index === undefined) throw new Error(`no key "${control}"`);
      await raw.fillKeyBuffer(index, rgba, { format: 'rgba' });
    },
    clear: () => raw.clearPanel(),
    setBrightness: (percent) => raw.setBrightness(percent),
    close: () => raw.close(),
  };
}

/** Open the deck at a HID path and read its serial: the same call for attaching and for writing a starter config, so the key always matches. */
async function openAt(path: string): Promise<DeckDevice | null> {
  let raw: Awaited<ReturnType<typeof openStreamDeck>>;
  try {
    raw = await openStreamDeck(path);
  } catch (err) {
    console.error(`[main] cannot open ${path}: ${(err as Error).message}`);
    return null;
  }
  try {
    const serial = (await raw.getSerialNumber()).trim();
    return hidDevice(raw as unknown as RawDeck, serial);
  } catch {
    console.error(`[main] cannot read serial for ${path}, skipping`);
    await raw.close().catch(() => undefined);
    return null;
  }
}

export const hidDriver: DeckDriver = {
  name: 'hid',
  async list(): Promise<FoundDevice[]> {
    const devices = await listStreamDecks();
    // An enumeration entry with no serial is still listed, without an id: it
    // cannot be matched, so a scan opens it — the serial is optional in the
    // library's types.
    return devices.map((device) => ({ id: device.serialNumber?.trim() || undefined, open: () => openAt(device.path) }));
  },
  watch(onChange) {
    return watchHotplug((action, devpath) => onChange(`${action} ${devpath.split('/').pop()}`));
  },
};

/** `npm run decks` — print serials so you can paste them into config.json. */
export async function printHidDecks(): Promise<void> {
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
