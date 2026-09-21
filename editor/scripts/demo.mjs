// Open the real editor on an invented setup, to take screenshots for the
// README. Not a check. Everything shown is made up: the decks and their
// serials, the layout, the audio devices, the track playing, the icon folders
// and the bookmarks. Every icon is a built-in one — the folders under the
// demo's ~/Pictures hold copies of assets/icons/.
//
// Follows empty-state.mjs: a scratch daemon with fake decks, its own config,
// state directory and socket, so the installed daemon keeps driving the real
// decks and the installed editor is untouched (a separate instance, because
// the single-instance lock lives in DECKHAND_STATE_DIR). On top of that:
//
// - Its own HOME for the editor, so the icon picker, the bookmarks and "~"
//   show the demo's folders, never yours. Your fontconfig is linked in, so
//   text renders as it does in your real editor.
// - A private, empty session bus (as screenshot.mjs does), so the now-playing
//   key shows the demo's fake player and not whatever is playing on the
//   desktop. Nothing can reach a tray there, so this editor has no tray icon.
// - A fake pactl with invented devices, so the audio lists are not yours.
//
// Usage, from editor/ after npm run build (and the daemon's npm run build:ts):
//
//   node scripts/demo.mjs
//
// Ctrl-C in this terminal to finish; that also removes the scratch directory.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = path.join(os.tmpdir(), `deckhand-demo-${process.getuid?.() ?? 0}`);

// --- A private session bus ----------------------------------------------------
// Re-run this script under dbus-run-session with a bus that has no service
// directories: see screenshot.mjs for why (portal and secret services would
// otherwise be started on it and outlive the run).
if (!process.env.DECKHAND_DEMO_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-demo-bus-${process.pid}.conf`);
  await fs.writeFile(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${os.tmpdir()}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  // Ctrl-C reaches every process in the group, this one included. Without a
  // handler it would die at once and leave the bus config behind; with one it
  // waits for the run below to finish its own clean-up, then removes it.
  process.on('SIGINT', () => undefined);
  const rerun = spawnSync('dbus-run-session', [`--config-file=${busConfig}`, '--', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, DECKHAND_DEMO_PRIVATE_BUS: '1' },
  });
  await fs.rm(busConfig, { force: true });
  process.exit(rerun.status ?? 1);
}

// --- The invented setup -------------------------------------------------------

const XL = 'DEMO-XL-0001';
const V2 = 'DEMO-V2-0002';

// Audio devices, in pactl's JSON shape (see scripts/test/fake-pactl.mjs).
const port = (name) => ({ name, description: name, type: 'Unknown', priority: 1, availability_group: '', availability: 'available' });
const sink = (index, name, description) => ({
  index, name, description, flags: ['HARDWARE', 'DECIBEL_VOLUME'], monitor_source: `${name}.monitor`,
  ports: [port('out')], active_port: 'out', mute: false, volume: { 'front-left': { value_percent: '45%' } },
});
const source = (index, name, description) => ({
  index, name, description, flags: ['HARDWARE'], monitor_source: '', ports: [port('in')], active_port: 'in', mute: false,
});
const SPEAKERS = 'alsa_output.usb-Demo_Desk_Speakers-00.analog-stereo';
const HEADSET = 'alsa_output.usb-Demo_Wireless_Headset-00.analog-stereo';
const MONITOR = 'alsa_output.pci-0000_00_1f.3.hdmi-stereo';
const HEADSET_MIC = 'alsa_input.usb-Demo_Wireless_Headset-00.mono-fallback';
const DESK_MIC = 'alsa_input.usb-Demo_Desk_Microphone-00.analog-stereo';
const DEVICES = {
  sinks: [sink(1, SPEAKERS, 'Desk Speakers'), sink(2, HEADSET, 'Wireless Headset'), sink(3, MONITOR, 'Monitor (HDMI)')],
  sources: [source(10, HEADSET_MIC, 'Wireless Headset Microphone'), source(11, DESK_MIC, 'Desk Microphone')],
};

const media = {
  0: { action: { type: 'media.info', show: 'title+artist' }, labelSize: 12 },
  1: { action: { type: 'media.control', method: 'previous' } },
  2: { action: { type: 'media.control', method: 'playpause' } },
  3: { action: { type: 'media.control', method: 'next' } },
};

const CONFIG = {
  decks: { [XL]: { name: 'Stream Deck XL' }, [V2]: { name: 'Stream Deck' } },
  profiles: {
    desk: {
      name: 'Desk',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                ...media,
                4: { label: 'Vol −', action: { type: 'audio.volume', delta: -5 } },
                5: { label: 'Vol +', action: { type: 'audio.volume', delta: 5 } },
                6: { action: { type: 'audio.mute' } },
                7: { label: 'Stop', action: { type: 'media.control', method: 'stop' } },
                8: { label: 'Speakers', action: { type: 'audio.sink', node: SPEAKERS, label: 'Desk Speakers' } },
                9: { label: 'Headset', action: { type: 'audio.sink', node: HEADSET, label: 'Wireless Headset' } },
                10: { label: 'Output', action: { type: 'audio.cycle', devices: [{ node: SPEAKERS, label: 'Desk Speakers' }, { node: HEADSET, label: 'Wireless Headset' }, { node: MONITOR, label: 'Monitor (HDMI)' }] } },
                11: { action: { type: 'audio.micMute' } },
                12: { label: 'Desk mic', action: { type: 'audio.source', node: DESK_MIC, label: 'Desk Microphone' } },
                13: { label: 'Mic', action: { type: 'audio.cycleSource', devices: [{ node: HEADSET_MIC, label: 'Wireless Headset Microphone' }, { node: DESK_MIC, label: 'Desk Microphone' }] } },
                16: { label: 'Screenshot', action: { type: 'hotkey', keys: 'print' } },
                17: { label: 'Terminal', action: { type: 'hotkey', keys: 'ctrl+alt+t' } },
                18: { label: 'Lock', action: { type: 'hotkey', keys: 'meta+l' } },
                19: { label: 'Talk', action: { type: 'keyHold', keys: 'ctrl+alt+space' } },
                20: { label: 'Sign-off', action: { type: 'text', text: 'Thanks, talk soon.' } },
                21: { label: 'Overview', action: { type: 'hotkey', keys: 'meta+w' } },
                22: { label: 'Meeting', action: { type: 'multi', steps: [{ type: 'audio.sink', node: HEADSET, label: 'Wireless Headset', delayMs: 150 }, { type: 'hotkey', keys: 'ctrl+alt+m' }] } },
                23: { label: 'Snip', action: { type: 'hotkey', keys: 'meta+shift+s' } },
                24: { label: 'Apps', action: { type: 'page', to: 'apps' } },
                25: { label: 'Files', action: { type: 'command', command: 'xdg-open ~' } },
                29: { action: { type: 'brightness', delta: -10 } },
                30: { action: { type: 'brightness', delta: 10 } },
                31: { label: 'Game', action: { type: 'profile', to: 'game' } },
              },
            },
            apps: {
              name: 'Apps',
              buttons: {
                0: { label: 'Files', action: { type: 'command', command: 'xdg-open ~' } },
                1: { label: 'Browser', action: { type: 'command', command: 'xdg-open https://example.org' } },
                2: { label: 'Editor', action: { type: 'command', command: 'kate' } },
                24: { label: 'Back', action: { type: 'page', back: true } },
              },
            },
          },
        },
        [V2]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: { action: { type: 'audio.micMute' } },
                1: { label: 'Output', action: { type: 'audio.cycle', devices: [{ node: SPEAKERS, label: 'Desk Speakers' }, { node: HEADSET, label: 'Wireless Headset' }] } },
                2: { label: 'Vol −', action: { type: 'audio.volume', delta: -5 } },
                3: { label: 'Vol +', action: { type: 'audio.volume', delta: 5 } },
                4: { action: { type: 'clock' } },
                5: { action: { type: 'media.control', method: 'previous' } },
                6: { action: { type: 'media.control', method: 'playpause' } },
                7: { action: { type: 'media.control', method: 'next' } },
                10: { label: 'Copy', action: { type: 'hotkey', keys: 'ctrl+c' } },
                11: { label: 'Paste', action: { type: 'hotkey', keys: 'ctrl+v' } },
                14: { label: 'Game', action: { type: 'profile', to: 'game' } },
              },
            },
          },
        },
      },
    },
    game: {
      name: 'Game',
      layouts: {
        [XL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                ...media,
                8: { label: 'Headset', action: { type: 'audio.sink', node: HEADSET, label: 'Wireless Headset' } },
                11: { action: { type: 'audio.micMute' } },
                16: { label: 'Map', action: { type: 'hotkey', keys: 'm' } },
                17: { label: 'Inventory', action: { type: 'hotkey', keys: 'i' } },
                18: { label: 'Auto-run', action: { type: 'toggle', keys: 'shift' } },
                19: { label: 'Voice', action: { type: 'keyHold', keys: 'ctrl+alt+space' } },
                31: { label: 'Desk', action: { type: 'profile', to: 'desk' } },
              },
            },
          },
        },
        [V2]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: { action: { type: 'audio.micMute' } },
                5: { label: 'F1', action: { type: 'hotkey', keys: 'f1' } },
                6: { label: 'F2', action: { type: 'hotkey', keys: 'f2' } },
                7: { label: 'F3', action: { type: 'hotkey', keys: 'f3' } },
                14: { label: 'Desk', action: { type: 'profile', to: 'desk' } },
              },
            },
          },
        },
      },
    },
  },
  startProfile: 'desk',
};

// The demo's icon folders: copies of built-in icons under invented names.
// "Everyday" is the fullest, and the newest bookmark (below), so the picker opens there.
const ICON_FOLDERS = {
  'Pictures/Deck icons/Everyday': {
    'play.svg': 'play', 'pause.svg': 'pause', 'next.svg': 'next', 'previous.svg': 'previous', 'speakers.svg': 'speaker-out',
    'headset.svg': 'headset', 'mic.svg': 'mic', 'mic-off.svg': 'mic-muted', 'volume.svg': 'volume-down', 'shortcut.svg': 'key-combo',
    'launch.svg': 'command', 'type.svg': 'text-macro', 'clock.svg': 'clock', 'profile.svg': 'profile', 'back.svg': 'back',
    'forward.svg': 'forward', 'toggle.svg': 'toggle', 'hold.svg': 'press-release',
  },
  'Pictures/Deck icons/Media': { 'play.svg': 'play', 'pause.svg': 'pause', 'next.svg': 'next', 'previous.svg': 'previous', 'stop.svg': 'stop', 'now-playing.svg': 'now-playing' },
  'Pictures/Deck icons/Audio': { 'speakers.svg': 'speaker', 'speakers-muted.svg': 'speaker-muted', 'headset.svg': 'headset', 'headset-muted.svg': 'headset-muted', 'mic.svg': 'mic', 'mic-muted.svg': 'mic-muted', 'volume-down.svg': 'volume-down' },
  'Pictures/Deck icons/Desktop': { 'shortcut.svg': 'key-combo', 'launch.svg': 'command', 'type.svg': 'text-macro', 'clock.svg': 'clock', 'profile.svg': 'profile', 'brightness.svg': 'brightness-up' },
};
// Oldest first, as preferences.json stores them; the picker opens on the
// newest, the last one (seen in a render, not read from the editor's code).
const BOOKMARKS = ['Pictures/Deck icons/Media', 'Pictures/Deck icons/Audio', 'Pictures/Deck icons/Desktop', 'Pictures/Deck icons/Everyday'];

// --- Scratch directories ----------------------------------------------------------
// One fixed path, wiped at the start (see empty-state.mjs for why).

await fs.rm(scratch, { recursive: true, force: true });
// Config and state where they would be under the demo's HOME, so the editor
// shows them as ~/.config/... and ~/.local/state/..., not a /tmp path.
const home = path.join(scratch, 'home');
const configDir = path.join(home, '.config', 'deckhand');
const stateDir = path.join(home, '.local', 'state', 'deckhand');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

for (const [folder, files] of Object.entries(ICON_FOLDERS)) {
  await fs.mkdir(path.join(home, folder), { recursive: true });
  for (const [file, builtin] of Object.entries(files)) {
    await fs.copyFile(path.join(repoRoot, 'assets', 'icons', `${builtin}.svg`), path.join(home, folder, file));
  }
}
// Your fontconfig, read-only by link, so text looks as it does in your editor.
const realFontconfig = path.join(os.homedir(), '.config', 'fontconfig');
if (await fs.stat(realFontconfig).catch(() => null)) {
  await fs.mkdir(path.join(home, '.config'), { recursive: true });
  await fs.symlink(realFontconfig, path.join(home, '.config', 'fontconfig'));
}
await fs.mkdir(path.join(stateDir, 'editor'), { recursive: true });
await fs.writeFile(
  path.join(stateDir, 'editor', 'preferences.json'),
  JSON.stringify({ bookmarks: BOOKMARKS.map((folder) => path.join(home, folder)) }, null, 2) + '\n',
);

// --- Fakes: pactl, the input helper, a player -----------------------------------

await fs.mkdir(path.join(scratch, 'bin'));
await fs.symlink(path.join(repoRoot, 'scripts/test/fake-pactl.mjs'), path.join(scratch, 'bin', 'pactl'));
await fs.writeFile(path.join(scratch, 'devices.json'), JSON.stringify(DEVICES));
await fs.writeFile(path.join(scratch, 'pactl-state.json'), JSON.stringify({ defaultSink: SPEAKERS, defaultSource: HEADSET_MIC }));
process.env.PATH = `${path.join(scratch, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_DEVICES = path.join(scratch, 'devices.json');
process.env.FAKE_PACTL_STATE = path.join(scratch, 'pactl-state.json');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');

const { startFakePlayer } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-mpris-player.mjs')).href);
const player = await startFakePlayer('demo', { status: 'Playing', track: { title: 'Harbour Lights', artist: 'The Night Ferries' } });

// --- The scratch daemon and its decks ---------------------------------------------

// After the config directory exists: dist/config.js reads DECKHAND_CONFIG_DIR
// when it is first imported, and control-harness.mjs imports it.
process.env.DECKHAND_CONFIG_DIR = configDir;
const harness = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const audio = await import(pathToFileURL(path.join(repoRoot, 'dist/services/audio.js')).href);
await audio.refreshCache();
const daemon = await harness.startDaemon(scratch, CONFIG, { audioState: () => audio.cachedState() });
await daemon.attach(XL, new harness.FakeDeck());
await daemon.attach(V2, new harness.FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Stream Deck' }));
daemon.events.state();

console.log(`
  Deckhand demo — everything here is invented, and scratch:
    ${scratch}
  Nothing here touches the installed daemon, the installed editor or your decks.
  This editor has no tray icon; Ctrl-C here to finish.
`);

// --- The editor --------------------------------------------------------------------

const env = {
  ...process.env,
  HOME: home,
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
// Your real XDG directories would take precedence over the demo's HOME.
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_PICTURES_DIR']) delete env[name];
// VS Code sets this for processes started from it, and it turns the Electron
// binary into plain Node with no BrowserWindow.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [editorRoot], { env, stdio: 'inherit' });

// One way out, whichever comes first. Ctrl-C reaches every process in the
// group, dbus-daemon included, so the private bus can vanish under the fake
// player and the daemon's player service before this process has even seen
// its SIGINT; their errors must not end it before the scratch directory is
// gone. So a signal and an uncaught error both come here, once, and the
// directory is removed first.
let shuttingDown = false;
const exited = new Promise((resolve) => child.on('exit', resolve));
async function shutDown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // SIGKILL: Electron does not always go on the first ask (empty-state.mjs).
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  await fs.rm(scratch, { recursive: true, force: true });
  // Bounded: control.stop() waits on the editor's open connection (empty-state.mjs).
  await Promise.race([daemon.stop().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
  await player.stop().catch(() => undefined);
  process.exit(code);
}
process.on('uncaughtException', (err) => {
  if (!shuttingDown) console.error(`demo: ${err.stack ?? err.message}`);
  void shutDown(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutDown(0));

// The window closed some other way (or a screenshot run finished).
await exited;
await shutDown(0);
