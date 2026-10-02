import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Settings' ABOUT: which Deckhand this is, and where its releases are.
 *
 * **No update check.** Deckhand never asks the network what is newer: a
 * "check for updates" that cannot update would only point at the installer
 * anyway, so the releases page is linked instead, opened in the browser.
 */

/** Where every release and its installer are listed. Fixed here: the page never names a URL to open. */
export const RELEASES_URL = 'https://github.com/juicetheforce/deckhand/releases';

/**
 * `VERSION` in the app directory, written by the installer: a release's tag
 * (`scripts/release.sh`), or `git describe` for a developer install. The
 * installed editor lives in that directory (`<app>/editor/`), and its bundled
 * `dist/main/` is three levels below it — the same reckoning as
 * builtin-icons.ts's checkout path — so this names the build that is
 * running, not whatever was installed since. Null when there is none: an
 * editor run from a checkout. A check may name a file of its own.
 */
export function editorVersion(file: string = path.resolve(import.meta.dirname, '../../../VERSION')): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Open the releases page in the browser with `gio open`: GLib's own opener,
 * which the installer already requires for app keys, and which goes through
 * no portal outside a sandbox. Not Electron's shell.openExternal: this
 * Electron's binary carries the OpenURI portal's name, so it may use it, and
 * Deckhand uses no portal (ARCHITECTURE). Detached, so the browser outlives
 * the editor. A browser that then fails to open is not seen here; the page
 * shows the URL as text to copy.
 *
 * In a check (`checkLog` set) nothing is opened: the URL is appended to that
 * file instead, so a check can see what would have been.
 */
export function openReleases(checkLog: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (checkLog !== null) {
    appendFileSync(checkLog, `${RELEASES_URL}\n`);
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    const child = spawn('gio', ['open', RELEASES_URL], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => resolve({ ok: false, error: `could not open the browser (${err.message}): ${RELEASES_URL}` }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}
