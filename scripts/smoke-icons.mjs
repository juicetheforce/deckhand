/**
 * Offline test for the missing-icon fallback (docs/scope.md §3): a key whose
 * icon is set but cannot be drawn shows the built-in 'missing' icon; strict
 * rendering (the control socket's preview) still refuses; everything else
 * renders as before.
 *
 *   npm run build:ts && node scripts/smoke-icons.mjs
 *
 * Expected images are built with sharp directly, not through render.ts, so a
 * change to the render path cannot also change what it is compared with.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { builtinIconPath } from '../dist/builtin-icons.js';
import { clearRenderCache, renderButton } from '../dist/render.js';
import { DEFAULTS } from '../dist/config.js';
import { FakeDeck, REPO, check, failureCount, scratchDir, startDaemon } from './test/control-harness.mjs';

const BACKGROUND = '#101014';
const TMP = await scratchDir();
const MISSING_SVG = path.join(REPO, 'assets', 'icons', 'missing.svg');
const GOOD_SVG = path.join(REPO, 'assets', 'icons', 'play.svg');

/** The display renderButton gets for a button with these fields and the daemon's defaults. */
function display(fields) {
  const { brightness, refreshMs, ...rest } = DEFAULTS;
  return { ...rest, ...fields };
}

/** An icon composited on the key background by sharp alone. */
async function expected(iconFile, size, fit) {
  const base = sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } });
  if (!iconFile) return base.raw().toBuffer();
  const layer = await sharp(await fs.readFile(iconFile))
    .resize(size, size, { fit, position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return base.composite([{ input: layer, top: 0, left: 0 }]).raw().toBuffer();
}

const same = (a, b) => Buffer.compare(a, b) === 0;

/** Run fn, returning [result, console.error lines it printed]. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return [await fn(), lines];
  } finally {
    console.error = original;
  }
}

async function refuses(promise) {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

// --- files that cannot be drawn ---------------------------------------------

const gone = path.join(TMP, 'gone.png');
const corrupt = path.join(TMP, 'corrupt.png');
await fs.writeFile(corrupt, 'this is not a png');
const unsupported = path.join(TMP, 'icon.tga');
// A real 1x1 uncompressed TGA header and pixel: a format sharp does not read.
await fs.writeFile(unsupported, Buffer.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 255, 0, 0]));
const unreadable = path.join(TMP, 'unreadable.png');
await fs.copyFile(path.join(REPO, 'assets', 'icons', 'play.svg'), unreadable);
await fs.chmod(unreadable, 0o000);
const runningAsRoot = process.getuid?.() === 0;

check('the built-in missing icon resolves to the repo\'s assets/icons/missing.svg', builtinIconPath('missing') === MISSING_SVG);
check('assets/icons/missing.svg exists', await fs.access(MISSING_SVG).then(() => true, () => false));

for (const size of [72, 96]) {
  const placeholder = await expected(MISSING_SVG, size, 'contain');
  const cases = [
    ['a path that does not exist', gone],
    ['a file that is not an image', corrupt],
    ['a format sharp cannot read (.tga)', unsupported],
  ];
  if (!runningAsRoot) cases.push(['a file that cannot be read (mode 000)', unreadable]);
  for (const [what, file] of cases) {
    const [image] = await capturingErrors(() => renderButton(display({ icon: file }), size));
    check(`${size} px: ${what} -> the missing icon`, same(image, placeholder));
    check(`${size} px: ${what} -> strict render still refuses`, await refuses(renderButton(display({ icon: file }), size, true)));
  }
  check(`${size} px: a readable icon renders as before`, same(await renderButton(display({ icon: GOOD_SVG }), size), await expected(GOOD_SVG, size, 'cover')));
  check(`${size} px: no icon renders the bare background`, same(await renderButton(display({}), size), await expected(null, size)));
  check(`${size} px: a readable icon is not the placeholder (the comparison can fail)`, !same(await renderButton(display({ icon: GOOD_SVG }), size), placeholder));
}
if (runningAsRoot) console.log('  skip  unreadable file: running as root, mode 000 does not stop reads');

// One log line per broken path, not one per render.
clearRenderCache();
const [, lines] = await capturingErrors(async () => {
  for (let i = 0; i < 3; i++) await renderButton(display({ icon: gone, label: `L${i}` }), 96);
});
check('a broken path is logged once across renders', lines.length === 1 && lines[0].includes(gone) && lines[0].includes('missing-icon placeholder'));

// The label still draws over the placeholder.
const [placeholderWithLabel] = await capturingErrors(() => renderButton(display({ icon: gone, label: 'DOVE' }), 96));
check('a label still draws over the placeholder', !same(placeholderWithLabel, await expected(MISSING_SVG, 96, 'contain')));

// A file that comes back draws again (the cache is keyed on the file's stamp).
const returning = path.join(TMP, 'returning.svg');
await capturingErrors(() => renderButton(display({ icon: returning }), 96));
await fs.copyFile(GOOD_SVG, returning);
check('a missing file that reappears draws the real icon', same(await renderButton(display({ icon: returning }), 96), await expected(GOOD_SVG, 96, 'cover')));

// An incomplete install: the built-in itself is missing. Degrades to no icon, logged once, never throws.
clearRenderCache();
process.env.DECKHAND_BUILTIN_ICONS = path.join(TMP, 'no-such-dir');
const [noBuiltin, builtinLines] = await capturingErrors(async () => {
  const first = await renderButton(display({ icon: gone }), 96);
  await renderButton(display({ icon: corrupt }), 96);
  return first;
});
check('built-in missing too: the key shows the bare background, no throw', same(noBuiltin, await expected(null, 96)));
check('built-in missing too: logged once, naming the built-in', builtinLines.filter((l) => l.includes('built-in icon')).length === 1);
delete process.env.DECKHAND_BUILTIN_ICONS;
clearRenderCache();

// Through a real DeckSession, as a deck key.
const daemon = await startDaemon(TMP, {
  profiles: { p: { layouts: { XL1: { startPage: 'main', pages: { main: { buttons: {
    0: { icon: gone, action: { type: 'hotkey', keys: 'ctrl+1' } },
    1: { icon: GOOD_SVG, action: { type: 'hotkey', keys: 'ctrl+2' } },
  } } } } } } },
  startProfile: 'p',
});
const deck = new FakeDeck();
await capturingErrors(() => daemon.attach('XL1', deck));
check('deck key with a broken icon path shows the missing icon', same(deck.images.get(0), await expected(MISSING_SVG, 96, 'contain')));
check('deck key with a good icon shows it', same(deck.images.get(1), await expected(GOOD_SVG, 96, 'cover')));
await daemon.stop();

await fs.chmod(unreadable, 0o600);
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nicons: all checks passed' : `\nicons: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
