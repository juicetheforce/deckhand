/**
 * Offline test for sliders and dials (round 5; src/value-controls.ts,
 * src/value-face.ts, DeckSession's value path, the virtual driver following
 * a finger):
 *
 * - **the model**: a control's kind, direction and touch, a key's layers and
 *   angles, validated; a template keeps the kind;
 * - **the built-in art**: the generator at board 26a's sizes is exactly the
 *   files in assets/art/; the toggle switch pair is among the built-in icons;
 * - **the face**: the thumb at the level, the fill shown up to it, the ring
 *   swept from the start angle, the knob turned, the held look, None layers,
 *   a label's band, a refused image drawn as the built-in and said once;
 * - **touch, through the real driver and a session** (fake helper, fake
 *   pactl, fake logind): a finger on a slider or dial is followed and a
 *   button's is not; Drag only moves by how far the finger moves and a tap
 *   changes nothing; Jump to touch goes to the finger; a dial turns with the
 *   finger round its centre; **one write at a time, the newest waiting**, so
 *   a burst of moves is a few pactl calls; the last write re-reads the cache;
 *   **a change made outside Deckhand moves the fill**, from pactl subscribe's
 *   event, never a poll; nothing at rest; **a lock or a page change ends a
 *   drag with the value where it is**; a brightness slider sets its own deck
 *   to 0 and touch still turns it back up; a device not there fails once per
 *   drag, marked and notified, and writes nothing more; the status reports
 *   each value.
 *
 * Nothing here touches the real desktop: pactl is the fake (its state in a
 * scratch file), the input helper is the fake (set before any import, so no
 * key can be typed), and logind is a fake on a private bus.
 *
 *   npm run build:ts && node scripts/smoke-values.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// Fakes first: src/input.js reads DECKHAND_INPUT_BIN when it is imported, and a
// session can start the input helper; the real one would type into this desktop.
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-values-'));
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(TMP, 'bin', 'pactl'));
const PACTL_LOG = path.join(TMP, 'pactl.log');
const PACTL_STATE = path.join(TMP, 'pactl.json');
await fs.writeFile(PACTL_STATE, '{}');
const { edid, fakeSysfs, ILITEK, ILITEK_NODES } = await import('./test/fake-sysfs.mjs');
const sysfs = fakeSysfs(TMP);
const LOG = path.join(TMP, 'panel.log');
const SOCKS = path.join(TMP, 'socks');
await fs.mkdir(SOCKS);
await fs.writeFile(
  path.join(TMP, 'bus.conf'),
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${TMP}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
);
const [busAddress, busPid] = execFileSync('dbus-daemon', ['--config-file', path.join(TMP, 'bus.conf'), '--fork', '--print-address=1', '--print-pid=1']).toString().trim().split('\n');
Object.assign(process.env, {
  PATH: `${path.join(TMP, 'bin')}:${process.env.PATH}`,
  FAKE_PACTL_LOG: PACTL_LOG,
  FAKE_PACTL_STATE: PACTL_STATE,
  DECKHAND_DRM_DIR: sysfs.drm,
  DECKHAND_INPUT_DIR: sysfs.input,
  DECKHAND_UDEV_DATA_DIR: sysfs.udev,
  DECKHAND_DEV_INPUT_DIR: sysfs.dev,
  DECKHAND_PANEL_BIN: path.join(REPO, 'scripts/test/fake-panel.mjs'),
  DECKHAND_STATE_DIR: path.join(TMP, 'state'),
  FAKE_PANEL_LOG: LOG,
  FAKE_PANEL_INPUT_DIR: SOCKS,
  FAKE_PANEL_RGBA_MAX: String(400 * 400 * 4),
  DBUS_SYSTEM_BUS_ADDRESS: busAddress,
});

const { validateConfig } = await import(path.join(REPO, 'dist/config.js'));
const vc = await import(path.join(REPO, 'dist/value-controls.js'));
const { valueArt, composeValue, clearValueArt } = await import(path.join(REPO, 'dist/value-face.js'));
const { BUILTIN_ICONS } = await import(path.join(REPO, 'dist/default-icons.js'));
const { createVirtualDriver } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));
const audio = await import(path.join(REPO, 'dist/services/audio.js'));
const { startFakeLogind } = await import('./test/fake-logind.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const realError = console.error.bind(console);
console.error = (...a) => (errors.push(a.join(' ')), realError(...a));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
const settle = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    check(`${name} (threw)`, false, err.stack ?? String(err));
  }
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
};

// ---------------------------------------------------------------------------
console.log('the model');
const panelWith = (controls) => ({ size: { width: 1920, height: 720 }, preset: 'free', controls });
const withPage = (page) => ({ profiles: { p: { layouts: { 'GRA-6e4e': { pages: { a: page } } } } } });
check('a slider and a dial with direction and touch are valid', !throws(() => validateConfig(withPage({ panel: panelWith([{ id: 's', x: 0, y: 0, w: 60, h: 240, kind: 'slider', direction: 'horizontal', touch: 'jump' }, { id: 'd', x: 100, y: 0, w: 100, h: 100, kind: 'dial' }]), buttons: {} }))));
check('an unknown kind is refused', /"kind" must be/.test(throws(() => validateConfig(withPage({ panel: panelWith([{ id: 's', x: 0, y: 0, w: 60, h: 60, kind: 'fader' }]), buttons: {} }))) ?? ''));
check('a direction on a button, or a touch on a dial, is refused', /"direction" is a slider's/.test(throws(() => validateConfig(withPage({ panel: panelWith([{ id: 's', x: 0, y: 0, w: 60, h: 60, direction: 'vertical' }]), buttons: {} }))) ?? '') && /"touch" is a slider's/.test(throws(() => validateConfig(withPage({ panel: panelWith([{ id: 'd', x: 0, y: 0, w: 60, h: 60, kind: 'dial', touch: 'jump' }]), buttons: {} }))) ?? ''));
check('layers: paths, and None only for fill, base and ring', !throws(() => validateConfig(withPage({ buttons: { s: { layers: { track: '~/a.png', fill: null, thumb: 'builtin:switch-on', base: null, ring: null, knob: '/k.png' } } } }))));
check('…None for a thumb, track or knob is refused, and so is an unknown layer', /"layers.thumb"/.test(throws(() => validateConfig(withPage({ buttons: { s: { layers: { thumb: null } } } }))) ?? '') && /not a layer/.test(throws(() => validateConfig(withPage({ buttons: { s: { layers: { meter: 'x.png' } } } }))) ?? ''));
check('angles: −135 to 135 valid; a sweep under 10° or over a turn refused', !throws(() => validateConfig(withPage({ buttons: { s: { angles: { start: -135, end: 135 } } } }))) && /"angles"/.test(throws(() => validateConfig(withPage({ buttons: { s: { angles: { start: 0, end: 5 } } } }))) ?? '') && /"angles"/.test(throws(() => validateConfig(withPage({ buttons: { s: { angles: { start: -200, end: 200 } } } }))) ?? ''));
check('a template keeps a slider and its direction', !throws(() => validateConfig({ ...withPage({ buttons: {} }), templates: [{ name: 'Mixer', panel: panelWith([{ id: 's', x: 0, y: 0, w: 60, h: 240, kind: 'slider', direction: 'vertical', touch: 'drag' }]) }] })));
check('only Volume, Brightness and User volume take a value', vc.VALUE_ACTIONS.join() === 'audio.volume,brightness,discord.userVolume' && vc.takesValue('brightness') && !vc.takesValue('hotkey') && !vc.takesValue(undefined));

console.log('the built-in art');
for (const [file, svg] of [
  ['slider-track', vc.sliderLayerSvg('track', vc.ART_REFERENCE.slider, 'vertical', '#8f9cf0')],
  ['slider-fill', vc.sliderLayerSvg('fill', vc.ART_REFERENCE.slider, 'vertical', '#8f9cf0')],
  ['slider-thumb', vc.sliderLayerSvg('thumb', vc.ART_REFERENCE.slider, 'vertical', '#8f9cf0')],
  ['dial-base', vc.dialLayerSvg('base', vc.ART_REFERENCE.dial, vc.DEFAULT_ANGLES, '#8f9cf0')],
  ['dial-ring', vc.dialLayerSvg('ring', vc.ART_REFERENCE.dial, vc.DEFAULT_ANGLES, '#8f9cf0')],
  ['dial-knob', vc.dialLayerSvg('knob', vc.ART_REFERENCE.dial, vc.DEFAULT_ANGLES, '#8f9cf0')],
]) {
  check(`assets/art/${file}.svg is the generator's art at board 26a's size`, readFileSync(path.join(REPO, 'assets/art', `${file}.svg`), 'utf8').trim() === svg);
}
check('the board\'s slider numbers: track 17.48/4.76 by 11.04 × 120.48, thumb 35.88 × 16.56 at the middle', /x="17.48" y="4.76" width="11.04" height="120.48"/.test(vc.sliderLayerSvg('track', vc.ART_REFERENCE.slider, 'vertical', '#8f9cf0')) && /y="56.72" width="35.88" height="16.56"/.test(vc.sliderLayerSvg('thumb', vc.ART_REFERENCE.slider, 'vertical', '#8f9cf0')));
check('…and the dial\'s arc from −135° to 135°', vc.dialLayerSvg('base', vc.ART_REFERENCE.dial, vc.DEFAULT_ANGLES, '#8f9cf0').includes('M14.35 61.65 A33.44 33.44 0 1 1 61.65 61.65'));
check('the toggle switch, off and on, among the built-in icons', BUILTIN_ICONS.includes('switch-off') && BUILTIN_ICONS.includes('switch-on'));
check('the art takes its action\'s colour', vc.artColour('brightness') === '#e8b45a' && vc.artColour('discord.userVolume') === '#5ab8f5' && vc.artColour('audio.volume') === '#8f9cf0' && vc.artColour(undefined) === '#8f9cf0');

console.log('how a finger moves them');
const t = { start: 10, end: 210, thumb: 20 };
check('the level runs from the track\'s start plus half the thumb to its end less half', vc.levelAt(0, t) === 20 && vc.levelAt(1, t) === 200 && vc.levelAt(0.5, t) === 110 && vc.levelAt(2, t) === 200);
check('Jump to touch: the value at a point, up being higher on a vertical slider', Math.abs(vc.valueAtPoint({ x: 0, y: 240 - 110 }, { w: 60, h: 240 }, 'vertical', t) - 0.5) < 1e-9 && vc.valueAtPoint({ x: 200, y: 0 }, { w: 240, h: 60 }, 'horizontal', t) === 1);
check('a dial: the shortest turn, so crossing straight down is not a whole turn', vc.turnBetween(170, -170) === 20 && vc.turnBetween(-170, 170) === -20 && vc.turnBetween(0, 90) === 90);
check('a finger\'s angle round the centre: up 0°, right 90°, left −90°', vc.angleAround({ x: 50, y: 0 }, { w: 100, h: 100 }) === 0 && vc.angleAround({ x: 100, y: 50 }, { w: 100, h: 100 }) === 90 && vc.angleAround({ x: 0, y: 50 }, { w: 100, h: 100 }) === -90);

// ---------------------------------------------------------------------------
console.log('the face');
const px = (buf, w, x, y) => [...buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
/** The thumb's cut line, the darkest run down the middle column: its row. */
function thumbRow(buf, w, h, held = false) {
  const rows = [];
  // Held, the line is lightened 22% (to about 70) with the rest of the thumb.
  const dark = held ? 80 : 40;
  for (let y = 0; y < h; y++) {
    const [r, g, b, a] = px(buf, w, Math.floor(w / 2), y);
    if (a > 200 && r < dark && g < dark && b < dark + 10) rows.push(y);
  }
  return rows.length === 0 ? -1 : rows.reduce((s, y) => s + y, 0) / rows.length;
}
const base = { labelColor: '#ffffff', labelSize: 14, angles: { start: -135, end: 135 }, type: 'audio.volume' };
await settle('the face', async () => {
  const s = await valueArt({ ...base, kind: 'slider', width: 60, height: 240 });
  const travel = vc.builtinSliderTravel({ w: 60, h: 240 }, 'vertical');
  check('the built-in slider\'s travel is measured from its art', Math.abs(s.travel.start - travel.start) <= 1.5 && Math.abs(s.travel.end - travel.end) <= 1.5 && Math.abs(s.travel.thumb - travel.thumb) <= 2, JSON.stringify([s.travel, travel]));
  for (const v of [0, 0.5, 1]) {
    const row = thumbRow(composeValue(s, v, false), 60, 240);
    const want = 240 - vc.levelAt(v, s.travel);
    check(`the thumb at ${v * 100}%: its line at the level`, Math.abs(row - want) <= 1.5, `${row} vs ${want}`);
  }
  const half = composeValue(s, 0.5, false);
  const fillColour = (y) => px(half, 60, 30, y);
  check('the fill is shown below the level and not above it (only the track\'s faint fill there)', fillColour(200)[3] > 200 && fillColour(40)[3] < 100, JSON.stringify([fillColour(200), fillColour(40)]));
  check('the same value again is the same Buffer (the session skips the write)', composeValue(s, 0.5, false) === half);
  const held = composeValue(s, 0.5, true);
  check('held: the thumb drawn lighter, with its halo past the thumb\'s edge', held !== half && px(held, 60, 30, Math.round(240 - vc.levelAt(0.5, s.travel)) + 9)[0] > px(half, 60, 30, Math.round(240 - vc.levelAt(0.5, s.travel)) + 9)[0], JSON.stringify([px(held, 60, 30, 130), px(half, 60, 30, 130)]));
  const none = await valueArt({ ...base, kind: 'slider', width: 60, height: 240, layers: { fill: null } });
  check('Fill set to None: nothing below the level but the track\'s faint fill', px(composeValue(none, 0.5, false), 60, 30, 200)[3] < 100);
  const hz = await valueArt({ ...base, kind: 'slider', width: 240, height: 60, direction: 'horizontal' });
  const hface = composeValue(hz, 0.25, false);
  let col = -1;
  for (let x = 0; x < 240; x++) {
    const [r, g, b, a] = px(hface, 240, x, 30);
    if (a > 200 && r < 40 && g < 40 && b < 50) col = x;
  }
  check('a horizontal slider: lowest at the left, the thumb\'s line where the level is', Math.abs(col - vc.levelAt(0.25, hz.travel)) <= 2, `${col} vs ${vc.levelAt(0.25, hz.travel)}`);
  const labelled = await valueArt({ ...base, kind: 'slider', width: 60, height: 240, label: 'MIC' });
  check('a label takes a band at the foot, and the art the rest', labelled.artH < 240 && labelled.artH >= 240 - 30, String(labelled.artH));

  const d = await valueArt({ ...base, kind: 'dial', width: 120, height: 120 });
  const dial = (v) => composeValue(d, v, false);
  // The ring: at 50% (0°, straight up) lit at the top-left of its arc, not at the top-right.
  const ringAt = (face, deg) => {
    const r = 33.44 * (120 / 76);
    const a = (deg * Math.PI) / 180;
    return px(face, 120, Math.round(60 + r * Math.sin(a)), Math.round(60 - r * Math.cos(a)));
  };
  // The ring is the action's colour (red 143); past the level only the base shows, faint white (red 255).
  check('the ring is swept from the start angle round to the level', ringAt(dial(0.5), -90)[0] < 160 && ringAt(dial(0.5), -90)[3] > 200 && ringAt(dial(0.5), 90)[0] > 200 && ringAt(dial(0.5), 90)[3] < 100, JSON.stringify([ringAt(dial(0.5), -90), ringAt(dial(0.5), 90)]));
  // The knob's pointer: at 0.5 it points up (0°); at 1, 135°.
  const pointer = (face, deg) => {
    const r = (38 - 25) * (120 / 76);
    const a = (deg * Math.PI) / 180;
    return px(face, 120, Math.round(60 + r * Math.sin(a)), Math.round(60 - r * Math.cos(a)));
  };
  // The pointer is solid; elsewhere on the knob only its faint fill.
  check('the knob turned to the level: up at 50%, at 135° at 100%', pointer(dial(0.5), 0)[3] > 200 && pointer(dial(1), 135)[3] > 200 && pointer(dial(1), 0)[3] < 100, JSON.stringify([pointer(dial(0.5), 0), pointer(dial(1), 135), pointer(dial(1), 0)]));
  // Angles past −180°: the ring's pixels are counted on from the start angle both ways, not only upwards.
  const wide = await valueArt({ ...base, kind: 'dial', width: 120, height: 120, angles: { start: -270, end: 0 } });
  check('a dial from −270° to 0°: at half, the ring is lit at −225° (drawn where 135° is) and not at −45°', ringAt(composeValue(wide, 0.5, false), 135)[0] < 160 && ringAt(composeValue(wide, 0.5, false), 135)[3] > 200 && ringAt(composeValue(wide, 0.5, false), -45)[0] > 200, JSON.stringify([ringAt(composeValue(wide, 0.5, false), 135), ringAt(composeValue(wide, 0.5, false), -45)]));
  const noBase = await valueArt({ ...base, kind: 'dial', width: 120, height: 120, layers: { base: null, ring: null } });
  check('Base and Level ring set to None: no arc at all', ringAt(composeValue(noBase, 1, false), -90)[3] === 0 && ringAt(composeValue(noBase, 1, false), 120)[3] === 0);
  const round = await valueArt({ ...base, kind: 'dial', width: 120, height: 120, shape: 'round', background: '#203040' });
  check('a background colour fills the shape, and outside a round shape is clear', px(composeValue(round, 0, false), 120, 60, 3)[3] === 255 && px(composeValue(round, 0, false), 120, 1, 1)[3] === 0);

  const big = path.join(TMP, 'big.png');
  await (await import('sharp')).default({ create: { width: 5000, height: 10, channels: 4, background: '#ff0000' } }).png().toFile(big);
  errors.length = 0;
  clearValueArt();
  const refused = await valueArt({ ...base, kind: 'slider', width: 60, height: 240, layers: { thumb: big } });
  const again = await valueArt({ ...base, kind: 'slider', width: 61, height: 240, layers: { thumb: big } });
  check('a layer image the limits refuse is drawn as the built-in layer', thumbRow(composeValue(refused, 0.5, false), 60, 240) > 0 && again !== null);
  check('…and the reason said once, in the limits\' words', errors.filter((l) => l.includes('thumb layer') && l.includes('4096')).length === 1, JSON.stringify(errors));
  const custom = path.join(TMP, 'cap.png');
  await (await import('sharp')).default({ create: { width: 60, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 50, height: 20, channels: 4, background: '#00ff00' } }, top: 110, left: 5 }])
    .png()
    .toFile(custom);
  const capped = await valueArt({ ...base, kind: 'slider', width: 60, height: 240, layers: { thumb: custom } });
  const green = (face) => {
    const rows = [];
    for (let y = 0; y < 240; y++) if (px(face, 60, 30, y)[1] > 200 && px(face, 60, 30, y)[0] < 60) rows.push(y);
    return rows.length ? (rows[0] + rows.at(-1) + 1) / 2 : -1;
  };
  check('a chosen thumb image is drawn to the box and travels as drawn: its centre at the level', Math.abs(green(composeValue(capped, 1, false)) - (240 - vc.levelAt(1, capped.travel))) <= 1.5 && capped.travel.thumb === 20, `${green(composeValue(capped, 1, false))} / ${JSON.stringify(capped.travel)}`);
});

// ---------------------------------------------------------------------------
console.log('touch, through the driver and a session');
await usbDevice();
async function usbDevice() {
  await sysfs.usbDevice('pci0/usb3/3-2.3', '222a');
  for (const node of ILITEK_NODES) await sysfs.inputNode(node);
}
await sysfs.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', name: 'HD Display', widthMm: 243, heightMm: 91 }));
const HEADSET = 'alsa_output.usb-Example_Headset-00.analog-stereo';
const MIC = 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source';
const controls = [
  { id: 's1', x: 100, y: 100, w: 60, h: 240, kind: 'slider' },
  { id: 's2', x: 300, y: 100, w: 240, h: 60, kind: 'slider', direction: 'horizontal', touch: 'jump' },
  { id: 'd1', x: 600, y: 100, w: 120, h: 120, kind: 'dial' },
  { id: 'b1', x: 800, y: 100, w: 100, h: 100 },
  { id: 'br', x: 1000, y: 100, w: 60, h: 240, kind: 'slider' },
  { id: 'ab', x: 1200, y: 100, w: 60, h: 240, kind: 'slider' },
];
const config = validateConfig({
  decks: { 'GRA-6e4e': { name: 'Panel', virtual: { output: 'DP-4', touch: ILITEK } } },
  profiles: {
    p: {
      layouts: {
        'GRA-6e4e': {
          startPage: 'mix',
          pages: {
            mix: {
              panel: panelWith(controls),
              buttons: {
                s1: { action: { type: 'audio.volume', node: HEADSET, label: 'Headset' } },
                s2: { action: { type: 'audio.volume' } },
                d1: { action: { type: 'audio.volume', node: MIC, label: 'Mic', input: true } },
                b1: { action: { type: 'noop' } },
                br: { action: { type: 'brightness' } },
                ab: { action: { type: 'audio.volume', node: 'alsa_output.gone', label: 'Gone' } },
              },
            },
            other: { panel: panelWith([{ id: 'k1', x: 0, y: 0, w: 200, h: 200 }]), buttons: {} },
            // The same controls as "mix", s1 on the mic: a page change here keeps the finger where it is.
            same: { panel: panelWith(controls), buttons: { s1: { action: { type: 'audio.volume', node: MIC, label: 'Mic', input: true } } } },
          },
        },
      },
    },
  },
});
const logind = await startFakeLogind(busAddress);
const driver = createVirtualDriver(() => config);
const notified = [];
let session;
let device;
const stopAudio = audio.subscribe(() => session?.invalidateByType(['audio.volume']));
const frames = async () => (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pactlCalls = async () => (await fs.readFile(PACTL_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const sets = async (verb = 'set-sink-volume') => (await pactlCalls()).filter((l) => l.startsWith(verb));
async function helperSays(...events) {
  const sock = path.join(SOCKS, 'DP-4.sock');
  const said = await until(
    () =>
      new Promise((resolve) => {
        const c = net.connect(sock, () => c.end(events.map((e) => JSON.stringify(e)).join('\n') + '\n', () => resolve(true)));
        c.on('error', () => resolve(false));
      }),
  );
  if (!said) throw new Error('no fake helper listening');
  await sleep(80);
}
const c = (id) => controls.find((k) => k.id === id);
const down = (contact, id, dx = c(id).w / 2, dy = c(id).h / 2) => ({ ev: 'touch', contact, edge: 'down', x: c(id).x + dx, y: c(id).y + dy });
const move = (contact, id, dx, dy) => ({ ev: 'touch', contact, edge: 'move', x: c(id).x + dx, y: c(id).y + dy });
const up = (contact) => ({ ev: 'touch', contact, edge: 'up' });
const lastFace = async (id) => {
  const f = (await frames()).filter((e) => e.type === 'I' && e.x === c(id).x && e.y === c(id).y && e.rgba).at(-1);
  return f ? Buffer.from(f.rgba, 'base64') : null;
};
const levelOf = async (id, held = false) => {
  const face = await lastFace(id);
  const art = await valueArt({ ...base, kind: 'slider', width: c(id).w, height: c(id).h });
  const row = face ? thumbRow(face, 60, 240, held) : -1;
  return row < 0 ? null : (240 - row - art.travel.start - art.travel.thumb / 2) / vc.travelLength(art.travel);
};

await settle('the session', async () => {
  const found = (await driver.list()).find((f) => f.id === 'GRA-6e4e');
  device = await found.open();
  session = new DeckSession(device, {
    serial: 'GRA-6e4e',
    hardware: config.decks['GRA-6e4e'],
    layout: config.profiles.p.layouts['GRA-6e4e'],
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'p',
    onActionNeeded: (f) => notified.push(f),
  });
  await session.start();
  check('touch ready', await until(() => device.touchState() === 'ready'), device.touchState());
  check('the cache has the devices\' volumes: the headset at 40%', await until(() => audio.cachedVolume({ node: HEADSET }) === 40), String(audio.cachedVolume({ node: HEADSET })));

  await helperSays(down(1, 'b1'), up(1));
  check('a finger on a button is never followed', !(await frames()).some((f) => f.type === 'M'));
  const before = (await sets()).length;
  await helperSays(down(2, 's1'));
  check('a finger on a slider is followed: the helper is asked for its moves', (await frames()).some((f) => f.type === 'M' && f.contact === 2));
  await helperSays(up(2));
  check('Drag only: a tap changes nothing', (await sets()).length === before);

  const art = await valueArt({ ...base, kind: 'slider', width: 60, height: 240 });
  const travel = vc.travelLength(art.travel);
  const steps = [];
  for (let i = 1; i <= 10; i++) steps.push(move(3, 's1', 30, 120 - (travel / 2) * (i / 10)));
  await helperSays(down(3, 's1'), ...steps);
  await until(async () => (await sets()).at(-1) === `set-sink-volume ${HEADSET} 90%`);
  const drag = (await sets()).slice(before);
  check('Drag only: the level moves by how far the finger moves — half the travel up, 40% to 90%', drag.at(-1) === `set-sink-volume ${HEADSET} 90%`, drag.join(' | '));
  check('…at most one write per move', drag.length >= 1 && drag.length <= 10, String(drag.length));
  const callsMid = (await pactlCalls()).length;
  await helperSays(up(3));
  const finalReRead = async () => {
    const calls = (await pactlCalls()).slice(callsMid);
    const at = calls.indexOf(`set-sink-volume ${HEADSET} 90%`);
    return at >= 0 && calls.indexOf('-f json info', at) > at;
  };
  await until(finalReRead);
  const afterUp = (await pactlCalls()).slice(callsMid);
  const finalAt = afterUp.indexOf(`set-sink-volume ${HEADSET} 90%`);
  check('the last write is final: the same level again, then the cache re-read', finalAt >= 0 && afterUp.indexOf('-f json info', finalAt) > finalAt, afterUp.join(' | '));
  check('the face follows the real value once it settles', await until(async () => Math.abs((await levelOf('s1')) - 0.9) < 0.02), String(await levelOf('s1')));
  check('the status reports it in whole percent', await until(() => session.values().s1 === 90), JSON.stringify(session.values()));

  // A burst: 60 moves at once, as a fast finger gives — one write in flight, the newest waiting.
  const burstFrom = (await sets()).length;
  const burst = [];
  for (let i = 1; i <= 60; i++) burst.push(move(4, 's1', 30, 120 + (travel * 0.6) * (i / 60)));
  await helperSays(down(4, 's1'), ...burst, up(4));
  await until(async () => audio.cachedVolume({ node: HEADSET }) === 30, 4000);
  const burstSets = (await sets()).slice(burstFrom);
  check('a burst of 60 moves is a handful of pactl calls, never one each: one in flight, the newest waiting', burstSets.length < 12 && burstSets.at(-1) === `set-sink-volume ${HEADSET} 30%`, `${burstSets.length}: ${burstSets.join(' | ')}`);

  // Jump to touch, horizontal: the level goes to the finger at once.
  const s2art = await valueArt({ ...base, kind: 'slider', width: 240, height: 60, direction: 'horizontal' });
  const at75 = s2art.travel.start + s2art.travel.thumb / 2 + 0.75 * vc.travelLength(s2art.travel);
  await helperSays(down(5, 's2', at75, 30), up(5));
  check('Jump to touch: a tap at three-quarters sets 75% on the default output', await until(async () => (await sets()).some((l) => l === 'set-sink-volume @DEFAULT_SINK@ 75%')), (await sets()).slice(-3).join(' | '));

  // A dial: a tap changes nothing; a quarter-turn clockwise round its centre is a third of 270°.
  const sourcesBefore = (await sets('set-source-volume')).length;
  await helperSays(down(6, 'd1', 60, 5), up(6));
  check('a dial: a tap changes nothing', (await sets('set-source-volume')).length === sourcesBefore);
  const turn = [];
  for (let i = 1; i <= 9; i++) {
    const a = ((i * 10) * Math.PI) / 180;
    turn.push(move(7, 'd1', 60 + 50 * Math.sin(a), 60 - 50 * Math.cos(a)));
  }
  const was = JSON.parse(await fs.readFile(PACTL_STATE, 'utf8'));
  await fs.writeFile(PACTL_STATE, JSON.stringify({ ...was, volumes: { ...was.volumes, [MIC]: 20 } }));
  await until(() => audio.cachedVolume({ node: MIC, input: true }) === 20);
  const micWas = audio.cachedVolume({ node: MIC, input: true });
  await helperSays(down(7, 'd1', 60, 10), ...turn, up(7));
  const want = Math.round(micWas + 100 * (90 / 270));
  check(`a dial turned a quarter clockwise: the mic from ${micWas}% to ${want}%`, await until(async () => (await sets('set-source-volume')).at(-1) === `set-source-volume ${MIC} ${want}%`), (await sets('set-source-volume')).join(' | '));

  // Outside Deckhand: the desktop's volume control sets the headset to 15%.
  const state = JSON.parse(await fs.readFile(PACTL_STATE, 'utf8'));
  await fs.writeFile(PACTL_STATE, JSON.stringify({ ...state, volumes: { ...state.volumes, [HEADSET]: 15 } }));
  check('a change made outside Deckhand moves the fill: pactl subscribe\'s event, the cache, the face', await until(async () => Math.abs((await levelOf('s1')) - 0.15) < 0.02, 4000), String(await levelOf('s1')));
  check('…and the status', session.values().s1 === 15, JSON.stringify(session.values()));

  // At rest: no pactl, no frames — once the outside change's own re-read and redraw have finished.
  for (let last = -1, now = (await pactlCalls()).length; now !== last; last = now, await sleep(600), now = (await pactlCalls()).length);
  await sleep(600);
  const restCalls = (await pactlCalls()).length;
  const restFrames = (await frames()).length;
  await sleep(2500);
  check('at rest: no pactl call and nothing drawn — never polled', (await pactlCalls()).length === restCalls && (await frames()).length === restFrames, `${(await pactlCalls()).length - restCalls} calls, ${JSON.stringify((await frames()).slice(restFrames).map((f) => ({ type: f.type, x: f.x, y: f.y })))}`);

  // A lock mid-drag ends it with the value where it is.
  const lockFrom = (await sets()).length;
  await helperSays(down(8, 's1'), move(8, 's1', 30, 120 - travel * 0.2));
  await until(async () => (await sets()).length > lockFrom);
  logind.lock(true);
  await until(() => device.touchState() === 'locked');
  const lockedAt = (await sets()).length;
  const lockedValue = (await sets()).at(-1);
  await helperSays(move(8, 's1', 30, 120 - travel * 0.45), move(8, 's1', 30, 10));
  await sleep(300);
  check('locked mid-drag: the moves after the lock write nothing', (await sets()).length === lockedAt, (await sets()).slice(lockedAt).join(' | '));
  check('…the value is left where the drag had put it (35%)', lockedValue === `set-sink-volume ${HEADSET} 35%` && (await until(() => audio.cachedVolume({ node: HEADSET }) === 35)), `${lockedValue} / ${audio.cachedVolume({ node: HEADSET })}`);
  check('…and the face shows it, not held', await until(async () => Math.abs((await levelOf('s1')) - 0.35) < 0.02), String(await levelOf('s1')));
  await helperSays(up(8));
  logind.lock(false);
  await until(() => device.touchState() === 'ready');

  // A page change mid-drag ends it too.
  const pageFrom = (await sets()).length;
  await helperSays(down(9, 's1'), move(9, 's1', 30, 120 - travel * 0.1));
  await until(async () => (await sets()).length > pageFrom);
  await session.goToPage('other');
  const pagedAt = (await sets()).length;
  await helperSays(move(9, 's1', 30, 10), up(9));
  check('a page change mid-drag ends it: nothing more is written', (await sets()).length === pagedAt);
  await session.goToPage('mix');

  // To a page with the same controls: the finger stays on the screen's control, and the drag still ends there.
  const sameFrom = (await pactlCalls()).length;
  await helperSays(down(13, 's1'), move(13, 's1', 30, 120 - travel * 0.1));
  await until(async () => (await pactlCalls()).slice(sameFrom).some((l) => l.startsWith('set-sink-volume')));
  await session.goToPage('same');
  await sleep(150);
  const sameAt = (await pactlCalls()).length;
  await helperSays(move(13, 's1', 30, 120 - travel * 0.4), move(13, 's1', 30, 120 - travel * 0.45), up(13));
  await sleep(300);
  check('…to a page with the same controls too: the finger still there writes nothing to the new page\'s action', !(await pactlCalls()).slice(sameAt).some((l) => l.startsWith('set-source-volume') || l.startsWith('set-sink-volume')), (await pactlCalls()).slice(sameAt).join(' | '));
  await session.goToPage('mix');

  // Brightness to 0 on its own deck, and back up by touch.
  const bFrom = (await frames()).length;
  await helperSays(down(10, 'br', 30, 20), move(10, 'br', 30, 400), up(10));
  check('a brightness slider sets its own deck to 0', await until(async () => (await frames()).slice(bFrom).some((f) => f.type === 'B' && f.percent === 0)) && session.currentBrightness() === 0, `${session.currentBrightness()}`);
  const upFrom = (await frames()).length;
  await helperSays(down(11, 'br', 30, 220), move(11, 'br', 30, -200), up(11));
  check('…and touch still works at 0: turned back up to 100', await until(async () => (await frames()).slice(upFrom).some((f) => f.type === 'B' && f.percent === 100)) && session.currentBrightness() === 100, `${session.currentBrightness()}`);

  // A device not there: fails once per drag, marked and notified, and nothing more is tried.
  notified.length = 0;
  const abFrom = (await pactlCalls()).length;
  // Moves one at a time, so each could have written: the first failure stops the rest.
  await helperSays(down(12, 'ab'));
  for (let i = 1; i <= 6; i++) await helperSays(move(12, 'ab', 30, 120 - i * 12));
  // The finger still down: once a write has failed, the face shows the real value (none known: the lowest), not the finger.
  await sleep(150);
  const failedFace = await levelOf('ab', true);
  await helperSays(up(12));
  await sleep(200);
  check('a slider for a device not connected: no pactl call at all', !(await pactlCalls()).slice(abFrom).some((l) => l.includes('alsa_output.gone')));
  check('…one notification for the drag, saying what to do', notified.length === 1 && /not connected/.test(notified[0].message), JSON.stringify(notified.map((n) => n.message)));
  check('…and the control marked failed', session.failedKeys().some((f) => f.key === 'ab'), JSON.stringify(session.failedKeys()));
  check('…and while the finger is still down the face stops following it: the real value, not the failed one', failedFace !== null && failedFace < 0.02, String(failedFace));
});

stopAudio();
await session?.close().catch(() => undefined);
await logind.stop().catch(() => undefined);
try {
  process.kill(Number(busPid));
} catch {}
await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? 'values: all passed' : `values: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
