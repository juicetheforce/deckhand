/**
 * Whether a newer Deckhand has been released: what Settings › About shows.
 * Pure, so main, the settings window and the tests share one reading.
 *
 * The editor — not the daemon — asks GitHub for the latest release once each
 * time its window opens, while "Check for updates" is on (main/updates.ts).
 * It never downloads or installs anything: it says a newer version exists and
 * links to that release's page, whose notes carry the update command.
 */

/** What About shows. */
export interface UpdateState {
  /** "Check for updates", in About: on unless the person turned it off. */
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
}

export const NO_UPDATE_STATE: UpdateState = { enabled: true, status: 'idle', latest: null, url: null };

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
export function releaseFrom(answer: unknown): { version: string; url: string } | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const { tag_name: tag, html_url: url } = answer as Record<string, unknown>;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) return null;
  if (url !== `${RELEASE_PAGE}${tag}`) return null;
  return { version: tag, url };
}
