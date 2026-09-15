// Bundle and run the editor's offline tests with plain Node (no Electron).
// The store test imports the daemon's built dist/config.js, so the daemon's
// TypeScript is built first.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.join(import.meta.dirname, '..');
const repo = path.join(root, '..');

const tsc = spawnSync('npm', ['run', 'build:ts'], { cwd: repo, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

let failed = false;
for (const name of readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.ts'))) {
  const outfile = path.join(root, 'dist/test', name.replace(/\.ts$/, '.js'));
  await build({
    entryPoints: [path.join(root, 'test', name)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  });
  console.log(`\n== ${name}`);
  const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
