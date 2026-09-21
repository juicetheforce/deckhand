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

/** Told when the session bus connection is lost: each running subscribe(). */
const busLostListeners = new Set<() => void>();

/**
 * The session bus connection, made on first use and again after one is lost.
 *
 * **A lost connection is dropped, never reused**. Without
 * this, dbus-next's `'error'` had no listener: at startup, before index.ts
 * installs its process handlers, that is a crash; after it, the error is
 * logged and the dead connection stays in use — now-playing faces frozen and
 * media presses going nowhere until the daemon restarts.
 *
 * Both ways a connection dies are caught. `'error'` covers a failed connect
 * and a reset. A clean close — the broker shutting the socket — is only an
 * `'end'` on the underlying connection, which dbus-next 0.10.2's MessageBus
 * does not forward (see lib/connection.js and
 * lib/bus.js), so it is read from the private `_connection`. scripts/
 * smoke-dbus-restart.mjs fails if a dbus-next update moves it.
 */
function getBus(): dbus.MessageBus {
  if (!bus) {
    const created = dbus.sessionBus();
    bus = created;
    created.on('error', (err: Error) => busLost(created, err.message));
    const connection = (created as unknown as { _connection?: NodeJS.EventEmitter })._connection;
    connection?.on('end', () => busLost(created, 'the bus closed the connection'));
    // A new connection made for anything — a press, say — also brings back
    // following players, rather than leaving that to the next retry. Queued,
    // so the caller has its connection before the restart uses it.
    if (lostSubscriptions.size > 0) queueMicrotask(retryLostBus);
  }
  return bus;
}

/**
 * Forget a connection that has failed, so the next use makes a new one. An
 * event from a connection already replaced is ignored.
 *
 * `[inference]`, from reading dbus-next: a call already waiting on the lost
 * connection is never answered or rejected, so a press in flight at that
 * moment does nothing. Later presses use the new connection.
 */
function busLost(lost: dbus.MessageBus, reason: string): void {
  if (bus !== lost) return;
  console.error(`[mpris] session bus connection lost: ${reason}`);
  bus = null;
  // Proxies belong to the old connection.
  proxies.clear();
  try {
    lost.disconnect();
  } catch {
    // Already closed.
  }
  for (const listener of busLostListeners) listener();
}

/** Restart functions of subscriptions whose bus was lost; see retryLostBus(). */
const lostSubscriptions = new Set<() => void>();

/**
 * Try again to follow players, for every subscription whose bus was lost and
 * has not come back. Called from index.ts's 60 s safety-net scan, so a bus
 * that stays away is retried without a timer of its own (CLAUDE.md, "no
 * timers at rest"). Does nothing while the bus is fine.
 */
export function retryLostBus(): void {
  for (const restart of [...lostSubscriptions]) restart();
}

/**
 * Proxy objects, kept between calls. dbus-next's getProxyObject() introspects
 * the object over D-Bus and parses the reply XML every time it is called, and
 * a now-playing key calls it three times per refresh. Measured
 * against a real player: 13.5–16.5 ms CPU per getTrackInfo() as-is, ~6 ms
 * with proxies reused.
 *
 * A proxy talks to the bus *name*, so it keeps working if the same player
 * restarts. An entry is forgotten when its name leaves the bus (see
 * listPlayers) or when a call through it fails.
 */
const proxies = new Map<string, Promise<dbus.ProxyObject>>();

/**
 * The standard MPRIS interfaces, written out rather than discovered.
 *
 * **Why.** dbus-next builds a proxy purely from an object's
 * introspection XML, and **Chromium publishes none**: `Introspect` on
 * `/org/mpris/MediaPlayer2` returns `<node></node>` while `Properties.Get`
 * answers correctly. `[confirmed]` on this machine against Brave (Flatpak) and
 * native `chromium-browser` alike — so it is Chromium's implementation, not the
 * Flatpak bus proxy, and every Chromium browser behaves this way.
 *
 * Discovering these buys nothing anyway: both interfaces are fixed by the MPRIS
 * and D-Bus specifications, so their members cannot vary by player. Supplying
 * them removes an Introspect round trip and an XML parse from every call, for
 * every player, not just the ones that could not be read.
 *
 * Only what the daemon actually uses is declared. A player offering more is
 * unaffected; nothing here restricts it.
 */
const STANDARD_MPRIS_XML = `<node>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg type="s" direction="in"/><arg type="a{sv}" direction="out"/>
    </method>
    <method name="Set">
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg type="s"/><arg type="a{sv}"/><arg type="as"/>
    </signal>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Stop"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>`;

/**
 * Players whose direct calls have failed, so a broken one is reported once
 * rather than on every refresh of a visible now-playing key
 * (a failure that vanishes silently is worse than one that is
 * noisy, but once is enough). Cleared when the name leaves the bus, so a
 * player that is fixed and restarted can complain again.
 */
const warnedPlayers = new Set<string>();

function proxyFor(name: string, objectPath: string): Promise<dbus.ProxyObject> {
  const key = `${name} ${objectPath}`;
  let proxy = proxies.get(key);
  if (!proxy) {
    // The bus itself is introspected normally; only MPRIS players get the
    // standard XML, because only they are known to publish none.
    proxy = name.startsWith(MPRIS_PREFIX)
      ? getBus().getProxyObject(name, objectPath, STANDARD_MPRIS_XML)
      : getBus().getProxyObject(name, objectPath);
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

/** Report a player that cannot be read, once per name (see warnedPlayers). */
function warnOnce(name: string, message: string): void {
  if (warnedPlayers.has(name)) return;
  warnedPlayers.add(name);
  console.error(`[mpris] cannot read ${name.slice(MPRIS_PREFIX.length)}: ${message} — it will be skipped until it reappears`);
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
    if (name.startsWith(MPRIS_PREFIX) && !players.includes(name)) {
      forgetProxies(name);
      warnedPlayers.delete(name);
    }
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

// ---------------------------------------------------------------------------
// Player state cache for key faces
// ---------------------------------------------------------------------------

/**
 * What a key face needs from one player, kept current by subscribe() from the
 * player's PropertiesChanged signal. Key faces read this and never make a
 * D-Bus call: before the cache, every refresh of a visible now-playing key
 * listed the bus's names, asked each player its status, and read status and
 * metadata again — about 6 ms of D-Bus work (measured), awaited
 * serially across a page repaint, so a hung player could stall every key.
 *
 * Presses still read fresh (call() → pickPlayer()): a press is rare, and it
 * should act on the player as it is, as audio presses do.
 */
interface PlayerState {
  status: string;
  title?: string;
  artist?: string;
  album?: string;
  /** mpris:artUrl as the player gave it. */
  artUrl?: string;
  /** Local path of that art once cacheArt() has it; undefined while it downloads. */
  artPath?: string;
}

/** Bus name → state, in the order players were first seen. Only subscribe() writes it. */
const playerStates = new Map<string, PlayerState>();

function metadataFields(raw: unknown): Pick<PlayerState, 'title' | 'artist' | 'album' | 'artUrl'> {
  const metadata = (unwrap(raw) ?? {}) as Record<string, unknown>;
  const title = unwrap(metadata['xesam:title']);
  const artistRaw = unwrap(metadata['xesam:artist']);
  const album = unwrap(metadata['xesam:album']);
  const artUrl = unwrap(metadata['mpris:artUrl']);
  const artist = Array.isArray(artistRaw) ? artistRaw.join(', ') : artistRaw;
  return {
    title: title ? String(title) : undefined,
    artist: artist ? String(artist) : undefined,
    album: album ? String(album) : undefined,
    artUrl: artUrl ? String(artUrl) : undefined,
  };
}

/** Read a player's status and metadata directly. Throws if it cannot be read. */
async function readPlayer(name: string): Promise<PlayerState> {
  const obj = await proxyFor(name, OBJECT_PATH);
  const props = obj.getInterface(PROPS_IFACE) as unknown as {
    Get(iface: string, prop: string): Promise<unknown>;
  };
  const status = String(unwrap(await props.Get(PLAYER_IFACE, 'PlaybackStatus')));
  const metadata = await props.Get(PLAYER_IFACE, 'Metadata');
  return { status, ...metadataFields(metadata) };
}

/**
 * The now-playing state for a key face, from the cache: no D-Bus call, no
 * download, never awaits. Chooses a player as pickPlayer() does — the hint,
 * then whatever is playing, then the last thing that played, then the first —
 * but among cached players. Null when there is none, including before
 * subscribe() has read them.
 */
export function cachedTrackInfo(hint?: string): TrackInfo | null {
  const names = [...playerStates.keys()];
  if (names.length === 0) return null;

  let name: string | undefined;
  if (hint) {
    const needle = hint.toLowerCase();
    name = names.find((n) => n.toLowerCase().includes(needle));
  }
  if (!name) {
    name = names.find((n) => playerStates.get(n)?.status === 'Playing');
    if (name) lastActive = name;
  }
  if (!name && lastActive && playerStates.has(lastActive)) name = lastActive;
  name ??= names[0];

  const state = playerStates.get(name)!;
  return {
    player: name.slice(MPRIS_PREFIX.length),
    status: state.status,
    title: state.title,
    artist: state.artist,
    album: state.album,
    artPath: state.artPath,
  };
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
 * NameOwnerChanged signal — no timer.
 */
export function subscribe(onChange: () => void): () => void {
  let stopped = false;
  /**
   * Bumped whenever the bus is lost. Work begun on an older connection checks
   * it and stops, so a slow reply from before the loss cannot attach a
   * listener to a connection that is gone.
   */
  let generation = 0;
  /** Whether the next loss gets one quick retry; see onBusLost. */
  let quickRetryAllowed = true;
  let quickRetry: NodeJS.Timeout | null = null;
  /** Player bus name -> the PropertiesChanged listener attached to it. */
  const attached = new Map<string, { props: SignalSource; handler: () => void }>();
  let debounce: NodeJS.Timeout | null = null;
  let busSignals: { source: SignalSource; handler: (...args: unknown[]) => void } | null = null;

  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, 150);
  };

  /**
   * Fetch the art for a player's current artUrl in the background, and fire
   * once it is on disk — so a first read of a new track's cover (measured
   * 664 ms once) never holds up a render. Ignored if the track changed
   * meanwhile.
   */
  const fetchArt = (name: string, state: PlayerState) => {
    state.artPath = undefined;
    const url = state.artUrl;
    if (!url) return;
    void cacheArt(url).then((artPath) => {
      const current = playerStates.get(name);
      if (stopped || !current || current.artUrl !== url || !artPath) return;
      current.artPath = artPath;
      fire();
    });
  };

  /** Read a player into the cache from scratch: on attach, and when it invalidates a property without sending the value. */
  const readIntoCache = async (name: string) => {
    try {
      const state = await readPlayer(name);
      if (stopped || !attached.has(name)) return;
      playerStates.set(name, state);
      fetchArt(name, state);
      fire();
    } catch (err) {
      forgetProxies(name);
      warnOnce(name, (err as Error).message);
    }
  };

  /** Apply a PropertiesChanged signal to the cache, without a call where the signal carries the values. */
  const onPropertiesChanged = (name: string, iface: unknown, changed: unknown, invalidated: unknown) => {
    if (iface !== PLAYER_IFACE) return;
    const state = playerStates.get(name);
    const values = (changed ?? {}) as Record<string, unknown>;
    const gone = Array.isArray(invalidated) ? (invalidated as unknown[]) : [];
    if (!state || gone.includes('PlaybackStatus') || gone.includes('Metadata')) {
      void readIntoCache(name);
      return;
    }
    if ('PlaybackStatus' in values) state.status = String(unwrap(values.PlaybackStatus));
    if ('Metadata' in values) {
      const previousUrl = state.artUrl;
      Object.assign(state, metadataFields(values.Metadata));
      if (state.artUrl !== previousUrl) fetchArt(name, state);
    }
    fire();
  };

  const attach = async (name: string) => {
    if (attached.has(name) || stopped) return;
    const startedIn = generation;
    try {
      // Through proxyFor(), so the player is built from STANDARD_MPRIS_XML.
      // Until C1 this called getProxyObject() without it, so a Chromium
      // player — which publishes no introspection data — got no listener and
      // its key only caught up on the next refresh, despite the 2026-09-16
      // fix saying otherwise. With faces reading this cache, a missing
      // listener would mean a key that never updates at all.
      const obj = await proxyFor(name, OBJECT_PATH);
      if (startedIn !== generation || attached.has(name)) return;
      const props = obj.getInterface(PROPS_IFACE) as unknown as SignalSource;
      const handler = (...args: unknown[]) => onPropertiesChanged(name, args[0], args[1], args[2]);
      props.on('PropertiesChanged', handler);
      attached.set(name, { props, handler });
    } catch (err) {
      // Not only "the player vanished before we attached", which is harmless.
      warnOnce(name, `cannot follow its changes: ${(err as Error).message}`);
      return;
    }
    // Listen first, then read, so no change falls between the two.
    await readIntoCache(name);
  };

  // Remove the listener rather than leave it: a player that restarts gets a
  // fresh listener on reappearing, so nothing is ever attached twice.
  const detach = (name: string) => {
    const entry = attached.get(name);
    if (entry) {
      entry.props.removeListener('PropertiesChanged', entry.handler);
      attached.delete(name);
    }
    playerStates.delete(name);
    forgetProxies(name);
    warnedPlayers.delete(name);
    if (lastActive === name) lastActive = null;
  };

  const onNameOwnerChanged = (...args: unknown[]) => {
    const [name, , newOwner] = args as [string, string, string];
    if (stopped || !name.startsWith(MPRIS_PREFIX)) return;
    if (newOwner) {
      console.log(`[mpris] player appeared: ${name.slice(MPRIS_PREFIX.length)}`);
      void attach(name);
    } else {
      console.log(`[mpris] player disappeared: ${name.slice(MPRIS_PREFIX.length)}`);
      detach(name);
      fire();
    }
  };

  const start = async () => {
    const startedIn = generation;
    try {
      // Listen before listing, so a player that appears in between is not missed.
      const dbusObj = await proxyFor('org.freedesktop.DBus', '/org/freedesktop/DBus');
      if (startedIn !== generation) return;
      const source = dbusObj.getInterface('org.freedesktop.DBus') as unknown as SignalSource;
      source.on('NameOwnerChanged', onNameOwnerChanged);
      busSignals = { source, handler: onNameOwnerChanged };
      for (const name of await listPlayers()) {
        if (startedIn !== generation) return;
        await attach(name);
      }
      // Watching on a working connection: a later loss earns a quick retry again.
      if (startedIn === generation) quickRetryAllowed = true;
    } catch (err) {
      console.error(`[mpris] cannot watch for players: ${(err as Error).message}`);
    }
  };

  const restart = () => {
    if (stopped || !lostSubscriptions.has(restart)) return;
    lostSubscriptions.delete(restart);
    if (quickRetry) clearTimeout(quickRetry);
    quickRetry = null;
    console.log('[mpris] reconnecting to the session bus');
    void start();
  };

  /**
   * The bus connection is gone: drop everything that belonged to it, so faces
   * show idle rather than a frozen track, and try again.
   *
   * One retry 2 s later, for a broker that restarts. If that one fails too,
   * nothing more is scheduled here: retryLostBus() from the 60 s safety-net
   * scan keeps trying, and a media key press makes a new connection at once,
   * which restarts this too (getBus()). So a bus that stays away costs no timer of its own, and a
   * failing bus cannot spin. A quick retry is earned again only by watching
   * successfully.
   */
  const onBusLost = () => {
    if (stopped) return;
    generation++;
    busSignals = null;
    for (const name of [...attached.keys()]) detach(name);
    fire();
    lostSubscriptions.add(restart);
    if (quickRetryAllowed && !quickRetry) {
      quickRetryAllowed = false;
      quickRetry = setTimeout(restart, 2000);
    }
  };
  busLostListeners.add(onBusLost);

  void start();

  return () => {
    stopped = true;
    busLostListeners.delete(onBusLost);
    lostSubscriptions.delete(restart);
    if (quickRetry) clearTimeout(quickRetry);
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
