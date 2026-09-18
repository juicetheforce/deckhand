/**
 * Render the logo PNGs that cannot be SVG, into assets/logo/png/. The output
 * is committed: the editor copies it into its dist/ at build time and needs no
 * sharp of its own (sharp is a daemon dependency). Run again only when a logo
 * SVG changes:
 *
 *   node scripts/render-logo-png.mjs
 *
 * Which drawing at which size follows scope §7 (M4, "Deckhand logo"):
 * deckhand-small.svg for 16–32 px, the master from 48 px up.
 *
 *   tray.png, tray@2x.png — the tray icon (Ship piece 2). Electron's
 *     nativeImage accepts PNG and JPEG only, and picks up the @2x file for a
 *     HiDPI panel by its name.
 */
import path from 'node:path';
import sharp from 'sharp';

const REPO = path.join(import.meta.dirname, '..');
const LOGO = path.join(REPO, 'assets', 'logo');
const OUT = path.join(LOGO, 'png');

const RENDERS = [
  { file: 'tray.png', svg: 'deckhand-small.svg', size: 32 },
  { file: 'tray@2x.png', svg: 'deckhand.svg', size: 64 },
];

const { mkdir } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true });
for (const { file, svg, size } of RENDERS) {
  // Rasterised well above the target size, then scaled down, so edges are
  // antialiased rather than rendered at the SVG's own small viewport.
  await sharp(path.join(LOGO, svg), { density: 1200 }).resize(size, size).png().toFile(path.join(OUT, file));
  console.log(`${file}: ${svg} at ${size} px`);
}
