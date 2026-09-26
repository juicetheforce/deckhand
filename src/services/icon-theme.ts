import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Icon names to files: the freedesktop Icon Theme Specification, done here
 * because the daemon has neither GTK nor Qt to do it. A desktop entry says
 * `Icon=gimp`; this finds the file the desktop would draw for it.
 *
 * The theme is the desktop's: KDE's `[Icons] Theme` from kdeglobals, else
 * GNOME's `icon-theme` setting. Then its `Inherits`, then `hicolor` (every
 * theme falls back to it), then the unthemed `pixmaps` directory. Only PNG
 * and SVG are returned: sharp draws both, and XPM it cannot.
 *
 * Everything read is cached — index files, directory listings, answers — and
 * nothing is watched. forgetIconThemes() clears it, which the socket's `apps`
 * command does, so the editor opening its app list picks up a changed theme
 * or a newly installed app. A key's face asks resolveIcon() on each draw and
 * gets the cached answer.
 */

interface ThemeDir {
  /** Relative to the theme's directory, e.g. `48x48/apps` or `scalable/apps`. */
  name: string;
  size: number;
  scale: number;
  type: 'Fixed' | 'Scalable' | 'Threshold';
  minSize: number;
  maxSize: number;
  threshold: number;
}

interface Theme {
  name: string;
  /** Every base directory that has this theme, in lookup order. */
  roots: string[];
  inherits: string[];
  dirs: ThemeDir[];
}

const EXTENSIONS = ['.png', '.svg'];

/** Where themes live, in the specification's order. */
export function iconBaseDirs(): string[] {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [path.join(home, '.icons'), path.join(dataHome, 'icons'), ...dataDirs.map((d) => path.join(d, 'icons'))];
}

function pixmapDirs(): string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [...new Set([...dataDirs.map((d) => path.join(d, 'pixmaps')), '/usr/share/pixmaps'])];
}

/** The groups of an ini-style file (index.theme, kdeglobals), as group → key → value. Comments and blank lines skipped. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      current = groups.get(name) ?? new Map();
      groups.set(name, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !current) continue;
    const key = line.slice(0, eq).trim();
    // The first value wins, as in KConfig and GLib.
    if (!current.has(key)) current.set(key, line.slice(eq + 1).trim());
  }
  return groups;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * KDE's icon theme. KConfig reads kdeglobals as a cascade: the user's file
 * wins, then the look-and-feel defaults Plasma writes to `kdedefaults/` (where
 * Plasma 6 keeps the theme when the user has not overridden it — checked on
 * Fedora 44), then the system's. With none of them naming one, Plasma uses
 * breeze.
 */
async function kdeTheme(): Promise<string> {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const configDirs = (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean);
  const files = [
    path.join(configHome, 'kdeglobals'),
    path.join(configHome, 'kdedefaults', 'kdeglobals'),
    ...configDirs.map((d) => path.join(d, 'kdeglobals')),
  ];
  for (const file of files) {
    const text = await readText(file);
    const theme = text === null ? undefined : parseIni(text).get('Icons')?.get('Theme');
    if (theme) return theme;
  }
  return 'breeze';
}

/** GNOME's icon theme, from gsettings; null if there is no gsettings or it says nothing. */
async function gnomeTheme(): Promise<string | null> {
  try {
    const { stdout } = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], { timeout: 2000 });
    const value = stdout.trim().replace(/^'(.*)'$/, '$1');
    return value || null;
  } catch {
    return null;
  }
}

let themeName: Promise<string> | null = null;

/** The desktop's icon theme: KDE's under KDE, otherwise GNOME's setting, otherwise hicolor. Asked once, until forgotten. */
export function currentIconTheme(): Promise<string> {
  themeName ??= (async () => {
    const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').split(':');
    if (desktops.includes('KDE')) return kdeTheme();
    return (await gnomeTheme()) ?? 'hicolor';
  })();
  return themeName;
}

const themes = new Map<string, Promise<Theme | null>>();

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : fallback;
}

async function loadTheme(name: string): Promise<Theme | null> {
  const roots: string[] = [];
  let index: Map<string, Map<string, string>> | null = null;
  for (const base of iconBaseDirs()) {
    const root = path.join(base, name);
    try {
      await fs.access(root);
    } catch {
      continue;
    }
    roots.push(root);
    if (!index) {
      const text = await readText(path.join(root, 'index.theme'));
      if (text !== null) index = parseIni(text);
    }
  }
  if (!index) return null;

  const head = index.get('Icon Theme');
  const listed = [head?.get('Directories'), head?.get('ScaledDirectories')]
    .flatMap((v) => (v ?? '').split(','))
    .map((d) => d.trim())
    .filter(Boolean);
  const dirs: ThemeDir[] = [];
  for (const dir of new Set(listed)) {
    const group = index.get(dir);
    if (!group) continue;
    const size = num(group.get('Size'), 0);
    const kind = group.get('Type');
    dirs.push({
      name: dir,
      size,
      scale: num(group.get('Scale'), 1),
      type: kind === 'Fixed' || kind === 'Scalable' ? kind : 'Threshold',
      minSize: num(group.get('MinSize'), size),
      maxSize: num(group.get('MaxSize'), size),
      threshold: num(group.get('Threshold'), 2),
    });
  }
  const inherits = (head?.get('Inherits') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return { name, roots, inherits, dirs };
}

function theme(name: string): Promise<Theme | null> {
  let hit = themes.get(name);
  if (!hit) {
    hit = loadTheme(name);
    themes.set(name, hit);
  }
  return hit;
}

// Directory listings, so a lookup is set membership rather than a stat per candidate file.
const listings = new Map<string, Promise<Set<string>>>();

function listing(dir: string): Promise<Set<string>> {
  let hit = listings.get(dir);
  if (!hit) {
    hit = fs.readdir(dir).then(
      (names) => new Set(names),
      () => new Set<string>(),
    );
    listings.set(dir, hit);
  }
  return hit;
}

/** The specification's DirectoryMatchesSize, at scale 1. */
function matches(dir: ThemeDir, size: number): boolean {
  if (dir.scale !== 1) return false;
  if (dir.type === 'Fixed') return dir.size === size;
  if (dir.type === 'Scalable') return dir.minSize <= size && size <= dir.maxSize;
  return dir.size - dir.threshold <= size && size <= dir.size + dir.threshold;
}

/** The specification's DirectorySizeDistance, at scale 1. */
function distance(dir: ThemeDir, size: number): number {
  if (dir.type === 'Fixed') return Math.abs(dir.size - size);
  if (dir.type === 'Scalable') {
    if (size < dir.minSize) return dir.minSize - size;
    if (size > dir.maxSize) return size - dir.maxSize;
    return 0;
  }
  // Size ± Threshold, as GTK does; the specification's text says MinSize and
  // MaxSize here, which a Threshold directory does not set.
  if (size < dir.size - dir.threshold) return dir.size - dir.threshold - size;
  if (size > dir.size + dir.threshold) return size - dir.size - dir.threshold;
  return 0;
}

/** The icon in one theme (not its parents): an exact size match first, then the closest. */
async function lookupInTheme(t: Theme, icon: string, size: number): Promise<string | null> {
  const found = async (dir: ThemeDir): Promise<string | null> => {
    for (const root of t.roots) {
      const names = await listing(path.join(root, dir.name));
      for (const ext of EXTENSIONS) if (names.has(icon + ext)) return path.join(root, dir.name, icon + ext);
    }
    return null;
  };

  for (const dir of t.dirs) {
    if (!matches(dir, size)) continue;
    const file = await found(dir);
    if (file) return file;
  }

  // Closest, with one departure from the specification: a bitmap directory
  // whose icons are smaller than the key comes after every other. A key is
  // drawn larger than any menu icon, and a small bitmap scaled up blurs where
  // a large one scaled down, or an SVG, does not.
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const dir of t.dirs) {
    if (dir.scale !== 1) continue;
    const tooSmall = dir.type !== 'Scalable' && dir.maxSize < size;
    const d = distance(dir, size) + (tooSmall ? 100_000 : 0);
    if (d >= bestDistance) continue;
    const file = await found(dir);
    if (file) {
      best = file;
      bestDistance = d;
    }
  }
  return best;
}

async function lookup(icon: string, size: number): Promise<string | null> {
  // The theme, then its parents depth-first, each once; hicolor last whatever they say.
  const seen = new Set<string>();
  const visit = async (name: string): Promise<string | null> => {
    if (seen.has(name)) return null;
    seen.add(name);
    const t = await theme(name);
    if (!t) return null;
    const file = await lookupInTheme(t, icon, size);
    if (file) return file;
    for (const parent of t.inherits) {
      if (parent === 'hicolor') continue;
      const inherited = await visit(parent);
      if (inherited) return inherited;
    }
    return null;
  };

  const themed = (await visit(await currentIconTheme())) ?? (await visit('hicolor'));
  if (themed) return themed;

  for (const dir of pixmapDirs()) {
    const names = await listing(dir);
    for (const ext of EXTENSIONS) if (names.has(icon + ext)) return path.join(dir, icon + ext);
  }
  return null;
}

const answers = new Map<string, Promise<string | null>>();

/**
 * The file for a desktop entry's `Icon=` value at about `size` pixels, or null
 * if there is none this daemon can draw. An absolute path is used as it is,
 * if it exists.
 */
export function resolveIcon(icon: string, size: number): Promise<string | null> {
  const key = `${size}|${icon}`;
  let hit = answers.get(key);
  if (!hit) {
    hit = (async () => {
      if (path.isAbsolute(icon)) {
        try {
          await fs.access(icon);
          return icon;
        } catch {
          return null;
        }
      }
      // A name given with an extension (a mistake the specification tolerates) is looked up without it.
      const name = EXTENSIONS.includes(path.extname(icon)) ? icon.slice(0, -path.extname(icon).length) : icon;
      return lookup(name, size);
    })();
    answers.set(key, hit);
  }
  return hit;
}

/** Drop everything cached: the theme name, the themes, the listings, the answers. */
export function forgetIconThemes(): void {
  themeName = null;
  themes.clear();
  listings.clear();
  answers.clear();
}
