// Bundle the Electron main process (ESM) and the preload (CommonJS — a
// sandboxed preload cannot be an ES module). The daemon's src/*.ts files are
// bundled in from their source; `electron` and Node built-ins stay external.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { bundledPackages, lockPackages, writeNotices } from './third-party-notices.mjs';

const root = path.join(import.meta.dirname, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
};

const main = await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(root, 'dist/main/main.js'),
  format: 'esm',
});

const preload = await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(root, 'dist/preload/preload.cjs'),
  format: 'cjs',
});

// The tray icon: PNGs rendered from the logo and committed
// (scripts/render-logo-png.mjs at the repository root), copied beside the
// bundle so an installed editor carries its own and needs no sharp.
const logoPng = path.join(root, '..', 'assets', 'logo', 'png');
mkdirSync(path.join(root, 'dist/icons'), { recursive: true });
for (const file of readdirSync(logoPng).filter((f) => f.startsWith('tray'))) {
  cpSync(path.join(logoPng, file), path.join(root, 'dist/icons', file));
}

// The licences of everything bundled (third-party-notices.mjs says why).
writeNotices(
  [
    ...lockPackages(root),
    ...bundledPackages(main.metafile, process.cwd()),
    ...bundledPackages(preload.metafile, process.cwd()),
  ],
  path.join(root, 'dist/THIRD-PARTY-NOTICES.txt'),
);
