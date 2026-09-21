// The installed editor carries dist/THIRD-PARTY-NOTICES.txt because its
// bundles strip the licence comments of the packages folded into them. The
// build writes it from two lists — the lock's production packages and what
// esbuild reports bundling — and refuses to finish if a package has no
// licence file.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — a plain .mjs build script, with no type declarations.
import { bundledPackages, lockPackages, writeNotices } from '../scripts/third-party-notices.mjs';

const EDITOR = path.resolve(import.meta.dirname, '../..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-notices-'));

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

await check("every production package in the lock is in the notices, with its licence's text", async () => {
  const lock = JSON.parse(await fs.readFile(path.join(EDITOR, 'package-lock.json'), 'utf8'));
  const production = Object.entries(lock.packages as Record<string, { dev?: boolean; devOptional?: boolean }>)
    .filter(([key, entry]) => key !== '' && !entry.dev && !entry.devOptional)
    .map(([key]) => key);
  assert.ok(production.length >= 4, `expected the editor's production packages, got ${production.join(', ')}`);
  const out = path.join(tmp, 'notices.txt');
  writeNotices(lockPackages(EDITOR), out);
  const notices = await fs.readFile(out, 'utf8');
  for (const key of production) {
    const dir = path.join(EDITOR, key);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(notices.includes(`\n${pkg.name} ${pkg.version} (`), `${pkg.name} has no section`);
    const licence = (await fs.readdir(dir)).find((f) => /^licen[cs]e/i.test(f));
    assert.ok(licence, `${pkg.name} has no licence file to compare`);
    const text = (await fs.readFile(path.join(dir, licence), 'utf8')).trim();
    assert.ok(notices.includes(text), `${pkg.name}'s licence text is not in the notices`);
  }
});

await check('the packages esbuild bundled are found from its metafile, scoped ones included', () => {
  const cwd = '/work/editor';
  const metafile = {
    inputs: {
      'src/main/main.ts': {},
      '../src/config.ts': {},
      'node_modules/fflate/esm/index.mjs': {},
      'node_modules/fflate/esm/other.mjs': {},
      '../node_modules/@scope/thing/lib/index.js': {},
    },
  };
  assert.deepEqual(bundledPackages(metafile, cwd).sort(), ['/work/editor/node_modules/fflate', '/work/node_modules/@scope/thing'].sort());
});

await check('a package with no licence file stops the build, and is named', async () => {
  const dir = path.join(tmp, 'node_modules', 'unlicensed-thing');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'unlicensed-thing', version: '1.2.3' }));
  assert.throws(() => writeNotices([dir], path.join(tmp, 'never.txt')), /unlicensed-thing@1\.2\.3/);
});

await check('a package listed twice gets one section', async () => {
  const out = path.join(tmp, 'twice.txt');
  const fflate = path.join(EDITOR, 'node_modules', 'fflate');
  const keys = writeNotices([fflate, fflate], out);
  assert.equal(keys.filter((k: string) => k.startsWith('fflate@')).length, 1);
  assert.equal((await fs.readFile(out, 'utf8')).split('\nfflate ').length - 1, 1);
});

await fs.rm(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
