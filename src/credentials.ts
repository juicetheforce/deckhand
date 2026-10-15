import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './backups.js';

/**
 * Secrets for the services Deckhand is a client of — OBS's password, VTube
 * Studio's token and Twitch's tokens, one section each — in one owner-only file in the
 * state directory:
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
 *
 * **Every change is a read, a change and a write of the whole file, one at a
 * time** (exclusively, below). Two at once — a Twitch refresh while Settings
 * saves OBS's password — would otherwise each write the file as it was before
 * the other: one change lost, and a lost refresh token ends the Twitch link.
 * Each write has a temp file of its own, so two can never write into one.
 */

export const CREDENTIALS_PATH = path.join(STATE_DIR, 'credentials.json');

/** OBS's connection: where obs-websocket listens, and its password. */
export interface ObsCredentials {
  host?: string;
  port?: number;
  password?: string;
}

/**
 * VTube Studio's connection: the port its API listens on, and the token it
 * gave Deckhand when the person allowed it in VTS's own window.
 */
export interface VtsCredentials {
  port?: number;
  token?: string;
}

/**
 * Twitch's link: the account, what it allowed, and the tokens Twitch gave —
 * with the client ID they were given to, since a token refreshes only with
 * that one (config.json's twitch.clientId changes the next link, never this
 * one). The refresh token is single-use: every refresh replaces it, and
 * **sending a replaced one makes Twitch end the whole link** (Twitch session
 * 1, measured) — so each new pair is written here before anything uses it.
 */
export interface TwitchCredentials {
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
  refreshToken: string;
  accessToken?: string;
  /** When the access token lapses, in ms since the epoch; from Twitch's expires_in, which varies (3.7–4.3 h measured). */
  expiresAt?: number;
}

interface CredentialsFile {
  obs?: ObsCredentials;
  vts?: VtsCredentials;
  twitch?: TwitchCredentials;
}

type Section = keyof CredentialsFile;

/** The changes waiting their turn: each starts once the one before it has finished, whether it worked or not. */
let queue: Promise<unknown> = Promise.resolve();

/** Run one read-change-write of the file after every change asked for before it. */
function exclusively<T>(change: () => Promise<T>): Promise<T> {
  const run = queue.then(change, change);
  queue = run.catch(() => undefined);
  return run;
}

/** One service's entry as stored, or null when there is none (or it is not an object). */
async function readSection(name: Section): Promise<Record<string, unknown> | null> {
  const entry = (await readFile())[name];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
}

/** Change one service's entry: each field given replaces the stored one; null or "" removes it. Creates the entry if need be. */
function changeSection(name: Section, change: Record<string, unknown>): Promise<void> {
  return exclusively(async () => {
    const file = await readFile();
    const entry: Record<string, unknown> = { ...((file[name] as Record<string, unknown> | undefined) ?? {}) };
    for (const [key, value] of Object.entries(change)) {
      if (value === null || value === '') delete entry[key];
      else entry[key] = value;
    }
    await writeFile({ ...file, [name]: entry });
  });
}

/** Remove one service's entry entirely. Nothing else in the file is touched. */
function removeSection(name: Section): Promise<void> {
  return exclusively(async () => {
    const file = await readFile();
    if (!(name in file)) return;
    const next = { ...file };
    delete next[name];
    await writeFile(next);
  });
}

const stringField = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const portField = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

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

/**
 * OBS's saved connection, or null when **OBS is not set up**: no entry at all.
 * Settings always saves host and port, so an OBS with authentication off is
 * set up too — set up means saved, not "has a password" and not "has
 * connected once". A file that cannot be
 * read or parsed throws: a broken file is not "not set up".
 */
export async function obsCredentials(): Promise<ObsCredentials | null> {
  const obs = await readSection('obs');
  if (!obs) return null;
  return { host: stringField(obs.host), port: portField(obs.port), password: stringField(obs.password) };
}

/**
 * Change OBS's credentials: each field given replaces the stored one, and an
 * empty string or null removes it. Written 0600, by temp file and rename, so
 * a reader never sees half a file and the secret is never on disk with wider
 * permissions, even for a moment.
 */
export async function setObsCredentials(change: { host?: string | null; port?: number | null; password?: string | null }): Promise<void> {
  // An entry with nothing in it is still an entry: OBS stays set up, on the
  // defaults, until removeObsCredentials.
  await changeSection('obs', change);
}

/** Remove OBS's saved connection entirely: OBS is no longer set up. Nothing else in the file is touched. */
export async function removeObsCredentials(): Promise<void> {
  await removeSection('obs');
}

/**
 * VTube Studio's saved connection, or null when **VTube Studio is not set
 * up**: no token. The token is saved only when the person allows Deckhand in
 * VTS's window (services/vts.ts), and the port with it, so set up means a
 * saved token. A token VTS has since revoked still counts as set up — the
 * connection is refused, as a wrong OBS password is. A file that
 * cannot be read or parsed throws.
 */
export async function vtsCredentials(): Promise<VtsCredentials | null> {
  const vts = await readSection('vts');
  const token = stringField(vts?.token);
  if (!vts || !token) return null;
  return { port: portField(vts.port), token };
}

/** Save VTube Studio's port and token together: what an approval in VTS's window gives. Written as OBS's are. */
export async function setVtsCredentials(saved: { port: number; token: string }): Promise<void> {
  await changeSection('vts', saved);
}

/** Remove VTube Studio's saved connection: VTS is no longer set up. Nothing else in the file is touched. */
export async function removeVtsCredentials(): Promise<void> {
  await removeSection('vts');
}

/**
 * Twitch's saved link, or null when **Twitch is not set up**: no refresh
 * token, user or client ID. Set up means linked — not "has an access token",
 * which lapses every few hours, and not "the last request worked". A link
 * Twitch refuses still counts as set up, and is kept. A file that cannot be
 * read or parsed throws.
 */
export async function twitchCredentials(): Promise<TwitchCredentials | null> {
  const twitch = await readSection('twitch');
  const clientId = stringField(twitch?.clientId);
  const userId = stringField(twitch?.userId);
  const refreshToken = stringField(twitch?.refreshToken);
  if (!twitch || !clientId || !userId || !refreshToken) return null;
  const scopes = Array.isArray(twitch.scopes) ? twitch.scopes.filter((v): v is string => typeof v === 'string') : [];
  const expiresAt = typeof twitch.expiresAt === 'number' && Number.isFinite(twitch.expiresAt) ? twitch.expiresAt : undefined;
  return { clientId, userId, login: stringField(twitch.login) ?? '', scopes, refreshToken, accessToken: stringField(twitch.accessToken), expiresAt };
}

/** Save Twitch's link whole — a new link, or a refresh's new pair: the entry is replaced, not merged. Written as OBS's are. */
export function setTwitchCredentials(link: TwitchCredentials): Promise<void> {
  // One write: a crash between two would lose the link, and its tokens with it.
  return exclusively(async () => writeFile({ ...(await readFile()), twitch: { ...link } }));
}

/** Remove Twitch's saved link: Twitch is no longer set up. Nothing else in the file is touched. */
export async function removeTwitchCredentials(): Promise<void> {
  await removeSection('twitch');
}

/** Numbers each write's temp file, so no two writes ever share one. */
let writes = 0;

/** Only through exclusively(): the whole file, by a temp file of this write's own, flushed to disk, then renamed over it. */
async function writeFile(next: CredentialsFile): Promise<void> {
  // Created owner-only if it is not there yet; an existing state directory is
  // left as it is — it holds the backups and the editor's state too, and the
  // file's own 0600 is what keeps the secret.
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${CREDENTIALS_PATH}.${process.pid}.${++writes}.tmp`;
  try {
    // 'wx': created now, 0600 from its first byte, and never a file already
    // there (a leftover, or a link someone put in its place).
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n');
      // On disk before the rename: after a power cut the file is the old one
      // or the new one, never an empty one — a refresh's new token included.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, CREDENTIALS_PATH);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}
