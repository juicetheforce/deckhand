/**
 * Render the logo PNGs that cannot be SVG, into assets/logo/png/. The output
 * is committed: the editor copies it into its dist/ at build time and needs no
 * sharp of its own (sharp is a daemon dependency). Run again only when a logo
 * SVG changes:
 *
 *   node scripts/render-logo-png.mjs
 *
 * Which drawing at which size: deckhand-small.svg for 16–32 px, the master
 * from 48 px up.
 *
 *   tray.png, tray@2x.png — the tray icon. Electron's
 *     nativeImage accepts PNG and JPEG only, and picks up the @2x file for a
 *     HiDPI panel by its name.
 *   apps/<size>.png — the application icon, one per hicolor
 *     size. scripts/install.sh installs them, with deckhand.svg as the
 *     scalable one, into $XDG_DATA_HOME/icons/hicolor/. A desktop picks the
 *     exact size where one exists, so the small drawing is what shows at
 *     16–32 px rather than the master scaled down.
 */
import path from 'node:path';
import sharp from 'sharp';

const REPO = path.join(import.meta.dirname, '..');
const LOGO = path.join(REPO, 'assets', 'logo');
const OUT = path.join(LOGO, 'png');

const APP_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256];

const RENDERS = [
  { file: 'tray.png', svg: 'deckhand-small.svg', size: 32 },
  { file: 'tray@2x.png', svg: 'deckhand.svg', size: 64 },
  ...APP_ICON_SIZES.map((size) => ({ file: `apps/${size}.png`, svg: size <= 32 ? 'deckhand-small.svg' : 'deckhand.svg', size })),
];

const { mkdir } = await import('node:fs/promises');
await mkdir(path.join(OUT, 'apps'), { recursive: true });
for (const { file, svg, size } of RENDERS) {
  // Rasterised well above the target size, then scaled down, so edges are
  // antialiased rather than rendered at the SVG's own small viewport.
  await sharp(path.join(LOGO, svg), { density: 1200 }).resize(size, size).png().toFile(path.join(OUT, file));
  console.log(`${file}: ${svg} at ${size} px`);
}
