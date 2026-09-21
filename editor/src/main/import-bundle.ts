import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { expandPath, validateConfig } from '../../../src/config.js';
import { BUILTIN_ICONS } from '../../../src/default-icons.js';
import type { Config } from '../../../src/types.js';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  CONFIG_ENTRY,
  ICON_FIELDS,
  IMPORT_LIMITS,
  MANIFEST_ENTRY,
  RESTORED_FOLDER,
  type ExportManifest,
  type ImportIcon,
} from '../shared/backup.js';
import { BUILTIN_PREFIX, isShownIcon } from '../shared/icons.js';
import { iconReferences } from './export-bundle.js';

/**
 * Import. Three steps, kept apart so nothing
 * is written until the review has been seen and confirmed:
 *
 *   readImport()   the file's bytes → a checked config, manifest and icons
 *   planImport()   → what happens to every icon, and the config to write
 *   writePlannedIcons()  the icons, into empty places only; main then
 *                  replaces config.json through the store
 *
 * A bundle may come from anyone — a profile someone posted — so the rules
 * that make it safe live here: icons are written only inside home, only as
 * image files, never over anything, and a zip's declared sizes are limited
 * before fflate allocates them.
 */

export interface ReadImport {
  kind: 'bundle' | 'json';
  config: Config;
  manifest: ExportManifest | null;
  /** The bundle's icon files by entry name, each already checked against the manifest's sha256. */
  files: Map<string, Uint8Array>;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const ICON_ENTRY = /^icons\/[A-Za-z0-9._-]+$/;

/** A zip starts with "PK". Anything else is read as a bare config file. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function parseConfig(text: string, what: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return validateConfig(parsed);
  } catch (err) {
    throw new Error(`${what} is not a configuration Deckhand accepts: ${(err as Error).message}`);
  }
}

/** The manifest, checked field by field: every value in it steers what import does. */
function parseManifest(text: string): ExportManifest {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    throw new Error('its manifest is not valid JSON');
  }
  const bad = (what: string) => new Error(`its manifest is damaged: ${what}`);
  if (typeof m !== 'object' || m === null || m.format !== BUNDLE_FORMAT) throw bad('not a Deckhand export manifest');
  if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) throw bad('no format version');
  if (m.version > BUNDLE_VERSION) throw new Error(`it was made by a newer Deckhand (export format ${m.version}); update Deckhand to import it`);
  if (typeof m.home !== 'string' || !m.home.startsWith('/')) throw bad('no home folder');
  if (typeof m.includesIcons !== 'boolean') throw bad('no includesIcons');
  if (typeof m.exportedAt !== 'string') throw bad('no export time');
  const icons = m.icons;
  if (!Array.isArray(icons)) throw bad('no icon list');
  for (const i of icons as Array<Record<string, unknown>>) {
    if (typeof i !== 'object' || i === null || typeof i.path !== 'string') throw bad('an icon with no path');
    if (!(i.entry === null || (typeof i.entry === 'string' && ICON_ENTRY.test(i.entry)))) throw bad(`the icon ${i.path} names an entry outside icons/`);
    if (typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256)) throw bad(`the icon ${i.path} has no sha256`);
    if (typeof i.size !== 'number') throw bad(`the icon ${i.path} has no size`);
  }
  const missing = m.missing;
  if (!Array.isArray(missing) || missing.some((x) => typeof x?.path !== 'string' || typeof x?.reason !== 'string')) throw bad('the missing list');
  const builtins = m.builtins;
  if (!Array.isArray(builtins) || builtins.some((b) => typeof b !== 'string')) throw bad('the built-in list');
  return m as unknown as ExportManifest;
}

/**
 * Read an export or a bare config file. Throws with a message for the person
 * importing. Nothing is written.
 */
export function readImport(bytes: Uint8Array): ReadImport {
  if (!isZip(bytes)) {
    const config = parseConfig(strFromU8(bytes), 'the file');
    return { kind: 'json', config, manifest: null, files: new Map() };
  }

  // fflate allocates each entry at the size the zip declares, and never grows
  // it, so limiting the declared sizes
  // limits memory. Entries that are not part of an export are never unzipped.
  let entries = 0;
  let total = 0;
  let tooBig: string | null = null;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) => {
        entries++;
        if (entries > IMPORT_LIMITS.entries) tooBig ??= `more than ${IMPORT_LIMITS.entries} entries`;
        const ours = file.name === CONFIG_ENTRY || file.name === MANIFEST_ENTRY || ICON_ENTRY.test(file.name);
        if (!ours || tooBig) return false;
        total += file.originalSize;
        if (file.originalSize > IMPORT_LIMITS.entryBytes) tooBig = `${file.name} is larger than ${IMPORT_LIMITS.entryBytes / 1024 / 1024} MB`;
        else if (total > IMPORT_LIMITS.totalBytes) tooBig = `more than ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB in all`;
        return tooBig === null;
      },
    });
  } catch (err) {
    throw new Error(`it is not a zip Deckhand can read: ${(err as Error).message}`);
  }
  if (tooBig) throw new Error(`it is too large to be a Deckhand export: ${tooBig}`);

  const manifestBytes = unzipped[MANIFEST_ENTRY];
  if (!manifestBytes) throw new Error(`it is not a Deckhand export: there is no ${MANIFEST_ENTRY} in it`);
  const manifest = parseManifest(strFromU8(manifestBytes));
  const configBytes = unzipped[CONFIG_ENTRY];
  if (!configBytes) throw new Error(`it is damaged: there is no ${CONFIG_ENTRY} in it`);
  const config = parseConfig(strFromU8(configBytes), `its ${CONFIG_ENTRY}`);

  // Every icon the manifest says is in the zip must be there and match its
  // hash; a zip that lied about an entry's size fails here too, truncated.
  const files = new Map<string, Uint8Array>();
  for (const icon of manifest.icons) {
    if (icon.entry === null || files.has(icon.entry)) continue;
    const data = unzipped[icon.entry];
    if (!data) throw new Error(`it is damaged: ${icon.entry} is missing`);
    if (sha256(data) !== icon.sha256) throw new Error(`it is damaged: ${icon.entry} does not match its checksum`);
    files.set(icon.entry, data);
  }
  return { kind: 'bundle', config, manifest, files };
}

/** What is at a path now: nothing, a file (identical to `expected` or not, when there is one to compare), or something else. */
async function probe(file: string, expected: string | null): Promise<'none' | 'same' | 'different' | 'here' | 'not-a-file'> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return 'none';
  }
  if (!stat.isFile()) return 'not-a-file';
  if (expected === null) return 'here';
  try {
    return sha256(await fs.readFile(file)) === expected ? 'same' : 'different';
  } catch {
    return 'different';
  }
}

/** Every string outside the icon fields that contains `needle`, each once. */
function stringsNaming(config: unknown, needle: string): string[] {
  const found = new Set<string>();
  const fields: readonly string[] = ICON_FIELDS;
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes(needle)) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) if (!fields.includes(key)) walk(child);
    }
  };
  walk(config);
  return [...found];
}

/** A copy of the config with icon paths replaced by `to` wherever they appear. */
function rewriteIcons(config: Config, mapping: Map<string, string>): Config {
  const fields: readonly string[] = ICON_FIELDS;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = fields.includes(key) && typeof child === 'string' && mapping.has(child) ? mapping.get(child) : walk(child);
    }
    return out;
  };
  return walk(config) as Config;
}

export interface ImportPlan {
  kind: 'bundle' | 'json';
  /** The config to write: icon paths remapped and relocated. */
  config: Config;
  icons: ImportIcon[];
  /** Files to write, by absolute path: only where nothing is now, only inside home. */
  writes: Map<string, Uint8Array>;
  builtinsMissing: string[];
  oldHomeElsewhere: string[];
  profiles: string[];
  decks: Array<{ serial: string; name: string | null }>;
  exportedAt: string | null;
  exportedHome: string | null;
  includesIcons: boolean;
}

/**
 * Decide what happens to every icon path, looking at this machine but
 * writing nothing. For a bundle:
 *
 * - A path under the exporting home becomes `~/…`.
 * - A file already at the path is used, never overwritten: identical is
 *   "same", different is "kept".
 * - Nothing there: the bundle's file fills it — inside home, where the path
 *   points; outside home, under RESTORED_FOLDER, and the config is pointed
 *   there — and only if it is an image file the picker shows.
 *
 * A bare .json has no manifest: its paths are used as they are, and it can
 * only say whether a file is there.
 */
export async function planImport(read: ReadImport): Promise<ImportPlan> {
  const home = os.homedir();
  const manifest = read.manifest;
  const byPath = new Map((manifest?.icons ?? []).map((i) => [i.path, i]));
  const missingAtExport = new Set((manifest?.missing ?? []).map((m) => m.path));
  const inside = (file: string) => file.startsWith(home + path.sep);

  const icons: ImportIcon[] = [];
  const mapping = new Map<string, string>();
  const writes = new Map<string, Uint8Array>();
  const builtinsMissing: string[] = [];

  for (const from of iconReferences(read.config)) {
    if (from.startsWith(BUILTIN_PREFIX)) {
      const name = from.slice(BUILTIN_PREFIX.length);
      if (!(BUILTIN_ICONS as readonly string[]).includes(name) && !builtinsMissing.includes(name)) builtinsMissing.push(name);
      continue;
    }

    let to = from;
    if (manifest && from.startsWith(manifest.home + '/')) to = `~/${from.slice(manifest.home.length + 1)}`;
    const expanded = expandPath(to);
    if (!path.isAbsolute(expanded)) {
      icons.push({ from, to, relocated: false, outcome: 'refused', reason: 'not an absolute path' });
      continue;
    }
    // resolve() removes any "..": a path cannot climb out of home by them.
    const file = path.resolve(expanded);
    const bundled = byPath.get(from);
    const expected = bundled?.sha256 ?? null;
    const data = bundled?.entry ? read.files.get(bundled.entry) : undefined;

    const here = await probe(file, expected);
    if (here !== 'none') {
      const outcome = here === 'same' ? 'same' : here === 'here' ? 'here' : 'kept';
      const reason = here === 'different' ? 'a different file is already there' : here === 'not-a-file' ? 'something that is not a file is there' : undefined;
      icons.push({ from, to, relocated: false, outcome, ...(reason ? { reason } : {}) });
      if (to !== from) mapping.set(from, to);
      continue;
    }
    if (!data) {
      icons.push({ from, to, relocated: false, outcome: missingAtExport.has(from) ? 'missing-at-export' : 'absent' });
      if (to !== from) mapping.set(from, to);
      continue;
    }
    if (!isShownIcon(file)) {
      icons.push({ from, to, relocated: false, outcome: 'refused', reason: 'not an image file Deckhand shows' });
      if (to !== from) mapping.set(from, to);
      continue;
    }

    // Written: where it points inside home, else under the restored folder.
    let target = file;
    let relocated = false;
    if (!inside(file)) {
      to = `${RESTORED_FOLDER}${file}`;
      target = path.resolve(expandPath(to));
      relocated = true;
    }
    const there = relocated ? await probe(target, expected) : 'none';
    const already = writes.get(target);
    if (there === 'same' || (already && sha256(already) === expected)) {
      icons.push({ from, to, relocated, outcome: 'same' });
    } else if (there !== 'none' || already) {
      icons.push({ from, to, relocated, outcome: 'kept', reason: already ? 'another icon in this import goes there' : 'a different file is already there' });
    } else {
      writes.set(target, data);
      icons.push({ from, to, relocated, outcome: 'write' });
    }
    if (to !== from) mapping.set(from, to);
  }

  const config = rewriteIcons(read.config, mapping);
  const serials = new Set([...Object.keys(config.decks ?? {}), ...Object.values(config.profiles).flatMap((p) => Object.keys(p.layouts ?? {}))]);
  return {
    kind: read.kind,
    config,
    icons,
    writes,
    builtinsMissing,
    oldHomeElsewhere: manifest ? stringsNaming(config, manifest.home) : [],
    profiles: Object.entries(config.profiles).map(([id, p]) => p.name ?? id),
    decks: [...serials].map((serial) => ({ serial, name: config.decks?.[serial]?.name ?? null })),
    exportedAt: manifest?.exportedAt ?? null,
    exportedHome: manifest?.home ?? null,
    includesIcons: manifest?.includesIcons ?? false,
  };
}

/**
 * Write the planned icons. Each is created, never replaced ("wx"): a file
 * that appeared since the review is left alone and reported. Stops at the
 * first other failure, naming it; the config is not replaced then.
 */
export async function writePlannedIcons(writes: Map<string, Uint8Array>): Promise<{ written: string[]; appeared: string[] }> {
  const written: string[] = [];
  const appeared: string[] = [];
  const home = os.homedir();
  for (const [file, data] of writes) {
    // The plan only ever holds paths inside home; checked again at the write.
    if (!file.startsWith(home + path.sep) || !isShownIcon(file)) throw new Error(`refusing to write ${file}`);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data, { flag: 'wx' });
      written.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        appeared.push(file);
        continue;
      }
      throw new Error(`could not write ${file} (${written.length} icon file(s) written before it; config.json not changed): ${(err as Error).message}`);
    }
  }
  return { written, appeared };
}
