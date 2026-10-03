/**
 * A fake desktop notification service: org.freedesktop.Notifications on the
 * session bus — a private one in the tests — recording every Notify call, for
 * src/services/notifications.ts. Answers with ids from 1 up, and keeps an id
 * when Notify asks to replace it, as a real server does. CloseNotification
 * closes one that is showing; one that is not answers with an error, as the
 * spec's server does.
 *
 *   const notes = await startFakeNotifications();
 *   notes.calls   // [{ appName, replacesId, appIcon, summary, body, hints, id }]
 *   notes.closed  // ids closed, in order
 *   notes.open    // ids showing now
 *   notes.order   // every call in order: 'notify 1', 'close 1', 'notify 2'…
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
  }
}
Notifications.configureMembers({
  methods: {
    Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
    CloseNotification: { inSignature: 'u', outSignature: '' },
  },
});

export async function startFakeNotifications() {
  const bus = dbus.sessionBus();
  bus.on('error', () => undefined);
  const calls = [];
  const closed = [];
  const open = new Set();
  const order = [];
  bus.export('/org/freedesktop/Notifications', new Notifications(calls, closed, open, order));
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
    },
    async stop() {
      bus.disconnect();
    },
  };
}
