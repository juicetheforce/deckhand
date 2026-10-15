import * as dbus from 'dbus-next';

/**
 * Desktop notifications, through org.freedesktop.Notifications on the
 * session bus — the plain notification service every Plasma and GNOME
 * session runs, not a portal. Used for a key whose press failed with a
 * message that says what to do (src/action-error.ts).
 *
 * **Every failed press notifies; each key keeps one notification.** When the
 * same key fails again within REPEAT_WINDOW_MS of its last failure, its
 * notification says how many times, rather than another being added:
 *
 * - **its popup still up: updated in place** (replaces_id) — the count
 *   changes where the person is looking, and Plasma restarts the popup's
 *   timer (measured on Plasma 6.7.5: expiry moved from ~4.9 s to ~7.9 s
 *   after showing, when replaced at 3 s);
 * - **its popup already gone: the old one is closed and a new one shown**
 *   with the count. Not replaces_id: Plasma does not pop up an update to a
 *   notification that has timed out, so a replace then is silent
 *   (measured on KDE Plasma) — and its popups time out after
 *   ~5 s, inside the window. Closing the old one keeps one per key in the
 *   desktop's history too.
 *
 * Whether the popup is up comes from the server's NotificationClosed signal
 * (Plasma sends it, reason 1, when a popup times out), listened to from the
 * first notification on. Later than the window, or after the key's failure
 * was cleared (forget), the count starts again at one.
 *
 * Nothing is connected until the first notification, and nothing runs at
 * rest: the window is two timestamps, not a timer.
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
  on(event: 'NotificationClosed', listener: (id: number, reason: number) => void): void;
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
 * keeps nothing from Deckhand in its history (measured on KDE Plasma).
 */
const DESKTOP_ENTRY = 'io.github.juicetheforce.Deckhand';

/** A key's next failure within this long of its last one counts as a repeat: one notification, with a count. */
export const REPEAT_WINDOW_MS = 10_000;

let bus: dbus.MessageBus | null = null;
let notifications: NotificationsInterface | null = null;

/** What each key's notification is now, by "serial:profile:page:key". */
interface Shown {
  id: number;
  /** Whether its popup is still up: false once the server says it closed (timed out, dismissed). */
  open: boolean;
  /** When the key last failed, and how many times in a row within the window. */
  lastAt: number;
  count: number;
}
const shown = new Map<string, Shown>();

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
  const server = object.getInterface('org.freedesktop.Notifications') as unknown as NotificationsInterface;
  // Its popup gone — timed out, dismissed or closed: an update now would not be seen.
  server.on('NotificationClosed', (id: number) => {
    for (const entry of shown.values()) if (entry.id === id) entry.open = false;
  });
  notifications = server;
  return notifications;
}

/** The summary with how many times the key has failed in a row, from the second time. */
function counted(summary: string, count: number): string {
  return count > 1 ? `${summary} (failed ${count} times)` : summary;
}

/**
 * Show a key's failure. A repeat within REPEAT_WINDOW_MS updates the key's
 * notification with a count — in place while its popup is up, else as a new
 * one, the old one closed. Never throws. `now` is for the tests.
 */
export async function notify(slot: string, summary: string, body: string, now = Date.now()): Promise<void> {
  try {
    const server = await service();
    const previous = shown.get(slot);
    const repeat = previous !== undefined && now - previous.lastAt <= REPEAT_WINDOW_MS;
    const count = repeat ? previous.count + 1 : 1;
    let replaces = 0;
    if (previous && repeat && previous.open) {
      replaces = previous.id;
    } else if (previous) {
      shown.delete(slot);
      // Gone already (dismissed, or removed after timing out): a server may answer with an error. Nothing to close; show the new one anyway.
      await server.CloseNotification(previous.id).catch(() => undefined);
    }
    const title = counted(summary, count);
    const id = await server.Notify(APP_NAME, replaces, APP_ICON, title, body, [], { 'desktop-entry': new dbus.Variant('s', DESKTOP_ENTRY) }, -1);
    shown.set(slot, { id, open: true, lastAt: now, count });
    console.log(`[notify] ${replaces ? 'updated' : 'shown'} (${id}): ${title} — ${body}`);
  } catch (err) {
    notifications = null;
    console.error(`[notify] could not show a notification: ${(err as Error).message}`);
  }
}

/**
 * A key's failure cleared — the person's Clear, a press that worked: its next
 * failure is a first one again, a new notification with no count. Its last
 * notification is still closed then, so the desktop keeps one per key.
 */
export function forget(slot: string): void {
  const entry = shown.get(slot);
  if (entry) {
    entry.lastAt = Number.NEGATIVE_INFINITY;
    entry.count = 0;
  }
}
