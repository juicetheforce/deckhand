import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { expandPath, validateConfig } from '../../../src/config.js';
import { BUNDLE_FORMAT, BUNDLE_VERSION, CONFIG_ENTRY, ICON_FIELDS, MANIFEST_ENTRY, type BundledIcon, type ExportManifest } from '../shared/backup.js';
import { BUILTIN_PREFIX } from '../shared/icons.js';

/**
 * Building an export (M5 piece 1, docs/scope.md §5). The import half is
 * piece 2; this file only reads the config and the icon files it names.
 */

/**
 * Every icon string in a config, in the order first found, each once: the
 * values of ICON_FIELDS anywhere in it — keys, `onRelease`, multi steps —
 * so a path is bundled wherever the config keeps it. Built-ins included.
 */
export function iconReferences(config: unknown): string[] {
  const found = new Set<string>();
  const fields: readonly string[] = ICON_FIELDS;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (fields.includes(key) && typeof child === 'string') {
          if (child !== '') found.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(config);
  return [...found];
}

/** A file name safe inside a zip on any system: letters, digits, dot, dash, underscore. */
function entryName(index: number, file: string): string {
  const base = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'icon';
  return `icons/${String(index).padStart(3, '0')}-${base}`;
}

/**
 * The zip for a config file's text. Refuses a config the daemon would refuse.
 * An icon that cannot be read is listed in the manifest's `missing` and left
 * out; it does not stop the export — a missing file is already broken on the
 * deck, and the rest is still worth keeping.
 */
export async function buildExport(configText: string, includeIcons: boolean): Promise<{ zip: Uint8Array; manifest: ExportManifest; iconFiles: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  validateConfig(parsed);

  const manifest: ExportManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    home: os.homedir(),
    includesIcons: includeIcons,
    icons: [],
    missing: [],
    builtins: [],
  };
  const files: Zippable = {};
  // One entry per file, however many config paths name it (`~/a.png` and
  // `/home/you/a.png` are one file).
  const entryForFile = new Map<string, { entry: string | null; sha256: string; size: number }>();

  for (const ref of iconReferences(parsed)) {
    if (ref.startsWith(BUILTIN_PREFIX)) {
      manifest.builtins.push(ref.slice(BUILTIN_PREFIX.length));
      continue;
    }
    const file = expandPath(ref);
    if (!path.isAbsolute(file)) {
      manifest.missing.push({ path: ref, reason: 'not an absolute path' });
      continue;
    }
    let known = entryForFile.get(file);
    if (!known) {
      let data: Buffer;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) {
          manifest.missing.push({ path: ref, reason: 'not a file' });
          continue;
        }
        data = await fs.readFile(file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        manifest.missing.push({ path: ref, reason: code === 'ENOENT' ? 'not found' : `cannot be read (${code ?? (err as Error).message})` });
        continue;
      }
      const entry = includeIcons ? entryName(entryForFile.size + 1, file) : null;
      // Stored, not deflated: image files are already compressed. On the maintainer's
      // 31 icons, deflating took 379 ms of the main process for 0.09% smaller.
      if (entry) files[entry] = [new Uint8Array(data), { level: 0 }];
      known = { entry, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
      entryForFile.set(file, known);
    }
    const icon: BundledIcon = { path: ref, ...known };
    manifest.icons.push(icon);
  }

  files[CONFIG_ENTRY] = strToU8(configText);
  files[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  const iconFiles = includeIcons ? entryForFile.size : 0;
  return { zip: zipSync(files, { level: 6 }), manifest, iconFiles };
}

/** Written beside the destination under a temporary name, then renamed onto it, so a failed write never leaves half a zip. */
export async function writeExport(destination: string, zip: Uint8Array): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, zip, { flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    throw err;
  }
}

/** The name the save dialog suggests: deckhand-2026-09-19.zip, or …-config.zip without icons. */
export function suggestedExportName(includeIcons: boolean, now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `deckhand-${day}${includeIcons ? '' : '-config'}.zip`;
}
