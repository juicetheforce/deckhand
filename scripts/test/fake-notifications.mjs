/**
 * A fake desktop notification service: org.freedesktop.Notifications on the
 * session bus — a private one in the tests — recording every Notify call, for
 * src/services/notifications.ts. Answers with ids from 1 up, and keeps an id
 * when Notify asks to replace it, as a real server does. CloseNotification
 * closes one that is showing; one that is not answers with an error, as the
 * spec's server does. NotificationClosed is sent when one is closed, dismissed
 * or expires — Plasma sends it, reason 1, when a popup times out and the
 * notification stays in its history (measured on Plasma 6.7.5), which
 * expire() stands in for.
 *
 *   const notes = await startFakeNotifications();
 *   notes.calls   // [{ appName, replacesId, appIcon, summary, body, hints, id }]
 *   notes.closed  // ids closed, in order
 *   notes.open    // ids showing now
 *   notes.order   // every call in order: 'notify 1', 'close 1', 'notify 2'…
 *   notes.expire(id)   // its popup timed out: NotificationClosed(id, 1), still closable
 *   await notes.stop();
 */
import dbus from 'dbus-next';

const { Interface } = dbus.interface;

class Notifications extends Interface {
  constructor(calls, closed, open, order) {
    super('org.freedesktop.Notifications');
    this.calls = calls;
    this.closed = closed;
    this.open = open;
    this.order = order;
    this.next = 1;
  }
  Notify(appName, replacesId, appIcon, summary, body, _actions, hints, _timeout) {
    const id = replacesId !== 0 ? replacesId : this.next++;
    const plainHints = Object.fromEntries(Object.entries(hints ?? {}).map(([k, v]) => [k, v?.value ?? v]));
    this.calls.push({ appName, replacesId, appIcon, summary, body, hints: plainHints, id });
    this.open.add(id);
    this.order.push(`notify ${id}`);
    return id;
  }
  CloseNotification(id) {
    this.order.push(`close ${id}`);
    if (!this.open.delete(id)) throw new dbus.DBusError('org.freedesktop.DBus.Error.Failed', `no notification ${id}`);
    this.closed.push(id);
    this.NotificationClosed(id, 3);
  }
  /** The signal: calling it sends it. Reasons per the spec: 1 expired, 2 dismissed, 3 closed by a call. */
  NotificationClosed(id, reason) {
    return [id, reason];
  }
}
Notifications.configureMembers({
  methods: {
    Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
    CloseNotification: { inSignature: 'u', outSignature: '' },
  },
  signals: {
    NotificationClosed: { signature: 'uu' },
  },
});

export async function startFakeNotifications() {
  const bus = dbus.sessionBus();
  bus.on('error', () => undefined);
  const calls = [];
  const closed = [];
  const open = new Set();
  const order = [];
  const server = new Notifications(calls, closed, open, order);
  bus.export('/org/freedesktop/Notifications', server);
  await bus.requestName('org.freedesktop.Notifications', 0);
  return {
    calls,
    closed,
    open,
    order,
    /** As if the notification service went away: its name released, so a Notify gets no answer but an error. */
    async vanish() {
      await bus.releaseName('org.freedesktop.Notifications');
    },
    /** As if the person dismissed it, or it timed out and was removed: closing it now fails. */
    dismiss(id) {
      open.delete(id);
      server.NotificationClosed(id, 2);
    },
    /** As Plasma does when a popup times out: NotificationClosed, reason 1 — and it stays in the history, so closing it still works. */
    expire(id) {
      server.NotificationClosed(id, 1);
    },
    async stop() {
      bus.disconnect();
    },
  };
}
