// The editor ships bundled code — esbuild and Vite fold its dependencies into
// dist/ and strip their licence comments — so their licences have to travel
// in a file of their own: dist/THIRD-PARTY-NOTICES.txt. Electron is not in
// it: the installer ships Electron's whole directory, which carries its own
// LICENSE and LICENSES.chromium.html.
//
// Two sources, so a package cannot be missed: every production package in the
// editor's lock (the renderer's React and its scheduler come only from here),
// and every node_modules package esbuild reports having bundled into main or
// preload, which can reach the repository root's node_modules through the
// daemon's source.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Package directories named in the lock as production dependencies. */
export function lockPackages(editorRoot) {
  const lock = JSON.parse(readFileSync(path.join(editorRoot, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key !== '' && !entry.dev && !entry.devOptional)
    .map(([key]) => path.join(editorRoot, key));
}

/** Package directories that an esbuild metafile's inputs came from. */
export function bundledPackages(metafile, cwd) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = path.resolve(cwd, input).split(path.sep);
    const at = parts.lastIndexOf('node_modules');
    if (at === -1) continue;
    const nameParts = parts[at + 1].startsWith('@') ? 2 : 1;
    dirs.add(parts.slice(0, at + 1 + nameParts).join(path.sep));
  }
  return [...dirs];
}

function licenceFile(dir) {
  const name = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return name === undefined ? undefined : path.join(dir, name);
}

/**
 * Writes the notices for the given package directories to `outfile`.
 * Throws, naming the package, if one has no licence file: a build that
 * cannot say what it ships under which licence should not succeed.
 */
export function writeNotices(packageDirs, outfile) {
  const seen = new Map();
  for (const dir of packageDirs) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    const file = licenceFile(dir);
    if (file === undefined) throw new Error(`third-party notices: ${key} (${dir}) has no licence file`);
    seen.set(key, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'see below', text: readFileSync(file, 'utf8').trim() });
  }
  const rule = '='.repeat(72);
  const sections = [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${rule}\n${p.name} ${p.version} (${p.license})\n${rule}\n\n${p.text}\n`);
  const header =
    "Deckhand's editor includes the following packages, bundled into its\n" +
    "code. Their licences follow. Electron's own licences are in the\n" +
    "installed editor's electron/ directory (../electron/ from this file):\n" +
    'LICENSE and LICENSES.chromium.html.\n';
  writeFileSync(outfile, `${header}\n${sections.join('\n')}`);
  return [...seen.keys()];
}
