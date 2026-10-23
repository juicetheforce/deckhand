import { useEffect, useState } from 'react';
import type { IconFolderEntry, IconSearchMatch } from '../shared/bridge.js';
import { EMPTY_PLACE, FolderBar, useFolderBrowser, type PickerPlace } from './FolderBrowser.js';
import { parentFolder } from './picker-model.js';

/**
 * Play sound's file picker: the icon picker's browsing — the same folders,
 * path field, bookmarks and filter (FolderBrowser.tsx) — over sound files,
 * one to a row. **Selecting a sound is choosing it**, as with icons: saved at
 * once, by path, the file kept where it is and never copied. **▶ plays it
 * first** without choosing it, through the daemon (`sound.preview`), on the
 * output and at the volume the key has; ■ stops it, and it turns back to ▶
 * when the clip ends, which the daemon's state says.
 */

/** Where the sound picker was, kept across keys, so choosing sounds key after key stays in one folder. */
let lastPlace: PickerPlace = EMPTY_PLACE;

type Row = { kind: 'folder'; entry: IconFolderEntry } | { kind: 'sound'; entry: IconFolderEntry | IconSearchMatch };

export function SoundPicker({
  current,
  output,
  disabled,
  onChoose,
}: {
  /** The key's file as the config has it (`~/…` or absolute), or null. */
  current: string | null;
  /** What a preview plays on, and how loud: the key's own. */
  output: { node?: string; label?: string; volume?: number };
  disabled: boolean;
  /** Save this file, as the config stores it. */
  onChoose: (configPath: string) => void;
}) {
  const [place, setPlaceState] = useState<PickerPlace>(lastPlace);
  const setPlace = (next: PickerPlace) => {
    lastPlace = next;
    setPlaceState(next);
  };
  const browser = useFolderBrowser('sound', current, place, setPlace);
  const { listing, listError, search, searching } = browser;
  /** The clip the daemon is previewing now: its absolute path, from its state. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.deckhand.snapshot().then((s) => setPreviewing(s.daemon.status?.previewingSound ?? null));
    const stop = window.deckhand.onDaemon((view) => setPreviewing(view.status?.previewingSound ?? null));
    return () => {
      stop();
      // Leaving the key or the form ends a preview: it belonged to this picker.
      void window.deckhand.stopSoundPreview();
    };
  }, []);

  const rows: Row[] = search
    ? search.matches.map((entry) => ({ kind: 'sound', entry }))
    : [...(listing?.folders ?? []).map((entry): Row => ({ kind: 'folder', entry })), ...(listing?.images ?? []).map((entry): Row => ({ kind: 'sound', entry }))];
  const isCurrent = (entry: IconFolderEntry) => current !== null && (entry.configPath === current || entry.path === current);

  const play = async (entry: IconFolderEntry) => {
    setMessage(null);
    if (previewing === entry.path) {
      await window.deckhand.stopSoundPreview();
      return;
    }
    const result = await window.deckhand.previewSound({ file: entry.path, ...output });
    if (!result.ok) setMessage(result.code === 'not_connected' ? 'The daemon is not running, so nothing can be played.' : result.error);
  };

  return (
    <div className="picker sound-picker" data-sound-picker>
      <FolderBar browser={browser} filterLabel="Filter sounds" />

      <ul className="sound-list" aria-label="Sounds">
        {rows.map((row) => {
          const { entry } = row;
          if (row.kind === 'folder') {
            return (
              <li key={entry.path}>
                <button className="sound-row sound-folder" title={entry.configPath} data-path={entry.path} onClick={() => browser.openFolder(entry.path)}>
                  <span className="picker-folder-glyph" aria-hidden>
                    ▸
                  </span>
                  <span className="sound-name">{entry.name}</span>
                  <span className="picker-count" title={entry.items === 1 ? '1 item' : `${entry.items ?? 0} items`}>
                    {entry.items ?? 0}
                  </span>
                </button>
              </li>
            );
          }
          const playing = previewing === entry.path;
          return (
            <li key={entry.path} className={isCurrent(entry) ? 'sound-item sound-item-current' : 'sound-item'}>
              <button className={playing ? 'sound-play sound-play-on' : 'sound-play'} aria-label={playing ? `Stop ${entry.name}` : `Play ${entry.name}`} title={playing ? 'Stop' : 'Play it, without choosing it'} data-play={entry.path} onClick={() => void play(entry)}>
                {playing ? '■' : '▶'}
              </button>
              <button className="sound-row" title={entry.configPath} data-path={entry.path} disabled={disabled} onClick={() => onChoose(entry.configPath)}>
                <span className="sound-name">{entry.name}</span>
                {'folder' in entry && (
                  <span
                    className="picker-where"
                    role="link"
                    title={`Open ${parentFolder(entry.configPath)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      browser.openFolder(parentFolder(entry.path));
                    }}
                  >
                    {entry.folder === '' ? '(this folder)' : entry.folder}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="picker-bottom">
        <p className="muted small picker-status">
          {listError
            ? `Cannot open this folder: ${listError}`
            : searching
              ? 'Searching…'
              : search
                ? `${search.matches.length} ${search.matches.length === 1 ? 'match' : 'matches'}${search.truncated ? ' — stopped early; type more' : ''}`
                : listing
                  ? `${listing.folders.length} ${listing.folders.length === 1 ? 'folder' : 'folders'} · ${listing.images.length} ${listing.images.length === 1 ? 'sound' : 'sounds'}`
                  : 'Opening…'}
        </p>
        {browser.searchError && <p className="field-error">Search failed: {browser.searchError}</p>}
        {message && <p className="field-error">{message}</p>}
      </div>
    </div>
  );
}
