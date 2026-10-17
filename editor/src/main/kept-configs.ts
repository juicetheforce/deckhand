/**
 * The configurations Deckhand keeps before it replaces one: an import's
 * `before-import-<time>.json` and a profile delete's `before-delete-<time>.json`,
 * in `$XDG_STATE_HOME/deckhand/backups/`.
 *
 * They are exempt from the rolling rotation (src/backups.ts deletes only
 * `config-<time>.json`), which is what makes them reliable and also means they
 * would accumulate forever. The rules:
 *
 * - **A kept copy is never deleted except by the user**, from the list in Settings.
 *   The rolling backups drop the oldest because the newest snapshot is the
 *   useful one; here it is the other way round — the copy from before the
 *   profile deleted three months ago is exactly the one worth keeping — so a
 *   cap that dropped the oldest would destroy highest value first.
 * - **The cap refuses rather than rotates.** At MAX_KEPT_CONFIGS, the delete
 *   or import stops and says to remove one first; nothing is deleted, and no
 *   destructive operation goes ahead without its copy.
 * - **An identical copy is not written twice.** Importing the same file again,
 *   or deleting from an unchanged config, produces the same bytes; the content
 *   is already kept, so nothing is written and the existing file is named.
 *
 * No time-based expiry: a 30-day window would delete these exactly as they
 * become valuable.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../../src/types.js';
import { MAX_KEPT_CONFIGS, type KeptConfig, type KeptReason } from '../shared/backup.js';

/** before-delete-2026-09-19T22-05-27.962Z.json — the time with ":" replaced, as the rolling backups write it. */
const KEPT_NAME = /^before-(delete|import)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.json$/;

export function keptFileName(reason: KeptReason, when: Date): string {
  return `before-${reason}-${when.toISOString().replace(/:/g, '-')}.json`;
}

/** The ISO time in a kept copy's name, or null if it is not one of ours. */
function keptNameParts(name: string): { reason: KeptReason; keptAt: string } | null {
  const match = KEPT_NAME.exec(name);
  if (!match) return null;
  const [, reason, stamp] = match;
  // Back to a real ISO string: only the time's colons were replaced.
  const at = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  return { reason: reason as KeptReason, keptAt: at };
}

/**
 * What a kept copy holds, so the list can be read without opening files
 * (a timestamp alone means guessing). Anything unreadable
 * is described rather than hidden — it is still restorable, and the import's
 * own review is what checks it.
 */
function summarise(text: string): KeptConfig['summary'] {
  const config = JSON.parse(text) as Config;
  const profiles = Object.entries(config.profiles ?? {}).map(([id, profile]) => profile.name ?? id);
  const decks = new Set<string>();
  let keys = 0;
  for (const profile of Object.values(config.profiles ?? {})) {
    for (const [serial, layout] of Object.entries(profile.layouts ?? {})) {
      decks.add(serial);
      for (const page of Object.values(layout.pages ?? {})) keys += Object.keys(page.buttons ?? {}).length;
    }
  }
  return { profiles, decks: decks.size, keys };
}

/** Every kept configuration, newest first, with what it holds. */
export async function listKeptConfigs(dir: string): Promise<KeptConfig[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // no backups folder yet
  }
  const entries: KeptConfig[] = [];
  for (const name of names) {
    const parts = keptNameParts(name);
    if (!parts) continue;
    const file = path.join(dir, name);
    let bytes = 0;
    let summary: KeptConfig['summary'] = null;
    let problem: string | undefined;
    try {
      const text = await fs.readFile(file, 'utf8');
      bytes = Buffer.byteLength(text);
      summary = summarise(text);
    } catch (err) {
      problem = (err as Error).message;
    }
    entries.push({ file: name, ...parts, bytes, summary, problem });
  }
  return entries.sort((a, b) => b.keptAt.localeCompare(a.keptAt));
}

export interface KeepResult {
  /** The file the configuration is kept in — the existing one when it was already there. */
  file: string;
  /** It was already kept, byte for byte, so nothing was written. */
  identical: boolean;
}

/**
 * Keep `text` before something replaces it. Throws when the cap is reached, so
 * the caller stops: nothing is deleted or imported without its copy.
 */
export async function keepConfigCopy(dir: string, text: string, reason: KeptReason, now = new Date()): Promise<KeepResult> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await listKeptConfigs(dir);
  for (const entry of existing) {
    if (entry.problem !== undefined) continue;
    const kept = await fs.readFile(path.join(dir, entry.file), 'utf8').catch(() => null);
    if (kept === text) return { file: entry.file, identical: true };
  }
  if (existing.length >= MAX_KEPT_CONFIGS) {
    throw new Error(
      `Deckhand keeps at most ${MAX_KEPT_CONFIGS} configurations and there are ${existing.length}. ` +
        'Delete one in Settings first — they are never deleted automatically.',
    );
  }
  const name = keptFileName(reason, now);
  await fs.writeFile(path.join(dir, name), text, { flag: 'wx' });
  return { file: name, identical: false };
}

/** The full path of a kept copy, refusing any name that is not one of ours (so never a path from a page). */
export function keptConfigPath(dir: string, file: string): string {
  if (keptNameParts(file) === null) throw new Error(`"${file}" is not a kept configuration`);
  return path.join(dir, file);
}

/** Delete one kept configuration — the only thing that removes one. */
export async function deleteKeptConfig(dir: string, file: string): Promise<void> {
  await fs.unlink(keptConfigPath(dir, file));
}
