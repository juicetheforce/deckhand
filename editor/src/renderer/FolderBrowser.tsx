import { useEffect, useState } from 'react';
import type { IconFolderEntry, IconFolderListing, IconSearchMatch } from '../shared/bridge.js';
import { MAX_BOOKMARKS } from '../shared/bridge.js';
import { BUILTIN_FOLDER } from '../shared/icons.js';
import { bookmarkLabel, elideCrumbs, folderCrumbs } from './picker-model.js';

/**
 * The folder browsing the icon picker and the sound picker share (Play
 * sound's file, which "works like the icon picker" — Ryan, 2026-10-22): where
 * it opens, back and forward, the path field, the bookmarks — one row for
 * both — and the filter that searches below the open folder. Each picker
 * draws its own files under it. Files are kept where they are and stored by
 * path; nothing is copied.
 */

/**
 * Where a picker is: kept by the inspector across keys, so assigning icons
 * to key after key stays in one folder. `past` and `future` are what the back
 * and forward buttons walk.
 */
export interface PickerPlace {
  folder: string | null;
  query: string;
  past: string[];
  future: string[];
}

export const EMPTY_PLACE: PickerPlace = { folder: null, query: '', past: [], future: [] };

export type BrowseKind = 'icon' | 'sound';

export interface FolderBrowser {
  kind: BrowseKind;
  folder: string | null;
  query: string;
  setQuery: (query: string) => void;
  listing: IconFolderListing | null;
  listError: string | null;
  /** The filter's matches, below the open folder; null with no filter. */
  search: { matches: IconSearchMatch[]; truncated: boolean } | null;
  searching: boolean;
  searchError: string | null;
  bookmarks: IconFolderEntry[];
  setBookmarks: (bookmarks: IconFolderEntry[]) => void;
  pathExpanded: boolean;
  setPathExpanded: (expanded: boolean) => void;
  openFolder: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  refresh: () => void;
}

/**
 * The browsing state of a picker. `current` is the file chosen now (its
 * folder is where the picker opens); `onNavigate` is told of every move to
 * another folder, so the picker can drop its cursor.
 */
export function useFolderBrowser(kind: BrowseKind, current: string | null, place: PickerPlace, onPlace: (place: PickerPlace) => void, onNavigate: () => void = () => undefined): FolderBrowser {
  const { folder, query } = place;
  const [listing, setListing] = useState<IconFolderListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState<{ matches: IconSearchMatch[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<IconFolderEntry[]>([]);
  /** Bumped by the ↻ button to read the open folder again. */
  const [refreshToken, setRefreshToken] = useState(0);
  /** The elided middle of a deep path has been opened out; the field scrolls sideways rather than wrapping. */
  const [pathExpanded, setPathExpanded] = useState(false);

  // Open somewhere: for icons, the Built-in section for a built-in; else the
  // chosen file's folder, else the newest bookmark that still exists, then
  // Pictures (Music, for a sound), home.
  useEffect(() => {
    if (folder === null) void window.deckhand.iconStartFolder(current, kind).then((f) => onPlace({ ...place, folder: f, query: '' }));
  }, [folder]);

  useEffect(() => {
    void window.deckhand.bookmarks().then(setBookmarks);
    return () => void window.deckhand.stopIconWatch();
  }, []);

  // List the open folder, and again whenever main reports it changed on disk.
  useEffect(() => {
    if (folder === null) return;
    let alive = true;
    const load = () =>
      void window.deckhand.listIconFolder(folder, kind).then((result) => {
        if (!alive) return;
        setListing(result.ok ? result.listing : null);
        setListError(result.ok ? null : result.error);
      });
    load();
    const stop = window.deckhand.onIconFolderChanged((changed) => changed === folder && load());
    return () => {
      alive = false;
      stop();
    };
  }, [folder, refreshToken]);

  // The filter searches the whole tree below the open folder, 200 ms after typing pauses.
  useEffect(() => {
    if (folder === null || query.trim() === '') {
      setSearch(null);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.deckhand.searchIcons(folder, query, kind).then((result) => {
        if (!alive) return;
        if (result.ok) {
          setSearch({ matches: result.matches, truncated: result.truncated });
          setSearchError(null);
          setSearching(false);
        } else if (!('superseded' in result)) {
          setSearch({ matches: [], truncated: false });
          setSearchError(result.error);
          setSearching(false);
        }
      });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [folder, query]);

  const moved = () => {
    onNavigate();
    setPathExpanded(false);
  };

  return {
    kind,
    folder,
    query,
    setQuery: (q) => onPlace({ ...place, query: q }),
    listing,
    listError,
    search,
    searching,
    searchError,
    bookmarks,
    setBookmarks,
    pathExpanded,
    setPathExpanded,
    openFolder: (path) => {
      if (path === folder) return;
      moved();
      onPlace({ folder: path, query: '', past: folder === null ? place.past : [...place.past, folder], future: [] });
    },
    goBack: () => {
      const previous = place.past.at(-1);
      if (previous === undefined || folder === null) return;
      moved();
      onPlace({ folder: previous, query: '', past: place.past.slice(0, -1), future: [folder, ...place.future] });
    },
    goForward: () => {
      const [next, ...rest] = place.future;
      if (next === undefined || folder === null) return;
      moved();
      onPlace({ folder: next, query: '', past: [...place.past, folder], future: rest });
    },
    canGoBack: place.past.length > 0,
    canGoForward: place.future.length > 0,
    refresh: () => setRefreshToken((n) => n + 1),
  };
}

/**
 * The browsing bands above a picker's files, in this order and no more, so
 * the files keep the height:
 *
 *   1. one row: back, forward, up, the path field, refresh;
 *   2. the bookmarks row;
 *   3. the filter.
 *
 * The filter has a field of its own, because it is what makes a tree of
 * hundreds of files usable and a glyph inside another control hides it. The
 * path field is a control rather than a line of text: fixed height, so it
 * cannot wrap — a long path loses its middle, and the ellipsis opens it out.
 */
export function FolderBar({ browser, filterLabel }: { browser: FolderBrowser; filterLabel: string }) {
  const { folder, listing, bookmarks } = browser;
  const crumbs = listing ? folderCrumbs(listing.path, listing.configPath) : [];
  // The field cannot wrap, so a deep path keeps its root and its last two
  // folders until the ellipsis is clicked, which opens the rest out.
  const shown = browser.pathExpanded ? { crumbs, elided: [] } : elideCrumbs(crumbs);
  const bookmarked = folder !== null && bookmarks.some((mark) => mark.path === folder);
  const inBuiltins = folder === BUILTIN_FOLDER;

  return (
    <>
      {/* Band 1: history, the path field, refresh. One row, fixed height. */}
      <div className="picker-bar">
        <button className="picker-nav" disabled={!browser.canGoBack} title="Back" aria-label="Back" onClick={browser.goBack}>
          ←
        </button>
        <button className="picker-nav" disabled={!browser.canGoForward} title="Forward" aria-label="Forward" onClick={browser.goForward}>
          →
        </button>
        <button
          className="picker-nav"
          disabled={listing?.parent === null || listing === null}
          title={listing?.parent === null ? 'Already at the top' : 'Up one folder'}
          aria-label="Up one folder"
          onClick={() => listing?.parent && browser.openFolder(listing.parent)}
        >
          ↑
        </button>

        <div className="picker-path" aria-label="Folder">
          <div className="picker-crumbs">
            {shown.crumbs.map((c, i) => (
              <span className="picker-crumb-part" key={c.path}>
                {i > 0 && <span className="crumb-sep" aria-hidden>›</span>}
                {i === 1 && shown.elided.length > 0 && (
                  <>
                    <button
                      className="crumb-ellipsis"
                      title={`Show ${shown.elided.join(' / ')}`}
                      aria-label={`Show the folders left out: ${shown.elided.join(', ')}`}
                      onClick={() => browser.setPathExpanded(true)}
                    >
                      …
                    </button>
                    <span className="crumb-sep" aria-hidden>›</span>
                  </>
                )}
                <button
                  className={`picker-crumb ${i === shown.crumbs.length - 1 ? 'picker-crumb-here' : ''}`}
                  disabled={i === shown.crumbs.length - 1}
                  title={i === shown.crumbs.length - 1 ? undefined : `Open ${c.label}`}
                  onClick={() => browser.openFolder(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <button className="picker-nav" title="Read this folder again" aria-label="Refresh" onClick={browser.refresh}>
          ↻
        </button>
      </div>

      {/* One row of saved places: bookmarks, not recents, which drift. The same row for icons and sounds. */}
      <div className="picker-bookmarks" aria-label="Bookmarks">
        <span className="picker-bookmarks-label">BOOKMARKS</span>
        {/* Icons only, pinned first: the icons that ship with Deckhand, opened
            like any folder — a label, not a second browser. Saved as
            builtin:<name>, so the choice survives updates. */}
        {browser.kind === 'icon' && (
          <button className={`chip chip-builtin ${inBuiltins ? 'chip-selected' : ''}`} title="The icons that come with Deckhand" onClick={() => browser.openFolder(BUILTIN_FOLDER)}>
            Built-in
          </button>
        )}
        {bookmarks.map((mark) => (
          <button
            key={mark.path}
            className={`chip ${mark.path === folder ? 'chip-selected' : ''} ${mark.missing ? 'chip-missing' : ''}`}
            title={mark.missing ? `${mark.configPath} — not there any more` : mark.configPath}
            onClick={() => browser.openFolder(mark.path)}
          >
            ★ {bookmarkLabel(mark.configPath)}
          </button>
        ))}
        {folder !== null &&
          !inBuiltins &&
          (bookmarked ? (
            <button className="chip chip-add" title="Remove this folder from the bookmarks" onClick={() => void window.deckhand.removeBookmark(folder).then(browser.setBookmarks)}>
              − Remove bookmark
            </button>
          ) : (
            <button
              className="chip chip-add"
              disabled={bookmarks.length >= MAX_BOOKMARKS}
              title={bookmarks.length >= MAX_BOOKMARKS ? `${MAX_BOOKMARKS} bookmarks is the limit` : 'Keep this folder in the row'}
              onClick={() => void window.deckhand.addBookmark(folder).then(browser.setBookmarks)}
            >
              + Bookmark this folder
            </button>
          ))}
      </div>

      {/* Band 3: the filter, full width. */}
      <input
        className="picker-filter"
        aria-label={filterLabel}
        placeholder="Filter this folder and everything below"
        value={browser.query}
        onChange={(e) => browser.setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && browser.setQuery('')}
      />
    </>
  );
}
