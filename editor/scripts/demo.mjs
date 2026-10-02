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
// - A fake OBS (scripts/test/fake-obs.mjs) with invented scenes and inputs,
//   set up in the demo's own credentials.json, so the OBS keys draw connected
//   and Settings shows OBS set up. Never your OBS, never port 4455.
//
// Usage, from editor/ after npm run build (and the daemon's npm run build:ts):
//
//   node scripts/demo.mjs                  one deck shown, the Desk profile
//   node scripts/demo.mjs --view multi     both decks shown, side by side on the canvas
//   node scripts/demo.mjs --view obs       both decks on the Stream profile: OBS keys, live
//   node scripts/demo.mjs --view settings  the Stream profile, Settings' defaults as shipped
//
// Closing the editor's window reopens it on the same state (the daemon keeps
// running), so positions, locks and the decks shown can be seen surviving a
// restart. Ctrl-C in this terminal to finish; that also removes the scratch
// directory.

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

const VIEWS = ['default', 'multi', 'obs', 'settings'];
const viewAt = process.argv.indexOf('--view');
const VIEW = viewAt === -1 ? 'default' : process.argv[viewAt + 1];
if (!VIEWS.includes(VIEW)) {
  console.error(`demo: --view takes one of ${VIEWS.join(', ')}`);
  process.exit(2);
}

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

// The fake OBS's invented scenes, inputs and sources (OBS's own order, top first).
const OBS_SCENES = ['Starting soon', 'Gameplay', 'Just chatting', 'Be right back', 'Ending'];
const OBS_SCENE_ITEMS = {
  'Starting soon': [{ id: 1, source: 'Countdown', enabled: true }],
  Gameplay: [
    { id: 1, source: 'Alerts', enabled: true },
    { id: 2, source: 'Webcam', enabled: true },
    { id: 3, source: 'Game capture', enabled: true },
  ],
  'Just chatting': [
    { id: 1, source: 'Chat box', enabled: false },
    { id: 2, source: 'Webcam', enabled: true },
  ],
  'Be right back': [{ id: 1, source: 'Slideshow', enabled: true }],
  Ending: [{ id: 1, source: 'Credits', enabled: true }],
};
const scene = (name, label) => ({ label, action: { type: 'obs.scene', scene: name } });
const obsMute = (input, label) => ({ label, action: { type: 'obs.mute', input } });
const obsSource = (sceneName, source, label) => ({ label, action: { type: 'obs.source', scene: sceneName, source } });

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
  // Settings too, so its Integrations section reads "Set up, and connected":
  // OBS is connected only while a shown page has an OBS key.
  startProfile: VIEW === 'obs' || VIEW === 'settings' ? 'stream' : 'desk',
};
CONFIG.profiles.stream = {
  name: 'Stream',
  layouts: {
    [XL]: {
      startPage: 'main',
      pages: {
        main: {
          name: 'Live',
          buttons: {
            0: { action: { type: 'obs.stream' } },
            1: { action: { type: 'obs.record' } },
            2: { action: { type: 'obs.recordPause' } },
            4: obsMute('Mic/Aux', 'Mic'),
            5: obsMute('Desktop Audio', 'Desktop'),
            6: obsMute('Music', 'Music'),
            7: { action: { type: 'clock' } },
            8: scene('Starting soon', 'Start'),
            9: scene('Gameplay', 'Game'),
            10: scene('Just chatting', 'Chat'),
            11: scene('Be right back', 'BRB'),
            12: scene('Ending', 'End'),
            16: obsSource('Gameplay', 'Webcam', 'Webcam'),
            17: obsSource('Gameplay', 'Alerts', 'Alerts'),
            18: obsSource('Just chatting', 'Chat box', 'Chatbox'),
            24: { ...media[0] },
            25: { ...media[2] },
            28: { action: { type: 'audio.micMute' } },
            31: { label: 'Desk', action: { type: 'profile', to: 'desk' } },
          },
        },
      },
    },
    [V2]: {
      startPage: 'main',
      pages: {
        main: {
          name: 'Live',
          buttons: {
            0: { action: { type: 'obs.stream' } },
            1: { action: { type: 'obs.record' } },
            2: obsMute('Mic/Aux', 'Mic'),
            5: scene('Gameplay', 'Game'),
            6: scene('Just chatting', 'Chat'),
            7: scene('Be right back', 'BRB'),
            10: obsSource('Gameplay', 'Webcam', 'Webcam'),
            14: { label: 'Desk', action: { type: 'profile', to: 'desk' } },
          },
        },
      },
    },
  },
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
// Close to tray off: the private bus has no tray host, yet Electron's Tray is
// still built, so a closed window would hide with nothing to bring it back
// (the gap the installer's tray warning names) — and the demo reopens the
// editor on a close only if it quits. Tick it in Settings before shooting the
// settings screenshot, where the default (on) should show.
// --view settings keeps the shipped default (on), so the screenshot shows it;
// closing that window then hides it for good — Ctrl-C to finish.
// --view multi and obs show both decks, the V2 to the right of the XL, by a
// key's width, centred on its height — positions are key units (deck-positions.ts).
const both = VIEW === 'multi' || VIEW === 'obs';
const PREFERENCES = {
  bookmarks: BOOKMARKS.map((folder) => path.join(home, folder)),
  closeToTray: VIEW === 'settings',
  ...(both ? { shownDecks: [XL, V2], deckPositions: { [XL]: { x: 0, y: 0 }, [V2]: { x: 9, y: 0.5 } } } : {}),
};
await fs.writeFile(path.join(stateDir, 'editor', 'preferences.json'), JSON.stringify(PREFERENCES, null, 2) + '\n');

// --- Fakes: pactl, the input helper, a player -----------------------------------

await fs.mkdir(path.join(scratch, 'bin'));
await fs.symlink(path.join(repoRoot, 'scripts/test/fake-pactl.mjs'), path.join(scratch, 'bin', 'pactl'));
await fs.writeFile(path.join(scratch, 'devices.json'), JSON.stringify(DEVICES));
await fs.writeFile(path.join(scratch, 'pactl-state.json'), JSON.stringify({ defaultSink: SPEAKERS, defaultSource: HEADSET_MIC }));
process.env.PATH = `${path.join(scratch, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_DEVICES = path.join(scratch, 'devices.json');
process.env.FAKE_PACTL_STATE = path.join(scratch, 'pactl-state.json');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');

// The fake OBS: live, on Gameplay, its music muted — so the keys show
// their faces. Set up in the demo's credentials.json, where the daemon reads it
// (DECKHAND_STATE_DIR, below), with an invented password.
const { startFakeObs } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-obs.mjs')).href);
// On OBS's default port when nothing listens there, so Settings shows 4455 as
// a reader's would; if your OBS has it, a free port instead. The fake is the
// server: the demo never talks to your OBS. An OBS started during the demo
// finds 4455 taken, and its WebSocket server off, until the demo ends.
const fakeObs = await startFakeObs({ password: 'demo-password-not-real', port: 4455 }).catch(() =>
  startFakeObs({ password: 'demo-password-not-real' }),
);
if (fakeObs.port !== 4455) console.log(`  OBS's port 4455 is taken (your OBS?): the demo's fake OBS is on ${fakeObs.port}.`);
fakeObs.scenes = OBS_SCENES;
fakeObs.items = OBS_SCENE_ITEMS;
fakeObs.program = 'Gameplay';
fakeObs.streaming = true;
fakeObs.inputs = [
  { name: 'Mic/Aux', caps: 1 << 1, muted: false },
  { name: 'Desktop Audio', caps: 1 << 1, muted: false },
  { name: 'Music', caps: 1 << 1, muted: true },
  { name: 'Webcam', caps: 1 << 0, muted: false },
];
await fs.writeFile(
  path.join(stateDir, 'credentials.json'),
  JSON.stringify({ obs: { host: '127.0.0.1', port: fakeObs.port, password: fakeObs.password } }, null, 2) + '\n',
  { mode: 0o600 },
);

const { startFakePlayer } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-mpris-player.mjs')).href);
const player = await startFakePlayer('demo', { status: 'Playing', track: { title: 'Harbour Lights', artist: 'The Night Ferries' } });

// --- The scratch daemon and its decks ---------------------------------------------

// After the config directory exists: dist/config.js reads DECKHAND_CONFIG_DIR
// when it is first imported, and control-harness.mjs imports it.
process.env.DECKHAND_CONFIG_DIR = configDir;
// The demo's state directory for the daemon too, where its credentials.json is
// (control-harness.mjs would otherwise give it a scratch one of its own).
process.env.DECKHAND_STATE_DIR = stateDir;
const harness = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const audio = await import(pathToFileURL(path.join(repoRoot, 'dist/services/audio.js')).href);
await audio.refreshCache();
const daemon = await harness.startDaemon(scratch, CONFIG, { audioState: () => audio.cachedState() }, { obsDemand: true });
await daemon.attach(XL, new harness.FakeDeck());
await daemon.attach(V2, new harness.FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Stream Deck' }));
daemon.events.state();

console.log(`
  Deckhand demo — everything here is invented, and scratch:
    ${scratch}
  Nothing here touches the installed daemon, the installed editor or your decks.
  This editor has no tray icon. Closing its window reopens it on the same
  state, with the daemon still running — to see what an editor remembers
  (the decks shown, where they are, which are locked). Ctrl-C here to finish.
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

// Closing the window reopens the editor against the same scratch state, so
// what it remembers across a restart can be seen (positions, locks, the decks
// shown), with the daemon already running. An editor that fails, or goes
// within a few seconds of opening, ends the demo instead of looping.
const REOPEN_AFTER_MS = 3000;
let child;
let exited;
function open() {
  child = spawn(electronPath, [editorRoot], { env, stdio: 'inherit' });
  exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}
open();

// One way out, whichever comes first. Ctrl-C reaches every process in the
// group, dbus-daemon included, so the private bus can vanish under the fake
// player and the daemon's player service before this process has even seen
// its SIGINT; their errors must not end it before the scratch directory is
// gone. So a signal and an uncaught error both come here, once, and the
// directory is removed first.
let shuttingDown = false;
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
  await fakeObs.stop().catch(() => undefined);
  process.exit(code);
}
process.on('uncaughtException', (err) => {
  if (!shuttingDown) console.error(`demo: ${err.stack ?? err.message}`);
  void shutDown(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutDown(0));

for (;;) {
  const opened = Date.now();
  const code = await exited;
  if (shuttingDown) break;
  if (code !== 0 || Date.now() - opened < REOPEN_AFTER_MS) {
    await shutDown(code === 0 ? 0 : 1);
    break;
  }
  console.log('  The editor closed; reopening it on the same state. Ctrl-C here to finish.');
  open();
}
