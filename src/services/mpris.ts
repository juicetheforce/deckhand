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

/**
 * Proxy objects, kept between calls. dbus-next's getProxyObject() introspects
 * the object over D-Bus and parses the reply XML every time it is called, and
 * a now-playing key calls it three times per refresh. Measured 2026-09-14
 * against a real player: 13.5–16.5 ms CPU per getTrackInfo() as-is, ~6 ms
 * with proxies reused.
 *
 * A proxy talks to the bus *name*, so it keeps working if the same player
 * restarts. An entry is forgotten when its name leaves the bus (see
 * listPlayers) or when a call through it fails.
 */
const proxies = new Map<string, Promise<dbus.ProxyObject>>();

function proxyFor(name: string, objectPath: string): Promise<dbus.ProxyObject> {
  const key = `${name} ${objectPath}`;
  let proxy = proxies.get(key);
  if (!proxy) {
    proxy = getBus().getProxyObject(name, objectPath);
    // A failed introspection must not be cached.
    proxy.catch(() => proxies.delete(key));
    proxies.set(key, proxy);
  }
  return proxy;
}

function forgetProxies(name: string): void {
  for (const key of proxies.keys()) {
    if (key.startsWith(`${name} `)) proxies.delete(key);
  }
}

/** dbus-next wraps everything in Variants; peel them off. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: unknown }).value;
  }
  return value;
}

export async function listPlayers(): Promise<string[]> {
  const obj = await proxyFor('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const iface = obj.getInterface('org.freedesktop.DBus') as unknown as {
    ListNames(): Promise<string[]>;
  };
  const names = await iface.ListNames();
  const players = names.filter((n) => n.startsWith(MPRIS_PREFIX));

  // Drop proxies for players that have left the bus.
  for (const key of proxies.keys()) {
    const name = key.split(' ')[0];
    if (name.startsWith(MPRIS_PREFIX) && !players.includes(name)) forgetProxies(name);
  }
  return players;
}

async function getStatus(name: string): Promise<string> {
  try {
    const obj = await proxyFor(name, OBJECT_PATH);
    const props = obj.getInterface(PROPS_IFACE) as unknown as {
      Get(iface: string, prop: string): Promise<unknown>;
    };
    return String(unwrap(await props.Get(PLAYER_IFACE, 'PlaybackStatus')));
  } catch {
    forgetProxies(name);
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
  // Write to a temporary file, then rename it into place. Rename is atomic, so
  // anyone reading `dest` sees no file or the whole image, never a partly
  // written one. (Writing `dest` directly let a concurrent fetch or render read
  // an empty file: "Input Buffer is empty".)
  const temp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.mkdir(ART_CACHE_DIR, { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    await fs.writeFile(temp, Buffer.from(await res.arrayBuffer()));
    await fs.rename(temp, dest);
    return dest;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return undefined;
  }
}

export async function getTrackInfo(hint?: string): Promise<TrackInfo | null> {
  const name = await pickPlayer(hint);
  if (!name) return null;

  try {
    const obj = await proxyFor(name, OBJECT_PATH);
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
    forgetProxies(name);
    console.error(`[mpris] failed to read ${name}: ${(err as Error).message}`);
    return null;
  }
}

export type MediaMethod = 'PlayPause' | 'Play' | 'Pause' | 'Next' | 'Previous' | 'Stop';

export async function call(method: MediaMethod, hint?: string): Promise<void> {
  const name = await pickPlayer(hint);
  if (!name) throw new Error('no MPRIS player is running');

  try {
    const obj = await proxyFor(name, OBJECT_PATH);
    const player = obj.getInterface(PLAYER_IFACE) as unknown as Record<
      string,
      () => Promise<void>
    >;
    const fn = player[method];
    if (typeof fn !== 'function') throw new Error(`player does not support ${method}`);
    await fn.call(player);
    lastActive = name;
  } catch (err) {
    forgetProxies(name);
    throw err;
  }
}

type SignalSource = {
  on(event: string, cb: (...args: unknown[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
};

/**
 * Fire `onChange` when any player's state changes, or when a player appears
 * or disappears. Watching every player rather than one avoids the classic bug
 * where the button goes stale because you restarted the music app.
 *
 * Players are discovered once at start with ListNames, then from the bus's
 * NameOwnerChanged signal — no timer. (This replaced a 10 s rescan, which
 * broke "no timers at rest"; see docs/scope.md §3.)
 */
export function subscribe(onChange: () => void): () => void {
  let stopped = false;
  /** Player bus name -> the PropertiesChanged listener attached to it. */
  const attached = new Map<string, { props: SignalSource; handler: () => void }>();
  let debounce: NodeJS.Timeout | null = null;
  let busSignals: { source: SignalSource; handler: (...args: unknown[]) => void } | null = null;

  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, 150);
  };

  const attach = async (name: string) => {
    if (attached.has(name) || stopped) return;
    try {
      const obj = await getBus().getProxyObject(name, OBJECT_PATH);
      const props = obj.getInterface(PROPS_IFACE) as unknown as SignalSource;
      const handler = () => fire();
      props.on('PropertiesChanged', handler);
      attached.set(name, { props, handler });
    } catch {
      // player vanished between being announced and attaching; harmless
    }
  };

  // Remove the listener rather than leave it: a player that restarts gets a
  // fresh listener on reappearing, so nothing is ever attached twice.
  const detach = (name: string) => {
    const entry = attached.get(name);
    if (entry) {
      entry.props.removeListener('PropertiesChanged', entry.handler);
      attached.delete(name);
    }
    forgetProxies(name);
    if (lastActive === name) lastActive = null;
  };

  const onNameOwnerChanged = (...args: unknown[]) => {
    const [name, , newOwner] = args as [string, string, string];
    if (stopped || !name.startsWith(MPRIS_PREFIX)) return;
    if (newOwner) {
      console.log(`[mpris] player appeared: ${name.slice(MPRIS_PREFIX.length)}`);
      void attach(name).then(fire);
    } else {
      console.log(`[mpris] player disappeared: ${name.slice(MPRIS_PREFIX.length)}`);
      detach(name);
      fire();
    }
  };

  const start = async () => {
    try {
      // Listen before listing, so a player that appears in between is not missed.
      const dbusObj = await proxyFor('org.freedesktop.DBus', '/org/freedesktop/DBus');
      const source = dbusObj.getInterface('org.freedesktop.DBus') as unknown as SignalSource;
      source.on('NameOwnerChanged', onNameOwnerChanged);
      busSignals = { source, handler: onNameOwnerChanged };
      for (const name of await listPlayers()) await attach(name);
    } catch (err) {
      console.error(`[mpris] cannot watch for players: ${(err as Error).message}`);
    }
  };

  void start();

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    busSignals?.source.removeListener('NameOwnerChanged', busSignals.handler);
    for (const name of [...attached.keys()]) detach(name);
  };
}

export function disconnect(): void {
  try {
    bus?.disconnect();
  } catch {
    // ignore
  }
  bus = null;
  // Proxies belong to the old connection.
  proxies.clear();
}
