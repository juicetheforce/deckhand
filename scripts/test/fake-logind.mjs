/**
 * A fake logind: org.freedesktop.login1 on a private bus that stands in for
 * the system bus, with what src/services/session-lock.ts reads — the Manager's
 * GetUser, the user's Display, and that session's LockedHint and Active —
 * announcing each change with PropertiesChanged, as logind does (measured on
 * Plasma: `LockedHint` true on Meta+L, false on unlock).
 *
 *   const logind = await startFakeLogind(busAddress);
 *   logind.lock(true) / logind.lock(false)
 *   logind.activate(false)       // another user switched in
 *   logind.calls                 // ['GetUser 1000', …]
 *   await logind.stop();         // the name goes away
 */
import dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;
const SESSION_PATH = '/org/freedesktop/login1/session/_32';

class Session extends Interface {
  constructor() {
    super('org.freedesktop.login1.Session');
    this._locked = false;
    this._active = true;
  }
  get LockedHint() {
    return this._locked;
  }
  get Active() {
    return this._active;
  }
}
Session.configureMembers({
  properties: {
    LockedHint: { signature: 'b', access: ACCESS_READ },
    Active: { signature: 'b', access: ACCESS_READ },
  },
});

class User extends Interface {
  constructor() {
    super('org.freedesktop.login1.User');
    this._display = ['2', SESSION_PATH];
  }
  get Display() {
    return this._display;
  }
}
User.configureMembers({ properties: { Display: { signature: '(so)', access: ACCESS_READ } } });

class Manager extends Interface {
  constructor(calls) {
    super('org.freedesktop.login1.Manager');
    this.calls = calls;
  }
  GetUser(uid) {
    this.calls.push(`GetUser ${uid}`);
    return `/org/freedesktop/login1/user/_${uid}`;
  }
}
Manager.configureMembers({ methods: { GetUser: { inSignature: 'u', outSignature: 'o' } } });

export async function startFakeLogind(busAddress) {
  const bus = dbus.sessionBus({ busAddress });
  const calls = [];
  const session = new Session();
  const user = new User();
  bus.export('/org/freedesktop/login1', new Manager(calls));
  bus.export(`/org/freedesktop/login1/user/_${process.getuid()}`, user);
  bus.export(SESSION_PATH, session);
  await bus.requestName('org.freedesktop.login1', 0);
  return {
    calls,
    lock(locked) {
      session._locked = locked;
      Interface.emitPropertiesChanged(session, { LockedHint: locked }, []);
    },
    activate(active) {
      session._active = active;
      Interface.emitPropertiesChanged(session, { Active: active }, []);
    },
    async stop() {
      await bus.releaseName('org.freedesktop.login1');
      bus.disconnect();
    },
  };
}
