import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './backups.js';

/**
 * Secrets for the services Deckhand is a client of — OBS's password today,
 * Twitch's tokens later — in one owner-only file in the state directory
 * (scope §3, "Secrets"):
 *
 *   $XDG_STATE_HOME/deckhand/credentials.json   mode 0600
 *
 * **A secret is never in config.json, an export or a backup** (ARCHITECTURE,
 * invariants): export bundles config.json and its icons, the rolling backups
 * copy config.json, and neither touches this file. It is not in the config
 * directory either, which people sync or keep in dotfiles.
 *
 * Read afresh on every use, so a change needs no watcher and no reload. Only
 * the daemon writes it, by temp file and rename; nothing it holds is ever sent
 * back over the control socket — only whether a value is set.
 */

export const CREDENTIALS_PATH = path.join(STATE_DIR, 'credentials.json');

/** OBS's connection: where obs-websocket listens, and its password. */
export interface ObsCredentials {
  host?: string;
  port?: number;
  password?: string;
}

interface CredentialsFile {
  obs?: ObsCredentials;
}

async function readFile(): Promise<CredentialsFile> {
  let text: string;
  try {
    text = await fs.readFile(CREDENTIALS_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${CREDENTIALS_PATH} is not a JSON object`);
  return parsed as CredentialsFile;
}

/** OBS's credentials, or an empty object when none are set. A file that cannot be read or parsed throws: a broken file is not "no password". */
export async function obsCredentials(): Promise<ObsCredentials> {
  const obs = (await readFile()).obs;
  if (!obs || typeof obs !== 'object') return {};
  return {
    host: typeof obs.host === 'string' && obs.host !== '' ? obs.host : undefined,
    port: typeof obs.port === 'number' && Number.isInteger(obs.port) ? obs.port : undefined,
    password: typeof obs.password === 'string' && obs.password !== '' ? obs.password : undefined,
  };
}

/**
 * Change OBS's credentials: each field given replaces the stored one, and an
 * empty string or null removes it. Written 0600, by temp file and rename, so
 * a reader never sees half a file and the secret is never on disk with wider
 * permissions, even for a moment.
 */
export async function setObsCredentials(change: { host?: string | null; port?: number | null; password?: string | null }): Promise<void> {
  const file = await readFile();
  const obs: ObsCredentials = { ...(file.obs ?? {}) };
  for (const key of ['host', 'port', 'password'] as const) {
    if (!(key in change)) continue;
    const value = change[key];
    if (value === null || value === '') delete obs[key];
    else (obs as Record<string, unknown>)[key] = value;
  }
  const next: CredentialsFile = { ...file, obs };
  if (Object.keys(obs).length === 0) delete next.obs;

  // Created owner-only if it is not there yet; an existing state directory is
  // left as it is — it holds the backups and the editor's state too, and the
  // file's own 0600 is what keeps the secret.
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${CREDENTIALS_PATH}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'w' });
    // writeFile's mode applies only when it creates the file; a leftover temp file keeps its own.
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, CREDENTIALS_PATH);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}
