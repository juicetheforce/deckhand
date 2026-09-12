import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dbus from 'dbus-next';

/**
 * MPRIS is a D-Bus standard, so this works with tidal-hifi, a browser tab,
 * VLC, Spotify — anything that exposes a player. Nothing here is Tidal
 * specific on purpose: bind a bus name in config only if you want to pin it.
 */

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const ART_CACHE_DIR = path.join(os.tmpdir(), 'deckhand-art');

export interface TrackInfo {
  player: string;
  status: 'Playing' | 'Paused' | 'Stopped' | string;
  title?: string;
  artist?: string;
  album?: string;
  /** Local filesystem path to cover art, if we could get one. */
  artPath?: string;
}

let bus: dbus.MessageBus | null = null;
/** Bus name of the last player we saw actually playing. */
let lastActive: string | null = null;

function getBus(): dbus.MessageBus {
  if (!bus) bus = dbus.sessionBus();
  return bus;
}

/** dbus-next wraps everything in Variants; peel them off. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: unknown }).value;
  }
  return value;
}

export async function listPlayers(): Promise<string[]> {
  const obj = await getBus().getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const iface = obj.getInterface('org.freedesktop.DBus') as unknown as {
    ListNames(): Promise<string[]>;
  };
  const names = await iface.ListNames();
  return names.filter((n) => n.startsWith(MPRIS_PREFIX));
}

async function getStatus(name: string): Promise<string> {
  try {
    const obj = await getBus().getProxyObject(name, OBJECT_PATH);
    const props = obj.getInterface(PROPS_IFACE) as unknown as {
      Get(iface: string, prop: string): Promise<unknown>;
    };
    return String(unwrap(await props.Get(PLAYER_IFACE, 'PlaybackStatus')));
  } catch {
    return 'Stopped';
  }
}

/**
 * Resolution order: an explicit hint from config, then whatever is actually
 * playing, then the last thing that played, then anything at all. This is
 * why the media buttons keep working when you switch from Tidal to YouTube.
 */
export async function pickPlayer(hint?: string): Promise<string | null> {
  const players = await listPlayers();
  if (players.length === 0) return null;

  if (hint) {
    const needle = hint.toLowerCase();
    const match = players.find((p) => p.toLowerCase().includes(needle));
    if (match) return match;
  }

  for (const p of players) {
    if ((await getStatus(p)) === 'Playing') {
      lastActive = p;
      return p;
    }
  }

  if (lastActive && players.includes(lastActive)) return lastActive;
  return players[0];
}

async function cacheArt(url: string): Promise<string | undefined> {
  if (url.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return undefined;
    }
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) return undefined;

  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const dest = path.join(ART_CACHE_DIR, `${hash}.img`);
  try {
    await fs.access(dest);
    return dest;
  } catch {
    // not cached yet
  }
  try {
    await fs.mkdir(ART_CACHE_DIR, { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  } catch {
    return undefined;
  }
}

export async function getTrackInfo(hint?: string): Promise<TrackInfo | null> {
  const name = await pickPlayer(hint);
  if (!name) return null;

  try {
    const obj = await getBus().getProxyObject(name, OBJECT_PATH);
    const props = obj.getInterface(PROPS_IFACE) as unknown as {
      Get(iface: string, prop: string): Promise<unknown>;
    };

    const status = String(unwrap(await props.Get(PLAYER_IFACE, 'PlaybackStatus')));
    const metadata = (unwrap(await props.Get(PLAYER_IFACE, 'Metadata')) ?? {}) as Record<
      string,
      unknown
    >;

    const title = unwrap(metadata['xesam:title']);
    const artistRaw = unwrap(metadata['xesam:artist']);
    const album = unwrap(metadata['xesam:album']);
    const artUrl = unwrap(metadata['mpris:artUrl']);

    const artist = Array.isArray(artistRaw) ? artistRaw.join(', ') : artistRaw;

    return {
      player: name.slice(MPRIS_PREFIX.length),
      status,
      title: title ? String(title) : undefined,
      artist: artist ? String(artist) : undefined,
      album: album ? String(album) : undefined,
      artPath: artUrl ? await cacheArt(String(artUrl)) : undefined,
    };
  } catch (err) {
    console.error(`[mpris] failed to read ${name}: ${(err as Error).message}`);
    return null;
  }
}

export type MediaMethod = 'PlayPause' | 'Play' | 'Pause' | 'Next' | 'Previous' | 'Stop';

export async function call(method: MediaMethod, hint?: string): Promise<void> {
  const name = await pickPlayer(hint);
  if (!name) throw new Error('no MPRIS player is running');

  const obj = await getBus().getProxyObject(name, OBJECT_PATH);
  const player = obj.getInterface(PLAYER_IFACE) as unknown as Record<
    string,
    () => Promise<void>
  >;
  const fn = player[method];
  if (typeof fn !== 'function') throw new Error(`player does not support ${method}`);
  await fn.call(player);
  lastActive = name;
}

/**
 * Fire `onChange` when any player's state changes. Watching every player
 * rather than one avoids the classic bug where the button goes stale
 * because you restarted the music app.
 */
export function subscribe(onChange: () => void): () => void {
  let stopped = false;
  const attached = new Set<string>();
  let debounce: NodeJS.Timeout | null = null;

  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, 150);
  };

  const attach = async (name: string) => {
    if (attached.has(name) || stopped) return;
    try {
      const obj = await getBus().getProxyObject(name, OBJECT_PATH);
      const props = obj.getInterface(PROPS_IFACE) as unknown as {
        on(event: string, cb: (...args: unknown[]) => void): void;
      };
      props.on('PropertiesChanged', () => fire());
      attached.add(name);
    } catch {
      // player vanished between listing and attaching; harmless
    }
  };

  const rescan = async () => {
    if (stopped) return;
    try {
      for (const name of await listPlayers()) await attach(name);
    } catch (err) {
      console.error(`[mpris] rescan failed: ${(err as Error).message}`);
    }
  };

  void rescan();
  // Players come and go; a slow poll catches new ones without needing to
  // parse NameOwnerChanged for the whole bus.
  const timer = setInterval(() => void rescan(), 10000);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (debounce) clearTimeout(debounce);
  };
}

export function disconnect(): void {
  try {
    bus?.disconnect();
  } catch {
    // ignore
  }
  bus = null;
}
