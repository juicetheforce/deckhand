#!/usr/bin/env node
/**
 * A stand-in for GLib's gio, for offline tests: put its directory first on
 * PATH under the name "gio". It answers only `gio help launch`, as GLib 2.72
 * and newer do — or, with FAKE_GIO_OLD=1, as older GLib does, with the
 * general usage and no launch command. Launching is not faked here: an app
 * key hands gio to systemd-run, which the tests fake instead.
 */
const [command, topic] = process.argv.slice(2);
if (command === 'help' && topic === 'launch' && process.env.FAKE_GIO_OLD !== '1') {
  console.log('Usage:\n  gio launch DESKTOP-FILE [FILE-ARG…]\n\nLaunch an application from a desktop file');
} else {
  console.error('Usage:\n  gio COMMAND [ARGS…]\n\nCommands:\n  help  info  list  mkdir  open');
  process.exit(1);
}
