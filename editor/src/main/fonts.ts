import { execFile } from 'node:child_process';
import { validFontName } from '../../../src/config-common.js';
import type { SystemFonts } from '../shared/bridge.js';

/**
 * The installed font families, for Settings › General › Label font: asked of
 * fontconfig (`fc-list`, which the daemon's own text rendering goes through)
 * only when Settings asks — each time its General page opens — and never
 * kept, watched or polled, so finding them costs nothing at rest.
 *
 * One entry per family: fc-list gives a line per face, its family's names
 * comma-separated, the first the family's own; names Deckhand could not write
 * into a label's style (config-common.ts validFontName) and hidden ones
 * (starting with ".") are left out. With the name Deckhand's default
 * (`sans-serif`) resolves to here, shown beside "Default".
 */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export function familiesFrom(fcList: string): string[] {
  const names = new Map<string, string>();
  for (const line of fcList.split('\n')) {
    const name = line.split(',')[0]?.replace(/\\-/g, '-').trim() ?? '';
    if (name === '' || name.startsWith('.') || !validFontName(name)) continue;
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function systemFonts(): Promise<SystemFonts> {
  const [list, match] = await Promise.all([run('fc-list', [':', 'family']), run('fc-match', ['sans-serif', '--format=%{family[0]}'])]);
  return {
    available: list !== null,
    families: list === null ? [] : familiesFrom(list),
    defaultName: match?.trim() || null,
  };
}
