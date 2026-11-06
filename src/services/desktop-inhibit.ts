import * as dbus from 'dbus-next';

/**
 * Whether KDE is keeping its screens on, from powerdevil's active inhibitions.
 *
 * ext-idle-notify-v1 counts only the compositor's own idle inhibitors. A browser
 * playing a video asks KDE's power management over D-Bus instead, which the
 * compositor's notification does not count (measured on Plasma 6.8: it said idled
 * while KDE listed an active inhibition), so without this the decks went dark
 * beside a screen KDE was keeping on.
 *
 * Only a row whose first field names `idle` counts: that is what keeps screens on.
 * `sleep` only blocks suspending. KDE lists an inhibition about 5 s after it is
 * asked for, and announces a change as PropertiesChanged naming the property as
 * invalidated, with no value (measured), so each signal is followed by a read.
 *
 * Events only, and only while idle dimming is set. Where powerdevil is not running
 * (not KDE) nothing is ever inhibited, and its name appearing later is noticed. A
 * lost session bus is tried again on the 60-second scan.
 */

const POLICY_AGENT = 'org.kde.Solid.PowerManagement.PolicyAgent';
const OBJECT_PATH = '/org/kde/Solid/PowerManagement/PolicyAgent';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

interface Properties {
  Get(iface: string, name: string): Promise<dbus.Variant>;
  on(event: 'PropertiesChanged', listener: (iface: string, changed: Record<string, dbus.Variant>, invalidated: string[]) => void): void;
}

let listener: ((inhibited: boolean) => void) | null = null;
let bus: dbus.MessageBus | null = null;
let inhibited = false;
/** Bumped by every connection and every read, so a late answer changes nothing. */
let generation = 0;
let reads = 0;

function set(next: boolean): void {
  if (next === inhibited) return;
  inhibited = next;
  listener?.(next);
}

/** Whether these rows of ActiveInhibitions keep the screens on. */
export function keepsScreensOn(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => Array.isArray(row) && typeof row[0] === 'string' && row[0].split(':').includes('idle'));
}

async function read(properties: Properties): Promise<void> {
  const mine = ++reads;
  try {
    const rows = await properties.Get(POLICY_AGENT, 'ActiveInhibitions');
    if (mine === reads) set(keepsScreensOn(rows.value));
  } catch {
    // Gone between the signal and the read: NameOwnerChanged says so too.
    if (mine === reads) set(false);
  }
}

/** Follow powerdevil, now that it has appeared. */
async function follow(conn: dbus.MessageBus, mine: number): Promise<void> {
  try {
    const object = await conn.getProxyObject(POLICY_AGENT, OBJECT_PATH);
    if (mine !== generation) return;
    const properties = object.getInterface(PROPERTIES) as unknown as Properties;
    properties.on('PropertiesChanged', (iface, changed, invalidated) => {
      if (mine !== generation || iface !== POLICY_AGENT) return;
      if ('ActiveInhibitions' in changed || invalidated.includes('ActiveInhibitions')) void read(properties);
    });
    await read(properties);
  } catch {
    // Not KDE, or it went away again: nothing is inhibited.
    if (mine === generation) set(false);
  }
}

function drop(): void {
  generation++;
  reads++;
  const conn = bus;
  bus = null;
  conn?.disconnect();
}

function connect(): void {
  if (bus || !listener) return;
  const mine = ++generation;
  let conn: dbus.MessageBus;
  try {
    conn = dbus.sessionBus();
  } catch {
    return;
  }
  bus = conn;
  conn.on('error', () => {
    if (bus !== conn) return;
    drop();
    set(false);
  });
  void (async () => {
    try {
      const object = (await conn.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')).getInterface('org.freedesktop.DBus') as unknown as {
        on(event: 'NameOwnerChanged', listener: (name: string, oldOwner: string, newOwner: string) => void): void;
        NameHasOwner(name: string): Promise<boolean>;
      };
      if (mine !== generation) return;
      // Listen before asking, so powerdevil appearing in between is not missed.
      object.on('NameOwnerChanged', (name, _old, newOwner) => {
        if (name !== POLICY_AGENT || mine !== generation) return;
        if (newOwner) void follow(conn, mine);
        else {
          reads++;
          set(false);
        }
      });
      if (await object.NameHasOwner(POLICY_AGENT)) await follow(conn, mine);
    } catch {
      if (mine === generation && bus === conn) {
        drop();
        set(false);
      }
    }
  })();
}

/** Start following, told each change. Does nothing if already following. */
export function watch(onChange: (inhibited: boolean) => void): void {
  listener = onChange;
  connect();
}

/** Stop following: nothing connected, nothing inhibited. Tells no one. */
export function unwatch(): void {
  listener = null;
  inhibited = false;
  drop();
}

/** The 60-second scan: connect again if the session bus was lost. */
export function retry(): void {
  connect();
}
