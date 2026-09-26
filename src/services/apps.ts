import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetIconThemes, parseIni, resolveIcon } from './icon-theme.js';

/**
 * The desktop's installed applications, from their desktop entries: the
 * `applications/` directory under XDG_DATA_HOME and under each of
 * XDG_DATA_DIRS, in that order. That covers the system's, the user's, and
 * Flatpak's and Snap's exports, which put their directories on XDG_DATA_DIRS.
 *
 * An app is known by its desktop file ID — `org.gimp.GIMP.desktop`, or
 * `kde-foo.desktop` for `kde/foo.desktop` — and the first directory with an ID
 * wins, so the user's copy shadows the system's, and a user copy with
 * `Hidden=true` removes the app. The config stores the ID, never a path.
 *
 * Read when asked, never watched: the editor asks when it opens its app list,
 * and a key reads its one entry when pressed.
 */

export interface AppEntry {
  /** The desktop file ID, what the config stores. */
  id: string;
  /** The entry's file, which `gio launch` is given. */
  file: string;
  name: string;
  /** The `Icon=` value: a theme name, or rarely an absolute path. */
  icon: string | null;
  /** NoDisplay=true: launchable, but not listed in menus. */
  noDisplay: boolean;
  /** Hidden=true: deleted, as far as the desktop is concerned. */
  hidden: boolean;
  onlyShowIn: string[];
  notShowIn: string[];
  tryExec: string | null;
  type: string | null;
}

export function applicationDirs(): string[] {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [...new Set([dataHome, ...dataDirs])].map((d) => path.join(d, 'applications'));
}

/** Every `.desktop` file under one applications directory, by ID: `a/b.desktop` is `a-b.desktop`. */
async function entryFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (dir: string, prefix: string) => {
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}-`);
      // Flatpak's exports are symbolic links.
      else if (entry.name.endsWith('.desktop') && (entry.isFile() || entry.isSymbolicLink())) found.set(`${prefix}${entry.name}`, full);
    }
  };
  await walk(root, '');
  return found;
}

/** Name[de_DE], then Name[de], then Name — the specification's order, without the @modifier forms. */
function localised(group: Map<string, string>, key: string): string | undefined {
  const locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0];
  const lang = locale.split('_')[0];
  return (locale && group.get(`${key}[${locale}]`)) || (lang && group.get(`${key}[${lang}]`)) || group.get(key);
}

const list = (value: string | undefined) => (value ?? '').split(';').map((s) => s.trim()).filter(Boolean);

export function parseDesktopEntry(id: string, file: string, text: string): AppEntry | null {
  const group = parseIni(text).get('Desktop Entry');
  if (!group) return null;
  return {
    id,
    file,
    name: localised(group, 'Name') ?? id.replace(/\.desktop$/, ''),
    icon: localised(group, 'Icon') || null,
    noDisplay: group.get('NoDisplay') === 'true',
    hidden: group.get('Hidden') === 'true',
    onlyShowIn: list(group.get('OnlyShowIn')),
    notShowIn: list(group.get('NotShowIn')),
    tryExec: group.get('TryExec') || null,
    type: group.get('Type') ?? null,
  };
}

async function onPath(program: string): Promise<boolean> {
  const candidates = path.isAbsolute(program)
    ? [program]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, program));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // next
    }
  }
  return false;
}

/** Every ID to the file that wins it: the first applications directory that has it. */
async function winningFiles(): Promise<Map<string, string>> {
  const winners = new Map<string, string>();
  for (const dir of applicationDirs()) {
    for (const [id, file] of await entryFiles(dir)) if (!winners.has(id)) winners.set(id, file);
  }
  return winners;
}

async function readEntry(id: string, file: string): Promise<AppEntry | null> {
  try {
    return parseDesktopEntry(id, file, await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether a menu on this desktop would list it. */
async function listable(entry: AppEntry): Promise<boolean> {
  if (entry.type !== 'Application' || entry.hidden || entry.noDisplay) return false;
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').split(':').filter(Boolean);
  if (entry.onlyShowIn.length > 0 && !entry.onlyShowIn.some((d) => desktops.includes(d))) return false;
  if (entry.notShowIn.some((d) => desktops.includes(d))) return false;
  if (entry.tryExec && !(await onPath(entry.tryExec))) return false;
  return true;
}

/** The applications a menu on this desktop would list, by name. */
export async function listApps(): Promise<AppEntry[]> {
  const entries = await Promise.all([...(await winningFiles())].map(([id, file]) => readEntry(id, file)));
  const shown: AppEntry[] = [];
  for (const entry of entries) if (entry && (await listable(entry))) shown.push(entry);
  return shown.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * One application by ID, for a key: listed or not (a hand-written key may name
 * a NoDisplay entry), but not a hidden one — the desktop considers it deleted.
 * Null if no applications directory has it.
 */
export async function findApp(id: string): Promise<AppEntry | null> {
  const file = (await winningFiles()).get(id);
  if (!file) return null;
  const entry = await readEntry(id, file);
  return entry && !entry.hidden && entry.type === 'Application' ? entry : null;
}

const appIcons = new Map<string, Promise<string | null>>();

/**
 * The file an app's icon resolves to at about `size` pixels, or null. Cached
 * per app and size — a key asks on every draw — until forgetApps().
 */
export function appIconFile(id: string, size: number): Promise<string | null> {
  const key = `${size}|${id}`;
  let hit = appIcons.get(key);
  if (!hit) {
    hit = findApp(id).then((entry) => (entry?.icon ? resolveIcon(entry.icon, size) : null));
    appIcons.set(key, hit);
  }
  return hit;
}

/** Forget every cached app icon and icon theme, so the next look reads the disk again. */
export function forgetApps(): void {
  appIcons.clear();
  forgetIconThemes();
}
