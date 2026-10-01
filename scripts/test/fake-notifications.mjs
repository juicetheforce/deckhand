/**
 * A fake desktop notification service: org.freedesktop.Notifications on the
 * session bus — a private one in the tests — recording every Notify call, for
 * src/services/notifications.ts. Answers with ids from 1 up, and keeps an id
 * when Notify asks to replace it, as a real server does.
 *
 *   const notes = await startFakeNotifications();
 *   notes.calls  // [{ appName, replacesId, appIcon, summary, body, id }]
 *   await notes.stop();
 */
import dbus from 'dbus-next';

const { Interface } = dbus.interface;

class Notifications extends Interface {
  constructor(calls) {
    super('org.freedesktop.Notifications');
    this.calls = calls;
    this.next = 1;
  }
  Notify(appName, replacesId, appIcon, summary, body, _actions, _hints, _timeout) {
    const id = replacesId !== 0 ? replacesId : this.next++;
    this.calls.push({ appName, replacesId, appIcon, summary, body, id });
    return id;
  }
}
Notifications.configureMembers({
  methods: { Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' } },
});

export async function startFakeNotifications() {
  const bus = dbus.sessionBus();
  bus.on('error', () => undefined);
  const calls = [];
  bus.export('/org/freedesktop/Notifications', new Notifications(calls));
  await bus.requestName('org.freedesktop.Notifications', 0);
  return {
    calls,
    async stop() {
      bus.disconnect();
    },
  };
}
