import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import type { ButtonDef } from '../../../src/types.js';
import type { IconFolderEntry, IconFolderListing, IconSearchMatch } from '../shared/bridge.js';
import type { IconChoice, ButtonLocation } from '../shared/edits.js';
import { BUILTIN_FOLDER, iconUrl, type PairIconField } from '../shared/icons.js';
import { MAX_BOOKMARKS } from '../shared/bridge.js';
import { bookmarkLabel, elideCrumbs, folderCrumbs, moveCursor, parentFolder, type GridKey } from './picker-model.js';

/**
 * Where the picker is: kept by the inspector across keys, so assigning icons
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

interface Props {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  /**
   * Which icon is being chosen: the key's own (null), or one of its action's
   * state pair, written with setActionIcon.
   */
  slot: PairIconField | null;
  editingBlocked: boolean;
  /** The daemon is connected and this deck is attached, so previews can show. */
  canPreview: boolean;
  place: PickerPlace;
  onPlace: (place: PickerPlace) => void;
}

type Item = { kind: 'folder'; entry: IconFolderEntry } | { kind: 'image'; entry: IconFolderEntry | IconSearchMatch };

const GRID_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * The icon picker, an inspector tab, in five bands and no more, so the grid
 * keeps the height:
 *
 *   1. one row: back, forward, up, the path field, refresh;
 *   2. the bookmarks row;
 *   3. the filter;
 *   4. the grid;
 *   5. the bottom bar: what is shown, and the actions.
 *
 * The filter has a field of its own, because it is what makes a tree of
 * hundreds of icons usable and a glyph inside another control hides it. The
 * path field is a control rather than a line of text: fixed height, so it
 * cannot wrap — a long path loses its middle, and the ellipsis opens it out.
 * Config stores the plain path.
 *
 * **Selecting an icon is choosing it**. It goes on the deck (preview.set,
 * which is also how a file the daemon cannot draw is found out) and is saved
 * at once, so the deck and the grid never disagree. The only action is Clear
 * icon.
 */
export function IconPicker({ at, button, slot, editingBlocked, canPreview, place, onPlace }: Props) {
  const { folder, query } = place;
  // The icon this picker is choosing, as it is stored now.
  const slotValue = slot === null ? undefined : button?.action?.[slot];
  const currentIcon: string | null | undefined = slot === null ? button?.icon : typeof slotValue === 'string' ? slotValue : undefined;
  const [listing, setListing] = useState<IconFolderListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState<{ matches: IconSearchMatch[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [bookmarks, setBookmarks] = useState<IconFolderEntry[]>([]);
  /** Bumped by the ↻ button to read the open folder again. */
  const [refreshToken, setRefreshToken] = useState(0);
  /** The elided middle of a deep path has been opened out; the field scrolls sideways rather than wrapping. */
  const [pathExpanded, setPathExpanded] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  /** Images the deck refused to draw (render_failed): marked, and cannot be chosen. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  /** Images the editor could not show as a thumbnail: drawn with the missing icon. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  /** The newest choice not yet saved. Choices made while one is saving replace each other; only the last is saved. */
  const wanted = useRef<IconChoice | null>(null);
  const saving = useRef(false);
  /** A preview this picker set on the key and has not cleared. */
  const previewing = useRef(false);
  /** The most recent selection, so a slow preview reply for an earlier one does not overwrite the message. */
  const latest = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Open somewhere: the Built-in section for a built-in icon, else the icon's
  // folder, else the newest bookmark that still exists, Pictures, home.
  useEffect(() => {
    if (folder === null) void window.deckhand.iconStartFolder(currentIcon ?? null).then((f) => onPlace({ ...place, folder: f, query: '' }));
  }, [folder]);

  useEffect(() => {
    void window.deckhand.bookmarks().then(setBookmarks);
    return () => {
      // Leaving the key, the page or the tab ends the preview.
      // While a choice is still saving, the save carries on without the
      // picker and clears the preview itself once the daemon has the saved
      // icon (commitIcon in main), so it is left to that. Clearing here would
      // show the key's old icon until the save lands.
      if (!saving.current) {
        if (previewing.current) void window.deckhand.previewClear(at.serial, at.index);
        previewing.current = false;
      }
      void window.deckhand.stopIconWatch();
    };
  }, []);

  // List the open folder, and again whenever main reports it changed on disk.
  useEffect(() => {
    if (folder === null) return;
    let alive = true;
    const load = () =>
      void window.deckhand.listIconFolder(folder).then((result) => {
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
      void window.deckhand.searchIcons(folder, query).then((result) => {
        if (!alive) return;
        if (result.ok) {
          setSearch({ matches: result.matches, truncated: result.truncated });
          setSearching(false);
        } else if (!('superseded' in result)) {
          setSearch({ matches: [], truncated: false });
          setMessage(`Search failed: ${result.error}`);
          setSearching(false);
        }
      });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [folder, query]);

  const items: Item[] = search
    ? search.matches.map((entry) => ({ kind: 'image', entry }))
    : [...(listing?.folders ?? []).map((entry): Item => ({ kind: 'folder', entry })), ...(listing?.images ?? []).map((entry): Item => ({ kind: 'image', entry }))];
  const cursorItem = items.find((i) => i.entry.path === cursor);
  const isCurrent = (entry: IconFolderEntry) => typeof currentIcon === 'string' && (entry.configPath === currentIcon || entry.path === currentIcon);

  const openFolder = (path: string) => {
    if (path === folder) return;
    setCursor(null);
    setPathExpanded(false);
    onPlace({ folder: path, query: '', past: folder === null ? place.past : [...place.past, folder], future: [] });
  };

  const goBack = () => {
    const previous = place.past.at(-1);
    if (previous === undefined || folder === null) return;
    setCursor(null);
    setPathExpanded(false);
    onPlace({ folder: previous, query: '', past: place.past.slice(0, -1), future: [folder, ...place.future] });
  };

  const goForward = () => {
    const [next, ...rest] = place.future;
    if (next === undefined || folder === null) return;
    setCursor(null);
    setPathExpanded(false);
    onPlace({ folder: next, query: '', past: [...place.past, folder], future: rest });
  };

  const bookmarked = folder !== null && bookmarks.some((mark) => mark.path === folder);
  const inBuiltins = folder === BUILTIN_FOLDER;

  /**
   * Save choices one at a time, newest first. A file goes on the deck before it
   * is saved: the deck shows it at once, and a file the daemon refuses to draw
   * (render_failed) is marked and never saved. commitIcon then
   * saves, waits for the daemon's reload and clears the preview, so the key
   * goes straight from the preview to the saved icon.
   *
   * A choice replaced while its preview is in flight is not saved at all, so
   * arrowing through a folder does not write config.json for every icon passed.
   * Carries on if the picker closes mid-save: what was selected was chosen, for
   * the key it was selected on.
   */
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (wanted.current !== null) {
        const choice = wanted.current;
        wanted.current = null;
        if (choice.kind === 'file' && canPreview) {
          // Marked before the request goes out: leaving the key while it is in
          // flight must still clear it. The daemon records a preview as soon as
          // the request arrives, so a clear sent after it always removes it;
          // clearing a key with no preview is harmless.
          previewing.current = true;
          // A state icon is previewed as the key's icon, without the action:
          // the action would draw whichever of its pair matches the state now.
          const previewed = slot === null ? { ...(button ?? {}), icon: choice.path } : { ...(button ?? {}), icon: choice.path, action: undefined, onRelease: undefined };
          const shown = await window.deckhand.previewSet(at.serial, at.index, previewed);
          if (!shown.ok) {
            if (shown.code === 'render_failed') setRefused((s) => new Set(s).add(choice.path));
            if (latest.current === choice.path) {
              const name = choice.path.split('/').pop();
              setMessage(shown.code === 'render_failed' ? `The deck cannot draw ${name}, so it was not chosen.` : `Not shown on the deck: ${shown.error}`);
            }
            if (shown.code === 'render_failed') continue;
          }
          if (wanted.current !== null) continue; // replaced while it was being shown
        }
        const result = await window.deckhand.commitIcon(at, choice, previewing.current ? { serial: at.serial, key: at.index } : null, slot);
        previewing.current = false;
        if (!result.ok) setMessage(result.error);
      }
    } finally {
      saving.current = false;
    }
  };

  const choose = (choice: IconChoice) => {
    if (editingBlocked) return;
    if (choice.kind === 'file' && refused.has(choice.path)) return;
    wanted.current = choice;
    void save();
  };

  const moveTo = (item: Item) => {
    setCursor(item.entry.path);
    latest.current = item.entry.path;
    setMessage(null);
    gridRef.current?.querySelector(`[data-path="${CSS.escape(item.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    // A folder is somewhere to go, not a choice: the key keeps what it has.
    if (item.kind === 'folder') return;
    if (refused.has(item.entry.path)) {
      setMessage(`The deck cannot draw ${item.entry.name}, so it cannot be chosen.`);
      return;
    }
    // Not skipped when it is the key's icon already: picking another and coming
    // back before the first has saved must still end on this one. Saving the
    // icon a key already has writes nothing.
    choose({ kind: 'file', path: item.entry.path });
  };

  const onGridKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      // Selecting an image already chose it; Enter opens a folder.
      event.preventDefault();
      if (cursorItem?.kind === 'folder') openFolder(cursorItem.entry.path);
      return;
    }
    if (!GRID_KEYS.has(event.key)) return;
    event.preventDefault();
    const columns = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length : 1;
    const index = items.findIndex((i) => i.entry.path === cursor);
    const next = items[moveCursor(items.length, columns, index, event.key as GridKey)];
    if (next) moveTo(next);
  };

  const crumbs = listing ? folderCrumbs(listing.path, listing.configPath) : [];
  // The field cannot wrap, so a deep path keeps its root and its last two
  // folders until the ellipsis is clicked, which opens the rest out.
  const shown = pathExpanded ? { crumbs, elided: [] } : elideCrumbs(crumbs);

  return (
    <div className="picker">
      {/* Band 1: history, the path field, refresh. One row, fixed height. */}
      <div className="picker-bar">
        <button className="picker-nav" disabled={place.past.length === 0} title="Back" aria-label="Back" onClick={goBack}>
          ←
        </button>
        <button className="picker-nav" disabled={place.future.length === 0} title="Forward" aria-label="Forward" onClick={goForward}>
          →
        </button>
        <button
          className="picker-nav"
          disabled={listing?.parent === null || listing === null}
          title={listing?.parent === null ? 'Already at the top' : 'Up one folder'}
          aria-label="Up one folder"
          onClick={() => listing?.parent && openFolder(listing.parent)}
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
                      onClick={() => setPathExpanded(true)}
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
                  onClick={() => openFolder(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <button className="picker-nav" title="Read this folder again" aria-label="Refresh" onClick={() => setRefreshToken((n) => n + 1)}>
          ↻
        </button>
      </div>

      {/* One row of saved places: bookmarks, not recents, which drift. */}
      <div className="picker-bookmarks" aria-label="Bookmarks">
        <span className="picker-bookmarks-label">BOOKMARKS</span>
        {/* Pinned first: the icons that ship with Deckhand, opened
            like any folder — a label, not a second browser. Saved as
            builtin:<name>, so the choice survives updates. */}
        <button
          className={`chip chip-builtin ${inBuiltins ? 'chip-selected' : ''}`}
          title="The icons that come with Deckhand"
          onClick={() => openFolder(BUILTIN_FOLDER)}
        >
          Built-in
        </button>
        {bookmarks.map((mark) => (
          <button
            key={mark.path}
            className={`chip ${mark.path === folder ? 'chip-selected' : ''} ${mark.missing ? 'chip-missing' : ''}`}
            title={mark.missing ? `${mark.configPath} — not there any more` : mark.configPath}
            onClick={() => openFolder(mark.path)}
          >
            ★ {bookmarkLabel(mark.configPath)}
          </button>
        ))}
        {folder !== null &&
          !inBuiltins &&
          (bookmarked ? (
            <button className="chip chip-add" title="Remove this folder from the bookmarks" onClick={() => void window.deckhand.removeBookmark(folder).then(setBookmarks)}>
              − Remove bookmark
            </button>
          ) : (
            <button
              className="chip chip-add"
              disabled={bookmarks.length >= MAX_BOOKMARKS}
              title={bookmarks.length >= MAX_BOOKMARKS ? `${MAX_BOOKMARKS} bookmarks is the limit` : 'Keep this folder in the row'}
              onClick={() => void window.deckhand.addBookmark(folder).then(setBookmarks)}
            >
              + Bookmark this folder
            </button>
          ))}
      </div>

      {/* Band 3: the filter, full width. */}
      <input
        className="picker-filter"
        aria-label="Filter icons"
        placeholder="Filter this folder and everything below"
        value={query}
        onChange={(e) => onPlace({ ...place, query: e.target.value })}
        onKeyDown={(e) => e.key === 'Escape' && onPlace({ ...place, query: '' })}
      />

      <div
        className="picker-grid"
        ref={gridRef}
        tabIndex={0}
        role="listbox"
        aria-label="Icons"
        onKeyDown={onGridKey}
      >
        {items.map((item) => {
          const { entry } = item;
          const classes = ['picker-item', `picker-${item.kind}`];
          if (entry.path === cursor) classes.push('picker-item-selected');
          if (item.kind === 'image' && isCurrent(entry)) classes.push('picker-item-current');
          if (refused.has(entry.path)) classes.push('picker-item-refused');
          return (
            <button
              key={entry.path}
              data-path={entry.path}
              className={classes.join(' ')}
              role="option"
              aria-selected={entry.path === cursor}
              title={entry.configPath}
              tabIndex={-1}
              onClick={() => (item.kind === 'folder' ? openFolder(entry.path) : moveTo(item))}
            >
              {item.kind === 'folder' ? (
                <span className="picker-folder-glyph" aria-hidden>
                  ▸
                </span>
              ) : (
                <img
                  className="picker-thumb"
                  src={broken.has(entry.path) ? missingIconUrl : iconUrl(entry.path, entry.stamp)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={() => setBroken((s) => new Set(s).add(entry.path))}
                />
              )}
              <span className="picker-name">{entry.name}</span>
              {/* The count alone: six columns leave no room for the words, so
                  they live in the tooltip. */}
              {item.kind === 'folder' && (
                <span className="picker-count" title={entry.items === 1 ? '1 item' : `${entry.items ?? 0} items`}>
                  {entry.items ?? 0}
                </span>
              )}
              {'folder' in entry && (
                <span
                  className="picker-where"
                  role="link"
                  title={`Open ${parentFolder(entry.configPath)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFolder(parentFolder(entry.path));
                  }}
                >
                  {entry.folder === '' ? '(this folder)' : entry.folder}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Band 5: what is shown, then the actions — below the thing they act on. */}
      <div className="picker-bottom">
        <p className="muted small picker-status">
          {listError
            ? `Cannot open this folder: ${listError}`
            : searching
              ? 'Searching…'
              : search
                ? `${search.matches.length} ${search.matches.length === 1 ? 'match' : 'matches'}${search.truncated ? ' — stopped early; type more' : ''}`
                : listing && inBuiltins
                  ? `${listing.images.length} built-in icons`
                  : listing
                  ? `${listing.folders.length} ${listing.folders.length === 1 ? 'folder' : 'folders'} · ${listing.images.length} ${listing.images.length === 1 ? 'image' : 'images'}`
                  : 'Opening…'}
        </p>
        {message && <p className="field-error">{message}</p>}
        {!canPreview && <p className="muted small">The deck is not connected, so icons are not shown on it while browsing.</p>}
        <div className="button-row picker-actions">
          {/* The one action. It removes the icon path, so the action's built-in
              default renders — it is not "no icon": a deliberately blank,
              label-only key is None on the Key tab, a separate state.
              "Clear icon", not a bare "Clear", beside
              the Key tab's Clear hotkey and Clear button. */}
          {currentIcon !== undefined && (
            <button
              disabled={editingBlocked}
              title={slot === null ? "Remove this key's icon, so its action's default icon is drawn" : 'Remove this state icon, so the key falls back to its own icon or the default'}
              onClick={() => {
                setCursor(null);
                latest.current = null;
                choose({ kind: 'default' });
              }}
            >
              Clear icon
            </button>
          )}
        </div>
      </div>
    </div>
  );
}