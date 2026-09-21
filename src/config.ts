import { promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePage, resolveProfile } from './config-common.js';
import type { Config, LayoutDef } from './types.js';

// Defaults and reference resolution live in config-common.ts, which needs no
// file system, so the editor's renderer can import them. Re-exported here so
// daemon code keeps importing from config.js.
export { DEFAULTS, resolvePage, resolveProfile, startPageOf, startProfileOf } from './config-common.js';

export const CONFIG_DIR =
  process.env.DECKHAND_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'deckhand');

export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Expand a leading ~ so icon paths can be written the way you'd type them. */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throw if a name could refer to two entries: two entries share a name, or an
 * entry's name is another entry's ID (the ID would always win, so that name
 * could never be reached).
 */
function rejectDuplicateNames(
  entries: Record<string, unknown>,
  kind: 'page' | 'profile',
  where: string,
): void {
  const seen = new Map<string, string>();
  for (const [id, entry] of Object.entries(entries)) {
    const name = isObject(entry) ? entry.name : undefined;
    if (name === undefined) continue;
    if (typeof name !== 'string') {
      throw new Error(`${kind} "${id}"${where} has a "name" that is not a string`);
    }
    if (name !== id && Object.prototype.hasOwnProperty.call(entries, name)) {
      throw new Error(`${kind} "${id}"${where} is named "${name}", which is another ${kind}'s ID`);
    }
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(`${kind}s "${other}" and "${id}"${where} are both named "${name}" — names must be unique`);
    }
    seen.set(name, id);
  }
}

function validateLayout(layout: unknown, where: string): void {
  if (!isObject(layout)) throw new Error(`${where} must be an object`);
  if (!isObject(layout.pages)) throw new Error(`${where} is missing a "pages" object`);
  if (Object.keys(layout.pages).length === 0) throw new Error(`${where} has no pages defined`);
  rejectDuplicateNames(layout.pages, 'page', ` in ${where}`);

  for (const [pageId, page] of Object.entries(layout.pages)) {
    if (!isObject(page) || !isObject(page.buttons)) {
      throw new Error(`page "${pageId}" in ${where} is missing "buttons"`);
    }
    for (const key of Object.keys(page.buttons)) {
      if (!/^\d+$/.test(key)) {
        throw new Error(`button key "${key}" on page "${pageId}" in ${where} must be a numeric index`);
      }
    }
  }

  if (layout.startPage !== undefined) {
    if (typeof layout.startPage !== 'string' || resolvePage(layout as unknown as LayoutDef, layout.startPage) === null) {
      throw new Error(`${where} startPage "${String(layout.startPage)}" does not match a page ID or name`);
    }
  }
}

export function validateConfig(config: unknown): Config {
  if (!isObject(config)) throw new Error('config must be a JSON object');

  if (config.decks !== undefined) {
    if (!isObject(config.decks)) throw new Error('"decks" must be an object');
    for (const [serial, deck] of Object.entries(config.decks)) {
      if (!isObject(deck)) throw new Error(`deck "${serial}" must be an object`);
    }
  }

  if (!isObject(config.profiles)) throw new Error('config is missing a "profiles" object');
  if (Object.keys(config.profiles).length === 0) throw new Error('config has no profiles defined');
  rejectDuplicateNames(config.profiles, 'profile', '');

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (!isObject(profile) || !isObject(profile.layouts)) {
      throw new Error(`profile "${profileId}" is missing a "layouts" object`);
    }
    for (const [serial, layout] of Object.entries(profile.layouts)) {
      validateLayout(layout, `profile "${profileId}" layout for deck "${serial}"`);
    }
  }

  if (config.startProfile !== undefined) {
    const valid = config as unknown as Config;
    if (typeof config.startProfile !== 'string' || resolveProfile(valid, config.startProfile) === null) {
      throw new Error(`startProfile "${String(config.startProfile)}" does not match a profile ID or name`);
    }
  }

  return config as unknown as Config;
}

/**
 * Load and validate config.json. The file text comes back too, because a
 * rolling backup (src/backups.ts) saves the config exactly as it was written.
 */
export async function loadConfig(): Promise<{ config: Config; text: string }> {
  const text = await fs.readFile(CONFIG_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  return { config: validateConfig(parsed), text };
}

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

/** True only when config.json is absent — not when it exists but is broken. */
export async function configMissing(): Promise<boolean> {
  try {
    await fs.access(CONFIG_PATH);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Write a first config. The 'wx' flag refuses to overwrite, so a config that
 * appeared in the meantime is never clobbered.
 */
export async function writeNewConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
}

/**
 * Watch the config file and call back on change. Watches the config
 * directory, not the file, so a write by rename (as the editor does) is still
 * seen. Deliberately non-recursive and filtered on the file name: nothing
 * else written in or below this directory may trigger a reload. Bursts are
 * debounced to one reload, and the watch is re-established if it errors.
 */
export function watchConfig(onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let stopped = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };

  const attach = () => {
    if (stopped) return;
    try {
      watcher = watch(CONFIG_DIR, (_event, filename) => {
        if (!filename || filename.toString() === 'config.json') schedule();
      });
      watcher.on('error', () => {
        watcher?.close();
        setTimeout(attach, 1000);
      });
    } catch {
      setTimeout(attach, 1000);
    }
  };

  attach();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
