import * as dbus from 'dbus-next';

/**
 * Desktop notifications, through org.freedesktop.Notifications on the
 * session bus — the plain notification service every Plasma and GNOME
 * session runs, not a portal. Used for a key whose press failed with a
 * message that says what to do (src/action-error.ts).
 *
 * Nothing is connected until the first notification, and nothing runs at
 * rest. Each key keeps one notification: a new failure of the same key
 * replaces it (replaces_id) rather than stacking another. A failure to notify
 * is logged and changes nothing else — the key is badged either way.
 */

interface NotificationsInterface {
  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Record<string, dbus.Variant>,
    expireTimeout: number,
  ): Promise<number>;
}

const APP_NAME = 'Deckhand';
/** The desktop entry's icon (scripts/install.sh). */
const APP_ICON = 'io.github.juicetheforce.Deckhand';

let bus: dbus.MessageBus | null = null;
let notifications: NotificationsInterface | null = null;
/** The notification each key last showed, by "serial:profile:page:key". */
const shown = new Map<string, number>();

async function service(): Promise<NotificationsInterface> {
  if (notifications) return notifications;
  if (!bus) {
    const created = dbus.sessionBus();
    bus = created;
    created.on('error', () => {
      if (bus === created) {
        bus = null;
        notifications = null;
      }
    });
  }
  const object = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
  notifications = object.getInterface('org.freedesktop.Notifications') as unknown as NotificationsInterface;
  return notifications;
}

/** Show (or replace) the notification for one key. Never throws. */
export async function notify(slot: string, summary: string, body: string): Promise<void> {
  try {
    const id = await (await service()).Notify(APP_NAME, shown.get(slot) ?? 0, APP_ICON, summary, body, [], {}, -1);
    shown.set(slot, id);
  } catch (err) {
    notifications = null;
    console.error(`[notify] could not show a notification: ${(err as Error).message}`);
  }
}
