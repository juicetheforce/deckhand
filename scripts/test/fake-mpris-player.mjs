/**
 * A fake MPRIS player for offline tests, on whatever session bus
 * DBUS_SESSION_BUS_ADDRESS names — run the test under dbus-run-session so it
 * is a private one, never the desktop's.
 *
 * It owns org.mpris.MediaPlayer2.<name>, answers PlaybackStatus and Metadata,
 * and emits PropertiesChanged when a test changes them, as real players do.
 * Every call made to its object is recorded in `calls`, so a test can prove
 * that something made no D-Bus calls at all. With `emptyIntrospection` it
 * answers Introspect with `<node></node>`, as every Chromium browser does,
 * which dbus-next cannot build a proxy from.
 */
import dbus from 'dbus-next';

const { Interface } = dbus.interface;
const { Variant, Message } = dbus;
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

class Player extends Interface {
  constructor() {
    super('org.mpris.MediaPlayer2.Player');
    this.status = 'Stopped';
    this.metadata = {};
    this.onMethod = () => undefined;
  }
  get PlaybackStatus() {
    return this.status;
  }
  get Metadata() {
    return this.metadata;
  }
  PlayPause() {
    this.onMethod('PlayPause');
  }
  Play() {
    this.onMethod('Play');
  }
  Pause() {
    this.onMethod('Pause');
  }
  Next() {
    this.onMethod('Next');
  }
  Previous() {
    this.onMethod('Previous');
  }
  Stop() {
    this.onMethod('Stop');
  }
}
Player.configureMembers({
  properties: {
    PlaybackStatus: { signature: 's', access: 'read' },
    Metadata: { signature: 'a{sv}', access: 'read' },
  },
  methods: { PlayPause: {}, Play: {}, Pause: {}, Next: {}, Previous: {}, Stop: {} },
});

/** Metadata as a player sends it: a{sv}, artist a list. */
function metadataOf({ title, artist, artUrl } = {}) {
  const m = {};
  if (title !== undefined) m['xesam:title'] = new Variant('s', title);
  if (artist !== undefined) m['xesam:artist'] = new Variant('as', [artist]);
  if (artUrl !== undefined) m['mpris:artUrl'] = new Variant('s', artUrl);
  return m;
}

/**
 * Start a player. Returns controls:
 *   set({status?, track?}) — change state and emit PropertiesChanged with the values
 *   setSilently({status?, track?}) — change state and emit nothing
 *   invalidate([names]) — emit PropertiesChanged with only invalidated names
 *   calls — every "interface.member" called on its object, in order
 *   stop() — leave the bus
 */
export async function startFakePlayer(name, { status = 'Paused', track = {}, emptyIntrospection = false } = {}) {
  const bus = dbus.sessionBus();
  // A test that stops the bus under a player (smoke-dbus-restart.mjs) must not
  // see the fake's own connection error as the daemon's.
  bus.on('error', () => undefined);
  const player = new Player();
  player.status = status;
  player.metadata = metadataOf(track);
  const calls = [];
  player.onMethod = (method) => {
    if (method === 'PlayPause') {
      player.status = player.status === 'Playing' ? 'Paused' : 'Playing';
      Interface.emitPropertiesChanged(player, { PlaybackStatus: player.status });
    }
  };

  bus.addMethodHandler((msg) => {
    if (msg.path !== OBJECT_PATH) return false;
    calls.push(`${msg.interface}.${msg.member}`);
    if (emptyIntrospection && msg.member === 'Introspect') {
      bus.send(Message.newMethodReturn(msg, 's', ['<node></node>']));
      return true;
    }
    return false;
  });

  bus.export(OBJECT_PATH, player);
  await bus.requestName(`org.mpris.MediaPlayer2.${name}`, 0);

  const apply = ({ status: s, track: t }) => {
    const changed = {};
    if (s !== undefined) {
      player.status = s;
      changed.PlaybackStatus = s;
    }
    if (t !== undefined) {
      player.metadata = metadataOf(t);
      changed.Metadata = player.metadata;
    }
    return changed;
  };

  return {
    calls,
    set(change) {
      Interface.emitPropertiesChanged(player, apply(change));
    },
    setSilently(change) {
      apply(change);
    },
    invalidate(names) {
      Interface.emitPropertiesChanged(player, {}, names);
    },
    async stop() {
      bus.disconnect();
    },
  };
}
