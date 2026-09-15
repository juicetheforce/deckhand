import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import type { ButtonDef } from '../../../src/types.js';
import type { IconFolderEntry, IconFolderListing, IconSearchMatch } from '../shared/bridge.js';
import type { ButtonLocation } from '../shared/edits.js';
import { iconUrl } from '../shared/icons.js';
import { folderCrumbs, moveCursor, parentFolder, type GridKey } from './picker-model.js';

/** Where the picker is: kept by the inspector across keys, so assigning icons to key after key stays in one folder. */
export interface PickerPlace {
  folder: string | null;
  query: string;
}

interface Props {
  at: ButtonLocation;
  button: ButtonDef | undefined;
  editingBlocked: boolean;
  /** The daemon is connected and this deck is attached, so previews can show. */
  canPreview: boolean;
  place: PickerPlace;
  onPlace: (place: PickerPlace) => void;
}

type Item = { kind: 'folder'; entry: IconFolderEntry } | { kind: 'image'; entry: IconFolderEntry | IconSearchMatch };

const GRID_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * The icon picker, an inspector tab (scope §10). Browse a folder tree, filter
 * the whole tree below the open folder, jump to recent folders. Selecting an
 * image shows it on the deck (preview.set); choosing it — Use this icon,
 * double-click, or Enter — saves it. The preview ends when the icon is
 * chosen, another key or page is selected, the tab is left, or the editor
 * closes. Config stores the plain path (scope §3).
 */
export function IconPicker({ at, button, editingBlocked, canPreview, place, onPlace }: Props) {
  const { folder, query } = place;
  const [listing, setListing] = useState<IconFolderListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState<{ matches: IconSearchMatch[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<IconFolderEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /** Images the deck refused to draw (render_failed): marked, and cannot be chosen. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  /** Images the editor could not show as a thumbnail: drawn with the missing icon. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A preview this picker set on the key and has not cleared. */
  const previewing = useRef(false);
  /** The most recent selection, so a slow preview reply for an earlier one does not overwrite the message. */
  const latest = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Open somewhere: the key's icon's folder, a recent folder, Pictures, home.
  useEffect(() => {
    if (folder === null) void window.deckhand.iconStartFolder(button?.icon ?? null).then((f) => onPlace({ folder: f, query: '' }));
  }, [folder]);

  useEffect(() => {
    void window.deckhand.recentIconFolders().then(setRecent);
    return () => {
      // Leaving the key, the page or the tab ends the preview (scope §10).
      if (previewing.current) void window.deckhand.previewClear(at.serial, at.index);
      previewing.current = false;
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
  }, [folder]);

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
  const selectedImage = cursorItem?.kind === 'image' ? cursorItem.entry : null;
  const isCurrent = (entry: IconFolderEntry) => button?.icon !== undefined && (entry.configPath === button.icon || entry.path === button.icon);

  const openFolder = (path: string) => {
    setCursor(null);
    onPlace({ folder: path, query: '' });
  };

  const moveTo = async (item: Item) => {
    setCursor(item.entry.path);
    latest.current = item.entry.path;
    setMessage(null);
    gridRef.current?.querySelector(`[data-path="${CSS.escape(item.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    if (item.kind === 'folder') {
      if (previewing.current) void window.deckhand.previewClear(at.serial, at.index);
      previewing.current = false;
      return;
    }
    if (!canPreview) return;
    // Marked before the request goes out: leaving the key while it is in flight
    // must still clear it. The daemon records a preview as soon as the request
    // arrives, so a clear sent after it always removes it; clearing a key with
    // no preview is harmless. (A check that left mid-flight found this.)
    previewing.current = true;
    const result = await window.deckhand.previewSet(at.serial, at.index, { ...(button ?? {}), icon: item.entry.path });
    if (result.ok) return;
    if (result.code === 'render_failed') setRefused((s) => new Set(s).add(item.entry.path));
    if (latest.current !== item.entry.path) return;
    setMessage(result.code === 'render_failed' ? `The deck cannot draw ${item.entry.name}.` : `Not shown on the deck: ${result.error}`);
  };

  const commit = async (path: string | null) => {
    if (editingBlocked || busy || (path !== null && refused.has(path))) return;
    setBusy(true);
    const result = await window.deckhand.commitIcon(at, path, previewing.current ? { serial: at.serial, key: at.index } : null);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    previewing.current = false;
    setMessage(null);
    void window.deckhand.recentIconFolders().then(setRecent);
  };

  const activate = (item: Item) => (item.kind === 'folder' ? openFolder(item.entry.path) : void commit(item.entry.path));

  const onGridKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (cursorItem) activate(cursorItem);
      return;
    }
    if (!GRID_KEYS.has(event.key)) return;
    event.preventDefault();
    const columns = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length : 1;
    const index = items.findIndex((i) => i.entry.path === cursor);
    const next = items[moveCursor(items.length, columns, index, event.key as GridKey)];
    if (next) void moveTo(next);
  };

  const crumbs = listing ? folderCrumbs(listing.path, listing.configPath) : [];

  return (
    <div className="picker">
      {recent.length > 0 && (
        <div className="picker-recent" aria-label="Recent folders">
          {recent.map((r) => (
            <button key={r.path} className={`chip ${r.path === folder ? 'chip-selected' : ''}`} title={r.configPath} onClick={() => openFolder(r.path)}>
              {r.name}
            </button>
          ))}
        </div>
      )}

      <div className="picker-crumbs" aria-label="Folder">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="crumb-sep">/</span>}
            <button className="picker-crumb" disabled={i === crumbs.length - 1 && !search} onClick={() => openFolder(c.path)}>
              {c.label}
            </button>
          </span>
        ))}
        <button
          className="picker-change"
          onClick={() =>
            void window.deckhand.chooseIconFolder(folder).then((picked) => {
              if (picked) openFolder(picked);
            })
          }
        >
          Change folder…
        </button>
      </div>

      <input
        className="picker-filter"
        aria-label="Filter icons"
        placeholder="Filter this folder and everything below"
        value={query}
        onChange={(e) => onPlace({ folder, query: e.target.value })}
        onKeyDown={(e) => e.key === 'Escape' && onPlace({ folder, query: '' })}
      />

      <p className="muted small picker-status">
        {listError
          ? `Cannot open this folder: ${listError}`
          : searching
            ? 'Searching…'
            : search
              ? `${search.matches.length} ${search.matches.length === 1 ? 'match' : 'matches'}${search.truncated ? ' — stopped early; type more to narrow it' : ''}`
              : listing
                ? `${listing.folders.length} ${listing.folders.length === 1 ? 'folder' : 'folders'} · ${listing.images.length} ${listing.images.length === 1 ? 'image' : 'images'}`
                : 'Opening…'}
      </p>

      <div className="button-row picker-actions">
        <button
          className="primary"
          disabled={editingBlocked || busy || !selectedImage || refused.has(selectedImage.path) || isCurrent(selectedImage)}
          onClick={() => selectedImage && void commit(selectedImage.path)}
        >
          Use this icon
        </button>
        {button?.icon !== undefined && (
          <button disabled={editingBlocked || busy} onClick={() => void commit(null)}>
            Remove icon
          </button>
        )}
      </div>
      {message && <p className="field-error">{message}</p>}
      {!canPreview && <p className="muted small">The deck is not connected, so icons are not shown on it while browsing.</p>}

      <div className="picker-grid" ref={gridRef} tabIndex={0} role="listbox" aria-label="Icons" onKeyDown={onGridKey}>
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
              onClick={() => (item.kind === 'folder' ? openFolder(entry.path) : void moveTo(item))}
              onDoubleClick={() => item.kind === 'image' && void commit(entry.path)}
            >
              {item.kind === 'folder' ? (
                <span className="picker-folder-glyph" aria-hidden>
                  ▸
                </span>
              ) : (
                <img
                  className="picker-thumb"
                  src={broken.has(entry.path) ? missingIconUrl : iconUrl(entry.path)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={() => setBroken((s) => new Set(s).add(entry.path))}
                />
              )}
              <span className="picker-name">{entry.name}</span>
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
    </div>
  );
}
