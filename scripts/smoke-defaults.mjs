/**
 * Offline test for built-in default icons (docs/scope.md §3, §7 C1 piece 5):
 * the mapping, `builtin:<name>` icons, and the order a key's icon is chosen in,
 * drawn through a real DeckSession on a fake deck. Audio state comes from
 * scripts/test/fake-pactl.mjs; no player is running, so play/pause is paused.
 *
 *   npm run build:ts && node scripts/smoke-defaults.mjs
 *
 * Expected images are composited with sharp directly, not through render.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FakeDeck, REPO, check, failureCount, scratchDir, startDaemon } from './test/control-harness.mjs';

const TMP = await scratchDir();
const PACTL_STATE = path.join(TMP, 'pactl-state.json');
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(TMP, 'bin', 'pactl'));
process.env.PATH = `${path.join(TMP, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_STATE = PACTL_STATE;

const { BUILTIN_ICONS, defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));
const { builtinIconDir, builtinRefPath } = await import(path.join(REPO, 'dist/builtin-icons.js'));
const { renderButton } = await import(path.join(REPO, 'dist/render.js'));
const audio = await import(path.join(REPO, 'dist/services/audio.js'));

const ICONS = path.join(REPO, 'assets', 'icons');
const icon = (name) => path.join(ICONS, `${name}.svg`);
const BACKGROUND = '#101014';

console.log('the mapping');
{
  const rows = [
    [{ type: 'hotkey', keys: 'ctrl+1' }, {}, 'key-combo'],
    [{ type: 'text', text: 'gg' }, {}, 'text-macro'],
    [{ type: 'multi', steps: [] }, {}, 'multi-action'],
    [{ type: 'keyHold', keys: 'f24', state: 'down' }, {}, 'press-release'],
    [{ type: 'command', command: 'true' }, {}, 'command'],
    [{ type: 'profile', to: 'x' }, {}, 'profile'],
    [{ type: 'page', to: 'Jobs' }, {}, 'forward'],
    [{ type: 'page', back: true }, {}, 'back'],
    [{ type: 'brightness', delta: 10 }, {}, 'brightness-up'],
    [{ type: 'brightness', delta: -10 }, {}, 'brightness-down'],
    [{ type: 'brightness', value: 40 }, {}, 'brightness-set'],
    [{ type: 'clock' }, {}, null],
    [{ type: 'media.info' }, {}, null],
    [{ type: 'media.info' }, { idle: false }, null],
    [{ type: 'media.info' }, { idle: true }, 'now-playing'],
    [{ type: 'noop' }, {}, null],
    [{ type: 'audio.sink', node: 'n' }, {}, 'speaker'],
    [{ type: 'audio.cycle', devices: [] }, {}, 'io-select'],
    [{ type: 'audio.source', node: 'n' }, {}, 'input-select'],
    [{ type: 'audio.micMute' }, { muted: false }, 'mic'],
    [{ type: 'audio.micMute' }, { muted: true }, 'mic-muted'],
    [{ type: 'audio.volume' }, {}, 'speaker'],
    [{ type: 'audio.volume', delta: 5 }, {}, 'speaker'],
    [{ type: 'audio.volume', delta: -5 }, {}, 'volume-down'],
    [{ type: 'audio.mute' }, { muted: false }, 'speaker'],
    [{ type: 'audio.mute' }, { muted: true }, 'speaker-muted'],
    [{ type: 'media.control' }, { playing: false }, 'play'],
    [{ type: 'media.control', method: 'playpause' }, { playing: true }, 'pause'],
    [{ type: 'media.control', method: 'next' }, {}, 'next'],
    [{ type: 'media.control', method: 'prev' }, {}, 'previous'],
    [{ type: 'media.control', method: 'previous' }, {}, 'previous'],
    [{ type: 'media.control', method: 'stop' }, { playing: true }, 'stop'],
    [{ type: 'media.control', method: 'Pause' }, {}, 'pause'],
    [{ type: 'no.such.action' }, {}, null],
  ];
  const wrong = rows.filter(([action, state, want]) => defaultIconFor(action, state) !== want);
  check(`${rows.length} actions map to their decided defaults`, wrong.length === 0);
  for (const [action, state, want] of wrong) console.log(`       ${JSON.stringify(action)} ${JSON.stringify(state)}: want ${want}, got ${defaultIconFor(action, state)}`);
  check('no action: no default', defaultIconFor(undefined) === null);

  const files = (await fs.readdir(ICONS)).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
  check('BUILTIN_ICONS lists exactly the files in assets/icons/', JSON.stringify([...BUILTIN_ICONS].sort()) === JSON.stringify(files));
  const mapped = rows.map(([a, s]) => defaultIconFor(a, s)).filter(Boolean);
  check('every default names a file that exists', mapped.every((name) => files.includes(name)));
  check('no default is the missing icon', !mapped.includes('missing'));
}

console.log('builtin: references');
{
  check('builtin:pause is the shipped pause.svg', builtinRefPath('builtin:pause') === icon('pause'));
  check('a plain path is not a built-in reference', builtinRefPath('~/icons/pause.svg') === null);
  const climb = builtinRefPath('builtin:../../../etc/passwd');
  check('a name that tries to climb out stays inside the icon directory, and cannot exist',
    climb.startsWith(builtinIconDir() + path.sep) && !(await fs.access(climb).then(() => true, () => false)));
  check('a capitalised name is not a built-in name', builtinRefPath('builtin:Pause').includes('not a built-in name'));
}

// --- through a real DeckSession ---------------------------------------------

async function expected(file, { fit = 'cover', background = BACKGROUND } = {}) {
  const base = sharp({ create: { width: 96, height: 96, channels: 4, background } });
  if (!file) return base.raw().toBuffer();
  const layer = await sharp(await fs.readFile(file))
    .resize(96, 96, { fit, position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return base.composite([{ input: layer, top: 0, left: 0 }]).raw().toBuffer();
}
const same = (a, b) => a !== undefined && Buffer.compare(a, b) === 0;

/** A key rendered through renderButton with the deck defaults, for faces with a label. */
function display(fields) {
  return { iconFit: 'cover', labelColor: '#ffffff', labelSize: 14, labelPosition: 'bottom', background: BACKGROUND, ...fields };
}

const GOOD = icon('clock'); // any readable image that is no key's default in this test
await fs.writeFile(PACTL_STATE, JSON.stringify({ muted: {} }));
await audio.refreshCache();

const buttons = {
  0: { action: { type: 'hotkey', keys: 'ctrl+1' } },
  1: { icon: null, action: { type: 'hotkey', keys: 'ctrl+1' } },
  2: { icon: GOOD, action: { type: 'hotkey', keys: 'ctrl+1' } },
  3: { icon: 'builtin:pause', action: { type: 'hotkey', keys: 'ctrl+1' } },
  4: { icon: 'builtin:nope', action: { type: 'hotkey', keys: 'ctrl+1' } },
  5: { icon: 'builtin:../missing', action: { type: 'hotkey', keys: 'ctrl+1' } },
  6: { label: 'x' },
  7: { action: { type: 'noop' } },
  8: { action: { type: 'page', back: true } },
  9: { action: { type: 'audio.volume', delta: -5 } },
  10: { action: { type: 'audio.volume', delta: 5, showLevel: true } },
  11: { action: { type: 'brightness', delta: 10 } },
  12: { action: { type: 'audio.micMute' } },
  13: { action: { type: 'audio.micMute', iconMuted: GOOD } },
  14: { action: { type: 'audio.mute' } },
  15: { action: { type: 'media.control', method: 'next' } },
  16: { action: { type: 'media.control', method: 'playpause' } },
  17: { icon: GOOD, action: { type: 'media.info' } },
  18: { action: { type: 'keyHold', keys: 'f24', state: 'down' } },
  19: { label: 'FFXIV', action: { type: 'profile', to: 'p' } },
  20: { icon: 'builtin:pause' },
  21: { icon: null, label: 'Only a label', action: { type: 'hotkey', keys: 'ctrl+2' } },
  22: { action: { type: 'media.info' } },
  23: { action: { type: 'media.info', idleLabel: 'Quiet' } },
};
const daemon = await startDaemon(TMP, {
  profiles: { p: { layouts: { XL1: { startPage: 'main', pages: { main: { buttons } } } } } },
  startProfile: 'p',
});
const deck = new FakeDeck();
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(' '));
const session = await daemon.attach('XL1', deck);
const key = (i) => deck.images.get(i);

console.log('which icon a key draws');
{
  const bare = await expected(null);
  check('an action with no icon set draws its default', same(key(0), await expected(icon('key-combo'))));
  check('icon: null draws no icon — deliberately none', same(key(1), bare));
  check('a path wins over the default', same(key(2), await expected(GOOD)));
  check('builtin:<name> draws that built-in', same(key(3), await expected(icon('pause'))));
  check('an unknown built-in draws missing', same(key(4), await expected(icon('missing'), { fit: 'contain' })));
  check('a malformed built-in name draws missing', same(key(5), await expected(icon('missing'), { fit: 'contain' })));
  check('a key with no action gets no default: its label alone', same(key(6), await renderButton(display({ label: 'x' }), 96)));
  check('noop draws nothing', same(key(7), bare));
  check('page back draws back', same(key(8), await expected(icon('back'))));
  check('volume down draws volume-down, with no level label by default', same(key(9), await expected(icon('volume-down'))));
  check('showLevel: true still draws the level over the icon', !same(key(10), await expected(icon('speaker'))));
  check('brightness up draws brightness-up, with no level label by default', same(key(11), await expected(icon('brightness-up'))));
  // fake-pactl's default input starts muted.
  check('mic mute, muted: mic-muted, with its muted background', same(key(12), await expected(icon('mic-muted'), { background: '#5a1d1d' })));
  check('an explicit iconMuted wins over the default', same(key(13), await expected(GOOD, { background: '#5a1d1d' })));
  check('output mute, unmuted: speaker', same(key(14), await expected(icon('speaker'))));
  check('media next draws next', same(key(15), await expected(icon('next'))));
  check('play/pause with nothing playing draws play', same(key(16), await expected(icon('play'))));
  check('an idle now-playing key keeps its own icon (was wiped), with no label', same(key(17), await expected(GOOD)));
  check('an idle now-playing key with no icon draws now-playing and no label', same(key(22), await expected(icon('now-playing'))));
  check('idleLabel puts a label back over it', same(key(23), await renderButton(display({ icon: icon('now-playing'), label: 'Quiet' }), 96)));
  check('Press/Release (keyHold) draws press-release', same(key(18), await expected(icon('press-release'))));
  check('a profile key draws profile under its label', same(key(19), await renderButton(display({ icon: icon('profile'), label: 'FFXIV' }), 96)));
  check('builtin:<name> on a key with no action draws too', same(key(20), await expected(icon('pause'))));
  check('a label-only key (icon: null) draws the label with no default', same(key(21), await renderButton(display({ label: 'Only a label' }), 96)));
}

console.log('state pairs follow the cache');
{
  const [sink] = [audio.cachedState().defaultSink];
  await fs.writeFile(PACTL_STATE, JSON.stringify({ muted: { [sink]: true, 'alsa_input.usb-Example_Headset-00.mono-fallback': false } }));
  await audio.refreshCache();
  await session.repaint();
  check('output muted: speaker-muted', same(key(14), await expected(icon('speaker-muted'))));
  check('mic unmuted: mic', same(key(12), await expected(icon('mic'))));
}

console.log('previews');
{
  check('a strict render of builtin:pause draws', same(await renderButton(display({ icon: 'builtin:pause' }), 96, true), await expected(icon('pause'))));
  let refused = false;
  try {
    await renderButton(display({ icon: 'builtin:nope' }), 96, true);
  } catch {
    refused = true;
  }
  check('a strict render of an unknown built-in refuses (render_failed)', refused);
}

console.error = originalError;
check('the only errors logged are for the two broken built-in references',
  errors.length === 2 && errors.every((l) => /nope|not a built-in name/.test(l)));
await daemon.stop();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\ndefaults: all checks passed' : `\ndefaults: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
