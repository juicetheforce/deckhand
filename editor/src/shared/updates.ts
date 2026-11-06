/**
 * Whether a newer Deckhand has been released: what the editor's Update pill and
 * Settings › About show. Pure, so main, both windows and the tests share one reading.
 *
 * The editor — not the daemon — asks GitHub for the latest release once each
 * time its window opens, while "Check for updates" is on (main/updates.ts).
 * It never downloads or installs anything: it says a newer version exists, shows
 * the start of its notes and its update command, and links to its page.
 */

/** What the pill and About show. */
export interface UpdateState {
  /** "Check for updates", in Settings › General: on unless the person turned it off. */
  enabled: boolean;
  /**
   * off: the switch is off, so nothing is asked. idle: nothing asked yet, or
   * nothing to compare with (an editor run from a checkout has no version).
   * checking, current, available, failed: the last check.
   */
  status: 'off' | 'idle' | 'checking' | 'current' | 'available' | 'failed';
  /** The latest release's version and page, when status is available. */
  latest: string | null;
  url: string | null;
  /** The first lines of its notes' What's new section; empty when it has none. */
  whatsNew: string[];
  /** Its own update line, exactly as its notes print it; null if they have none this editor can vouch for. */
  updateLine: string | null;
  /** The version running, for "You have …". */
  installed: string | null;
  /** "Not now" was pressed for this version or a newer one: no pill. About still says. */
  hidden: boolean;
}

export const NO_UPDATE_STATE: UpdateState = { enabled: true, status: 'idle', latest: null, url: null, whatsNew: [], updateLine: null, installed: null, hidden: false };

/** How many lines of What's new the panel shows. */
const WHATS_NEW_LINES = 3;

/** What every release's notes end with (scripts/release.sh): the only command the panel will offer to copy. */
const UPDATE_LINE = /^curl -fsSL https:\/\/github\.com\/juicetheforce\/deckhand\/releases\/[A-Za-z0-9._/-]*install\.sh \| bash$/;

/** A line of notes as plain text: no list mark, no Markdown emphasis or code marks. */
function plainLine(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '').replace(/\*\*|`/g, '').trim();
}

/** The first lines of a release's What's new section, and its update line. */
export function notesFrom(body: unknown): { whatsNew: string[]; updateLine: string | null } {
  if (typeof body !== 'string') return { whatsNew: [], updateLine: null };
  const command = /Install or update: `([^`\n]+)`/.exec(body)?.[1] ?? null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^[#*\s]*What['’]s new[*:\s]*$/i.test(line));
  const whatsNew: string[] = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*Install or update:/.test(line) || /^\s*(#|\*\*[^*]+\*\*\s*$)/.test(line)) break;
      const text = plainLine(line);
      if (text !== '') whatsNew.push(text);
      if (whatsNew.length === WHATS_NEW_LINES) break;
    }
  }
  return { whatsNew, updateLine: command !== null && UPDATE_LINE.test(command) ? command : null };
}

/** The releases a page may link to: this repository's release pages, nothing else. */
const RELEASE_PAGE = 'https://github.com/juicetheforce/deckhand/releases/tag/';

/** A version's three numbers, from a tag ("v0.7.1") or a developer install's `git describe` ("v0.7.0-3-gf2765f2"); null if it has none. */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `latest` is newer than the version installed. A developer install
 * between two releases ("v0.7.0-3-g…") counts as the release it follows, so
 * it is never told to update to that release. No installed version (a
 * checkout), or one that cannot be read: never newer.
 */
export function isNewer(latest: string, installed: string | null): boolean {
  if (installed === null) return false;
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The latest release from GitHub's answer (GET /repos/…/releases/latest):
 * its tag and page, or null if the answer is not one. The page must be this
 * repository's page for that tag — the only URL About will open.
 */
export function releaseFrom(answer: unknown): { version: string; url: string; whatsNew: string[]; updateLine: string | null } | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const { tag_name: tag, html_url: url, body } = answer as Record<string, unknown>;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) return null;
  if (url !== `${RELEASE_PAGE}${tag}`) return null;
  return { version: tag, url, ...notesFrom(body) };
}
