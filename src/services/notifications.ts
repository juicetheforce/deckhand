import * as dbus from 'dbus-next';

/**
 * Desktop notifications, through org.freedesktop.Notifications on the
 * session bus — the plain notification service every Plasma and GNOME
 * session runs, not a portal. Used for a key whose press failed with a
 * message that says what to do (src/action-error.ts).
 *
 * Nothing is connected until the first notification, and nothing runs at
 * rest. Each key keeps one notification: a new failure of the same key
 * **closes the old one and shows a new one**, rather than stacking another.
 * Not replaces_id: Plasma does not pop up an update to a notification that
 * has already timed out, so every later failure of a key was silent — for
 * every integration, OBS's as much as VTube Studio's (VTS session 1,
 * `[confirmed]` on KDE Plasma). Two calls on an event; nothing listens.
 *
 * Every notification shown is logged, so the journal tells "sent" from
 * "never tried". A failure to notify is logged and changes nothing else —
 * the key is badged either way.
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
  CloseNotification(id: number): Promise<void>;
}

const APP_NAME = 'Deckhand';
/** The desktop entry's icon (scripts/install.sh). */
const APP_ICON = 'io.github.juicetheforce.Deckhand';
/**
 * The desktop entry that sends them — the installed
 * io.github.juicetheforce.Deckhand.desktop (scripts/install.sh, from the
 * editor's desktopName; scripts/smoke-notifications.mjs holds them equal),
 * named without ".desktop" as the hint asks — so the desktop files them under Deckhand: its own entry in
 * KDE's notification settings, and in its history, where someone finds a
 * "this key needs fixing" message they missed while away. Without it, KDE
 * kept nothing from Deckhand in its history (VTS session 1).
 */
const DESKTOP_ENTRY = 'io.github.juicetheforce.Deckhand';

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

/** Show the notification for one key, closing the one it showed before. Never throws. */
export async function notify(slot: string, summary: string, body: string): Promise<void> {
  try {
    const server = await service();
    const previous = shown.get(slot);
    if (previous !== undefined) {
      shown.delete(slot);
      // Gone already (dismissed, or removed after timing out): a server may answer with an error. Nothing to close; show the new one anyway.
      await server.CloseNotification(previous).catch(() => undefined);
    }
    const id = await server.Notify(APP_NAME, 0, APP_ICON, summary, body, [], { 'desktop-entry': new dbus.Variant('s', DESKTOP_ENTRY) }, -1);
    shown.set(slot, id);
    console.log(`[notify] shown (${id}): ${summary} — ${body}`);
  } catch (err) {
    notifications = null;
    console.error(`[notify] could not show a notification: ${(err as Error).message}`);
  }
}
