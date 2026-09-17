// M4 phase C2: the action forms, end to end in real Electron — each form's
// controls write exactly the settings they name, and nothing else.
//
// The renderer drives the forms through the UI (src/renderer/checks.ts,
// "forms"); this script checks the saved config.json, that the daemon took
// every save, and that the state icons chosen on the Icon tab were put on the
// deck first. HOME is a scratch directory, so the icon picker never lists the
// real one.
//
// Usage: npm run check:forms   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-forms-'));
const configDir = path.join(scratch, 'config');
const home = path.join(scratch, 'home');
await fs.mkdir(configDir);
await fs.mkdir(path.join(home, 'Pictures'), { recursive: true });
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
process.env.HOME = home;
// The fake pactl, for the device forms' lists; FAKE_PACTL_STATE lets the check take a device away.
const PACTL_STATE = path.join(scratch, 'pactl-state.json');
await fs.mkdir(path.join(scratch, 'bin'));
await fs.symlink(path.join(repoRoot, 'scripts/test/fake-pactl.mjs'), path.join(scratch, 'bin', 'pactl'));
process.env.PATH = `${path.join(scratch, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_STATE = PACTL_STATE;
await fs.writeFile(PACTL_STATE, '{}');
const audio = await import(pathToFileURL(path.join(repoRoot, 'dist/services/audio.js')).href);
await audio.refreshCache();
const { FakeDeck, startDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { loadConfig, watchConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist/config.js')).href);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const SERIAL = 'FORMS-XL';
const BUTTONS = {
  1: { label: 'Vol', icon: 'builtin:headset', action: { type: 'hotkey', keys: 'ctrl+1' } },
  3: { action: { type: 'media.control' } },
  4: { action: { type: 'audio.micMute' } },
  5: { action: { type: 'media.info' } },
  6: { action: { type: 'noop' } },
  7: { action: { type: 'media.control', player: 'tidal' } },
  8: { icon: '~/own.png', action: { type: 'audio.mute' } },
  10: { action: { type: 'audio.source', node: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source', label: 'Built-in Microphone' } },
  12: { action: { type: 'audio.sink', match: 'headset' } },
  14: { action: { type: 'hotkey', keys: 'ctrl+1' } },
  17: { action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f23', state: 'up' } },
};
const CONFIG = {
  decks: { [SERIAL]: {} },
  startProfile: 'default',
  profiles: { default: { name: 'Default', layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: BUTTONS } } } } } },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG, { audioState: () => audio.cachedState() });
await daemon.attach(SERIAL, new FakeDeck());
let refusedReloads = 0;
const stopWatching = watchConfig(async () => {
  try {
    const { config } = await loadConfig();
    daemon.state.config = config;
    daemon.state.lastReload = { ok: true, at: new Date().toISOString() };
    daemon.events.config();
    await daemon.profiles.applyReload(config, daemon.sessions);
  } catch (err) {
    refusedReloads++;
    daemon.state.lastReload = { ok: false, at: new Date().toISOString(), error: err.message };
    daemon.events.config();
  }
});
// Which keys the editor put a preview on: a state icon must go on the deck before it is saved.
const session = daemon.sessions.get(SERIAL);
const previewed = [];
const setPreview = session.setPreview.bind(session);
session.setPreview = (index, button) => {
  previewed.push({ index, button: structuredClone(button) });
  return setPreview(index, button);
};

// The handshake: a preview on key 31 means "unplug the built-in microphone now".
let unplugged = false;
const unplugTimer = setInterval(async () => {
  if (unplugged || !session.previewKeys().includes(31)) return;
  unplugged = true;
  await fs.writeFile(PACTL_STATE, JSON.stringify({ absent: ['alsa_input.pci-0000_00_1f.3.HiFi__Mic__source'] }));
  await audio.refreshCache();
  daemon.events.audio();
}, 50);

const output = await runElectronCheck('forms', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 120_000, { HOME: home });
clearInterval(unplugTimer);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr.slice(-3000)}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout.slice(-3000)}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('Clock: a library click on an empty key writes it at once; the format writes format, and the default removes it', () => {
    assert.deepEqual(r.clock, [{ type: 'clock' }, { type: 'clock', format: 'HH:mm:ss' }, { type: 'clock' }]);
  });
  check('Volume: a click retargets a hotkey key at once, keeping label and icon; direction, step and level write delta and showLevel', () => {
    assert.deepEqual(r.volume, [
      { label: 'Vol', icon: 'builtin:headset', action: { type: 'audio.volume' } },
      { label: 'Vol', icon: 'builtin:headset', action: { type: 'audio.volume', delta: -5 } },
      { label: 'Vol', icon: 'builtin:headset', action: { type: 'audio.volume', delta: -10 } },
      { label: 'Vol', icon: 'builtin:headset', action: { type: 'audio.volume', delta: -10, showLevel: true } },
    ]);
  });
  check('Brightness: nothing is written until a choice, then delta or value — never both', () => {
    assert.deepEqual(r.brightness, [null, { type: 'brightness', delta: -10 }, { type: 'brightness', value: 50 }, { type: 'brightness', value: 30 }]);
  });
  check('Media control: the method writes method, play/pause removes it; the state icons show only for play/pause', () => {
    assert.deepEqual(r.mediaControl, {
      next: { type: 'media.control', method: 'next' },
      pairShownForNext: false,
      back: { type: 'media.control' },
      pairShownForPlayPause: ['While playing', 'While paused'],
    });
  });
  check('Mic mute: the labels write labelMuted/labelUnmuted; "Choose…" opens the Icon tab on that state', () => {
    assert.deepEqual(r.micLabels, { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live' });
    assert.deepEqual(r.slotOpened, { tab: 'Icon', slot: 'While muted' });
  });
  check('a state icon chosen from Built-in is written on the action by name — the key icon untouched — and put on the deck first, without the action', () => {
    assert.deepEqual(r.micIcons, {
      afterMuted: { action: { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live', iconMuted: 'builtin:speaker-muted' } },
      afterUnmuted: { action: { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live', iconMuted: 'builtin:speaker-muted', iconUnmuted: 'builtin:headset' } },
      gridShowsUnmuted: true,
      formSays: { iconMuted: 'Built-in: speaker-muted', iconUnmuted: 'Built-in: headset' },
      keySlotCurrent: [],
      cleared: { action: { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live', iconUnmuted: 'builtin:headset' } },
    });
    const muted = previewed.find((p) => p.index === 4 && p.button.icon === 'builtin:speaker-muted');
    assert.ok(muted, `no preview of the muted icon on key 4: ${JSON.stringify(previewed)}`);
    assert.equal(muted.button.action, undefined, 'previewed with the action, which would draw the current state instead');
  });
  check('Now playing: shows, art, pressing and idle label each write their one setting', () => {
    assert.deepEqual(r.mediaInfo, { type: 'media.info', show: 'title', showArt: false, pressAction: 'none', idleLabel: 'Quiet' });
  });
  check('Nothing has a form and no JSON; a media key with a setting the form lacks (player) is read-only', () => {
    assert.deepEqual([r.noopForm, r.noopJson, r.playerReadOnly], [true, false, true]);
  });
  check('Output device: nothing written until a device is picked; the list is the daemon\'s (network sink left out, an unplugged jack and a mangled name as reported); node and label written; moving streams off writes moveStreams', () => {
    assert.deepEqual(r.output.list, [
      'Example Headset Analog Stereo|alsa_output.usb-Example_Headset-00.analog-stereo — in use now',
      'Example Headset Mono|alsa_output.usb-Example_Headset-00.mono-chat',
      'Built-in Headphones|alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink — nothing plugged in',
      'alsa_output.usb-Accented_Device-00.analog-stereo|alsa_output.usb-Accented_Device-00.analog-stereo',
    ]);
    assert.deepEqual(r.output.writes, [
      null,
      { type: 'audio.sink', node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono' },
      { type: 'audio.sink', node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono', moveStreams: false },
    ]);
  });
  check('Input device: a stored device that is unplugged stays chosen and says so, from the audio event; picking another writes it', () => {
    assert.equal(unplugged, true, 'the renderer never signalled');
    assert.deepEqual(r.input, {
      before: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source',
      missingShown: true,
      picked: { type: 'audio.source', node: 'alsa_input.usb-Example_Headset-00.mono-fallback', label: 'Example Headset Mono Mic' },
    });
  });
  check('Cycle outputs: add, reorder and remove write the ordered devices; fewer than two is marked "not set up"; the name toggle writes showCurrent', () => {
    assert.deepEqual(r.cycle, {
      markWithOne: 'not set up',
      // Added analog stereo, headphones, mono; mono moved above headphones; analog stereo removed.
      order: ['alsa_output.usb-Example_Headset-00.mono-chat', 'alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink'],
      markWithTwo: null,
      final: {
        type: 'audio.cycle',
        devices: [
          { node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono' },
          { node: 'alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink', label: 'Built-in Headphones' },
        ],
        showCurrent: false,
      },
    });
  });
  check('a hand-edited output key using match is read-only', () => assert.equal(r.matchReadOnly, true));
  check('Type text: nothing written by focusing and leaving; typed text written with an estimate; a character the layout cannot type is refused and not saved', () => {
    assert.deepEqual(r.text, { afterBlur: null, typed: { type: 'text', text: 'Hi!\nok' }, estimate: true, refusedShown: true, refusedNotSaved: { type: 'text', text: 'Hi!\nok' } });
  });
  check('Hotkey hold and repeat write holdMs and repeat; back to 0 and 1 removes them', () => {
    assert.deepEqual(r.hotkeyExtras, [
      { type: 'hotkey', keys: 'ctrl+1', holdMs: 250 },
      { type: 'hotkey', keys: 'ctrl+1', holdMs: 250, repeat: 3 },
      { type: 'hotkey', keys: 'ctrl+1', repeat: 3 },
      { type: 'hotkey', keys: 'ctrl+1' },
    ]);
  });
  check('Press/Release: a library click listens; the pressed key is written as keyHold down and up; the phases say so; Clear removes both', () => {
    assert.deepEqual(r.pressRelease, {
      listening: true,
      saved: { action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } },
      phases: ['On presshold F24 down', 'On releaselet F24 go'],
      cleared: null,
    });
  });
  check('Run command: the command is written; emptied, the setting goes and the key is marked "not set up"', () => {
    assert.deepEqual(r.command, { typed: { type: 'command', command: 'kate ~/notes.md' }, emptied: { type: 'command' }, mark: 'not set up' });
  });
  check('a key holding one key and releasing another is read-only', () => assert.equal(r.oddPairReadOnly, true));
  check("a mute key with its own icon says each state falls back to it, and why it stops swapping", () => {
    assert.deepEqual(r.ownIcon, { iconMuted: "the key's own icon (~/own.png)", iconUnmuted: "the key's own icon (~/own.png)", note: true });
  });
}

const saved = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
check('the saved file holds exactly what the forms wrote', () => {
  const expected = structuredClone(CONFIG);
  expected.profiles.default.layouts[SERIAL].pages.main.buttons = {
    0: { action: { type: 'clock' } },
    1: { label: 'Vol', icon: 'builtin:headset', action: { type: 'audio.volume', delta: -10, showLevel: true } },
    2: { action: { type: 'brightness', value: 30 } },
    3: { action: { type: 'media.control' } },
    4: { action: { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live', iconUnmuted: 'builtin:headset' } },
    5: { action: { type: 'media.info', show: 'title', showArt: false, pressAction: 'none', idleLabel: 'Quiet' } },
    6: BUTTONS[6],
    7: BUTTONS[7],
    8: BUTTONS[8],
    9: { action: { type: 'audio.sink', node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono', moveStreams: false } },
    10: { action: { type: 'audio.source', node: 'alsa_input.usb-Example_Headset-00.mono-fallback', label: 'Example Headset Mono Mic' } },
    11: r?.cycle?.final ? { action: r.cycle.final } : '(cycle not reached)',
    12: BUTTONS[12],
    13: { action: { type: 'text', text: 'Hi!\nok' } },
    14: BUTTONS[14],
    16: { action: { type: 'command' } },
    17: BUTTONS[17],
  };
  assert.deepEqual(saved, expected);
});
check('the daemon took every save', () => {
  assert.equal(refusedReloads, 0);
  assert.deepEqual(daemon.state.config, saved);
});

if (failures > 0) console.log(`\nrenderer report:\n${JSON.stringify(r, null, 2)}`);
stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
