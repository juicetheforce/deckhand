// Bundle the Electron main process (ESM) and the preload (CommonJS — a
// sandboxed preload cannot be an ES module). The daemon's src/*.ts files are
// bundled in from their source; `electron` and Node built-ins stay external.
import path from 'node:path';
import { build } from 'esbuild';

const root = path.join(import.meta.dirname, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(root, 'dist/main/main.js'),
  format: 'esm',
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(root, 'dist/preload/preload.cjs'),
  format: 'cjs',
});
