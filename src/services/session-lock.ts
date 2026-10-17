import * as dbus from 'dbus-next';

/**
 * Whether the person's session is unlocked and in front of them, from
 * logind on the system bus: **no touch from a virtual deck may run an action
 * while the session is locked** — a firm rule.
 * Reading a touchscreen directly bypasses the lock screen, so without this
 * anyone at the panel could fire actions on a locked machine. **Nor while
 * the session is not the active one**: the grab outlives a
 * switch to another user, who would otherwise be pressing this one's keys.
 *
 * **Fails closed**: until logind has answered, and whenever it cannot be read,
 * the state is `unknown`, and a virtual deck takes no touches.
 *
 * The session is the user's graphical one — logind's User `Display` — since
 * the daemon runs in the user manager, in no session of its own. Followed by
 * PropertiesChanged signals on the session and the user: events, no timer.
 * KDE Plasma 6 sets `LockedHint` on locking and clears it on unlocking, and
 * logind announces both (measured, Meta+L on Plasma 6.7).
 *
 * Connected only while a virtual deck is (acquire/release); a lost bus is
 * tried again on the daemon's 60-second scan (retry), like the session bus.
 */

export type LockState = 'open' | 'locked' | 'inactive' | 'unknown';

const LOGIN1 = 'org.freedesktop.login1';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

let users = 0;
let bus: dbus.MessageBus | null = null;
let current: LockState = 'unknown';
const listeners = new Set<(state: LockState) => void>();
/** Bumped by every connection, so a late answer from a bus already given up changes nothing. */
let generation = 0;
/** Bumped by every read of logind, so only the newest read's answers and signals count. */
let reads = 0;
let reading = false;

function set(state: LockState): void {
  if (state === current) return;
  current = state;
  for (const listener of listeners) listener(state);
}

/** `open` is the only state in which a virtual deck takes touches. */
export function lockState(): LockState {
  return current;
}

export function onLockChange(listener: (state: LockState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface PropertiesInterface {
  Get(iface: string, name: string): Promise<dbus.Variant>;
  GetAll(iface: string): Promise<Record<string, dbus.Variant>>;
  on(event: 'PropertiesChanged', listener: (iface: string, changed: Record<string, dbus.Variant>, invalidated: string[]) => void): void;
}

async function properties(conn: dbus.MessageBus, objectPath: string): Promise<PropertiesInterface> {
  const object = await conn.getProxyObject(LOGIN1, objectPath);
  return object.getInterface(PROPERTIES) as unknown as PropertiesInterface;
}

/** Give the bus up: unknown, until a connection reads logind again. */
function drop(why: string): void {
  generation++;
  const old = bus;
  bus = null;
  if (old) {
    try {
      old.disconnect();
    } catch {
      // already gone
    }
  }
  if (why) console.error(`[lock] ${why}; virtual decks take no touches until it can be read`);
  set('unknown');
}

/** logind cannot be read now: unknown, and kept connected to hear it come back. */
function unreadable(why: string): void {
  console.error(`[lock] ${why}; virtual decks take no touches until it can be read`);
  set('unknown');
}

/**
 * Connect to the system bus, and read logind on it. The connection outlives
 * logind: its name changing owner is the only sign logind restarted or went
 * away (nothing is said on its objects). Gone: unknown. Back: read again at
 * once.
 */
function connect(): void {
  if (bus || users === 0) return;
  const mine = ++generation;
  let conn: dbus.MessageBus;
  try {
    conn = dbus.systemBus();
  } catch (err) {
    drop(`cannot reach the system bus (${(err as Error).message})`);
    return;
  }
  bus = conn;
  conn.on('error', (err: Error) => {
    if (bus === conn) drop(`the system bus went away (${err.message})`);
  });
  void (async () => {
    try {
      const busObject = (await conn.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')).getInterface('org.freedesktop.DBus') as unknown as {
        on(event: 'NameOwnerChanged', listener: (name: string, oldOwner: string, newOwner: string) => void): void;
      };
      busObject.on('NameOwnerChanged', (name, _old, newOwner) => {
        if (name !== LOGIN1 || mine !== generation) return;
        if (newOwner) void readLogind(conn, mine);
        else {
          reads++; // the last read's signals no longer count
          unreadable('logind went away');
        }
      });
    } catch (err) {
      if (mine === generation) drop(`cannot watch logind on the system bus (${(err as Error).message})`);
      return;
    }
    await readLogind(conn, mine);
  })();
}

/** Read the user's graphical session, its lock state, and follow both. */
async function readLogind(conn: dbus.MessageBus, mine: number): Promise<void> {
  const read = ++reads;
  const newest = () => mine === generation && read === reads;
  reading = true;
  try {
    const manager = (await conn.getProxyObject(LOGIN1, '/org/freedesktop/login1')).getInterface(`${LOGIN1}.Manager`) as unknown as {
      GetUser(uid: number): Promise<string>;
    };
    const userPath = await manager.GetUser(process.getuid?.() ?? 0);
    const user = await properties(conn, userPath);

    let sessionPath = '';
    let watched = '';
    const readState = async (session: PropertiesInterface) => {
      const all = await session.GetAll(`${LOGIN1}.Session`);
      if (!newest()) return;
      const locked = all.LockedHint?.value;
      const active = all.Active?.value;
      if (typeof locked !== 'boolean' || typeof active !== 'boolean') set('unknown');
      else set(locked ? 'locked' : active ? 'open' : 'inactive');
    };
    const readSession = async () => {
      const display = (await user.Get(`${LOGIN1}.User`, 'Display')).value as [string, string];
      if (!newest()) return;
      sessionPath = display?.[1] ?? '';
      if (!sessionPath || sessionPath === '/') {
        unreadable('logind names no graphical session for this user');
        return;
      }
      const session = await properties(conn, sessionPath);
      if (watched !== sessionPath) {
        watched = sessionPath;
        const forPath = sessionPath;
        session.on('PropertiesChanged', (iface, changed, invalidated) => {
          if (!newest() || forPath !== sessionPath || iface !== `${LOGIN1}.Session`) return;
          if ('LockedHint' in changed || 'Active' in changed || invalidated.includes('LockedHint') || invalidated.includes('Active')) {
            void readState(session).catch((err) => newest() && unreadable(`cannot read the session's lock state (${(err as Error).message})`));
          }
        });
      }
      await readState(session);
    };

    user.on('PropertiesChanged', (iface, changed, invalidated) => {
      if (!newest() || iface !== `${LOGIN1}.User`) return;
      if ('Display' in changed || invalidated.includes('Display')) {
        void readSession().catch((err) => newest() && unreadable(`cannot read the user's session (${(err as Error).message})`));
      }
    });
    await readSession();
  } catch (err) {
    if (newest()) unreadable(`cannot read logind (${(err as Error).message})`);
  } finally {
    if (read === reads) reading = false;
  }
}

/** A virtual deck wants the lock state: connected from the first. */
export function acquire(): void {
  users++;
  connect();
}

/** A virtual deck has gone: disconnected after the last. */
export function release(): void {
  users = Math.max(0, users - 1);
  if (users === 0) drop('');
}

/** The 60-second scan: try again if the bus or logind could not be read. Does nothing while the state is known. */
export function retry(): void {
  if (users === 0) return;
  if (!bus) connect();
  else if (current === 'unknown' && !reading) void readLogind(bus, generation);
}
