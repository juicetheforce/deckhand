/**
 * Offline test for what an icon path may read (src/icon-file.ts), through the
 * module and through the daemon's renderer:
 *
 * - a device (/dev/zero) or a FIFO is refused without being read — reading
 *   one never ended — and the key draws the missing icon;
 * - a file over MAX_ICON_BYTES is refused;
 * - **nothing in Deckhand's state directory is read**, directly or through a
 *   link from outside it: credentials.json lives there;
 * - the editor's rule (`image: true`) takes a shown extension, or the first
 *   bytes of a shown format, and refuses anything else; the daemon's leaves
 *   the type to sharp.
 *
 *   npm run build:ts && node scripts/smoke-icon-files.mjs
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-icon-files-'));
const STATE = path.join(TMP, 'state');
await fs.mkdir(STATE);
process.env.DECKHAND_STATE_DIR = STATE;
const { readIconFile, IconFileError, MAX_ICON_BYTES } = await import(path.join(REPO, 'dist/icon-file.js'));
const { renderButton, clearRenderCache } = await import(path.join(REPO, 'dist/render.js'));
const { DEFAULTS } = await import(path.join(REPO, 'dist/config.js'));

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
/** The reason readIconFile refused, 'read' if it did not, 'timeout' if it never answered. */
async function outcome(file, image) {
  const answer = readIconFile(file, { image }).then(
    () => 'read',
    (err) => (err instanceof IconFileError ? err.reason : `other: ${err.message}`),
  );
  const late = new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000).unref());
  return Promise.race([answer, late]);
}
const { brightness, refreshMs, ...displayDefaults } = DEFAULTS;
const display = (icon) => ({ ...displayDefaults, icon, label: '' });

try {
  const png = path.join(TMP, 'good.png');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toFile(png);
  check('a PNG is read, as image/png', (await readIconFile(png, { image: true })).type === 'image/png');

  check('/dev/zero is refused as not a file, without reading it', (await outcome('/dev/zero', false)) === 'not a file');
  const fifo = path.join(TMP, 'pipe.png');
  spawnSync('mkfifo', [fifo]);
  check('a FIFO named like an image is refused as not a file, without reading it', (await outcome(fifo, true)) === 'not a file');
  check('a directory is refused as not a file', (await outcome(TMP, false)) === 'not a file');
  check('a path that is not there: not found', (await outcome(path.join(TMP, 'nothing.png'), true)) === 'not found');

  const big = path.join(TMP, 'big.png');
  await fs.writeFile(big, Buffer.alloc(MAX_ICON_BYTES + 1));
  check(`a file over ${MAX_ICON_BYTES} bytes is refused as too large`, (await outcome(big, false)) === 'too large');

  const secret = path.join(STATE, 'credentials.json');
  await fs.writeFile(secret, '{"twitch":{"refreshToken":"SECRET"}}', { mode: 0o600 });
  check("credentials.json is refused: in Deckhand's state directory", (await outcome(secret, false)) === "in Deckhand's state directory");
  const pngInState = path.join(STATE, 'looks-like-an-icon.png');
  await fs.copyFile(png, pngInState);
  check('so is an image in the state directory', (await outcome(pngInState, true)) === "in Deckhand's state directory");
  const link = path.join(TMP, 'innocent.png');
  await fs.symlink(secret, link);
  check('and a link from outside it to a file inside it', (await outcome(link, false)) === "in Deckhand's state directory");
  const tilde = path.join(TMP, 'a', '..', 'state', 'credentials.json');
  check('and a path that climbs back into it', (await outcome(tilde, false)) === "in Deckhand's state directory");

  const text = path.join(TMP, 'notes.txt');
  await fs.writeFile(text, 'not an image');
  check("the editor's rule refuses a file that is not an image", (await outcome(text, true)) === 'not an image');
  check("the daemon's rule leaves it to sharp (read, then refused by sharp)", (await outcome(text, false)) === 'read');
  const bare = path.join(TMP, 'org.example.App');
  await fs.copyFile(png, bare);
  check("the editor's rule takes an image with no extension by its first bytes", (await readIconFile(bare, { image: true })).type === 'image/png');

  // Through the renderer: a refused icon draws the missing icon, and a strict render (the editor's preview) says why.
  clearRenderCache();
  const missing = await renderButton(display(path.join(TMP, 'nothing.png')), 72);
  for (const [name, file] of [['/dev/zero', '/dev/zero'], ['a FIFO', fifo], ['credentials.json', secret]]) {
    const drawn = await Promise.race([renderButton(display(file), 72), new Promise((r) => setTimeout(() => r(null), 3000).unref())]);
    check(`the deck draws the missing icon for ${name}, and does not hang`, drawn !== null && Buffer.compare(drawn, missing) === 0);
  }
  const strict = await renderButton(display(secret), 72, true).then(() => 'drawn', (err) => err.message);
  check("a strict render of credentials.json is refused, saying why", strict.includes("in Deckhand's state directory"));
} finally {
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nicon-files: all checks passed' : `\nicon-files: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
