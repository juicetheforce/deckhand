import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { backgroundOf } from '../../../src/background-def.js';
import type { PageBackgroundDef } from '../../../src/types.js';
import type { IconFolderEntry, IconSearchMatch } from '../shared/bridge.js';
import { iconUrl } from '../shared/icons.js';
import { EMPTY_PLACE, FolderBar, useFolderBrowser, type PickerPlace } from './FolderBrowser.js';
import { checkImage, useImageCheck } from './image-check.js';
import { Slider } from './settings-ui.js';

/** Board 27a's colours, black first: the background starts black (Ryan, 2026-11-17). */
export const BACKGROUND_SWATCHES = ['#000000', '#1d2a4a', '#131628', '#2b2350', '#3b1f3a', '#4a1f2b', '#4a2f17', '#3d3a16', '#17382c', '#103840', '#0b0c12', '#2a2d3e'];

/** The one line below 100% (24b), as decided. */
export const SEE_THROUGH_LINE = 'Whatever is on that screen behind the deck shows through, and can’t be touched.';

interface Props {
  /** Where it opens: under the header's background icon, in window coordinates. */
  anchor: DOMRect;
  /** The page it belongs to, named at its top right (24b). */
  pageName: string;
  background: PageBackgroundDef | undefined;
  iconStamps: Record<string, string>;
  /** The deck's screen is GNOME's full-screen window, not a layer-shell surface (control/protocol.ts `surface`). */
  fullscreenWindow: boolean;
  disabled: boolean;
  /** Drawn on the page while the opacity is moved, until the saved change comes back as a new config (App). */
  onPreview: (background: PageBackgroundDef | null) => void;
  /** Saved: the whole background, or null for plain black and opaque, as the page had before. */
  onChange: (background: PageBackgroundDef | null) => void;
  onClose: () => void;
}

/** The background as stored: only what differs from black, Fill and 100%; null when nothing does. */
function stored(b: { color: string; image: string | null; fit: 'fill' | 'fit'; opacity: number }): PageBackgroundDef | null {
  const out: PageBackgroundDef = {};
  if (b.color.toLowerCase() !== '#000000') out.color = b.color.toLowerCase();
  if (b.image !== null) out.image = b.image;
  if (b.image !== null && b.fit === 'fit') out.fit = 'fit';
  if (b.opacity !== 100) out.opacity = b.opacity;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * A page's background (24a, 24b): opened from the background icon on a virtual
 * deck's header, for the page that is showing, which it names. A colour, an
 * optional image as Fill or Fit, and one opacity for the whole layer, 0–100%
 * in steps of 5. Below 100%, one line says that what is behind the deck
 * shows through and cannot be touched. Esc, or a click outside it, closes it.
 * Every change is saved at once, as every other edit is.
 */
export function BackgroundPanel({ anchor, pageName, background, iconStamps, fullscreenWindow, disabled, onPreview, onChange, onClose }: Props) {
  const b = backgroundOf(background);
  const panel = useRef<HTMLDivElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [hex, setHex] = useState(b.color);
  const [swatches, setSwatches] = useState(false);
  const verdict = useImageCheck(b.image, b.image ? iconStamps[b.image] : undefined);
  useEffect(() => setHex(b.color), [b.color]);

  // Esc or a click outside closes it — not while the image chooser is open over it.
  useEffect(() => {
    if (choosing) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && (panel.current?.contains(target) || target.closest('[data-background-icon]'))) return;
      onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [choosing, onClose]);

  // Under the icon, right edges together; kept inside the window.
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: anchor.right, top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width));
    const below = anchor.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below;
    setPlace({ left, top });
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom]);

  const save = (patch: Partial<typeof b>) => onChange(stored({ ...b, ...patch }));
  const typedHex = (text: string) => {
    setHex(text);
    const value = text.startsWith('#') ? text : `#${text}`;
    if (/^#[0-9a-fA-F]{6}$/.test(value)) save({ color: value.toLowerCase() });
  };

  return createPortal(
    <>
      <div
        ref={panel}
        className="background-panel glass"
        role="dialog"
        aria-label={`Background of ${pageName}`}
        data-background-panel={pageName}
        style={{ left: place.left, top: place.top }}
      >
        <div className="background-panel-head">
          <span className="background-panel-title">Background</span>
          <span className="background-panel-page" title="Every page has its own background">
            {pageName}
          </span>
        </div>

        <div className="background-row">
          <span className="background-label">Colour</span>
          <button
            className="background-swatch"
            style={{ background: b.color }}
            aria-label="Choose a colour"
            aria-expanded={swatches}
            disabled={disabled}
            onClick={() => setSwatches((open) => !open)}
            data-background-swatch=""
          />
          <input
            className="background-hex"
            aria-label="Hex"
            value={hex}
            spellCheck={false}
            maxLength={7}
            disabled={disabled}
            onChange={(e) => typedHex(e.target.value.trim())}
            onBlur={() => setHex(b.color)}
            data-background-hex=""
          />
        </div>
        {swatches && (
          <div className="background-swatches" role="listbox" aria-label="Colours">
            {BACKGROUND_SWATCHES.map((c) => (
              <button
                key={c}
                role="option"
                aria-selected={c === b.color.toLowerCase()}
                className={c === b.color.toLowerCase() ? 'background-chip background-chip-current' : 'background-chip'}
                style={{ background: c }}
                title={c}
                disabled={disabled}
                onClick={() => save({ color: c })}
                data-background-chip={c}
              />
            ))}
          </div>
        )}

        <div className="background-row">
          <span className="background-label">Image</span>
          {b.image === null ? (
            <button className="background-choose" disabled={disabled} onClick={() => setChoosing(true)} data-background-choose="">
              Choose image…
            </button>
          ) : (
            <>
              <button className="background-file" disabled={disabled} onClick={() => setChoosing(true)} title={b.image} data-background-file="">
                {b.image.split('/').pop()}
              </button>
              <button className="background-remove" aria-label="Remove the image" title="Remove the image" disabled={disabled} onClick={() => save({ image: null, fit: 'fill' })} data-background-remove="">
                ✕
              </button>
            </>
          )}
        </div>
        {b.image !== null && verdict?.state === 'refused' && (
          <p className="background-refused" data-background-refused="">
            {verdict.message} The colour is shown instead.
          </p>
        )}
        {b.image !== null && (
          <div className="background-row">
            <span className="background-label" />
            <div className="background-fit" role="radiogroup" aria-label="Image fit">
              {(['fill', 'fit'] as const).map((fit) => (
                <button
                  key={fit}
                  role="radio"
                  aria-checked={b.fit === fit}
                  className={b.fit === fit ? 'background-fit-on' : undefined}
                  disabled={disabled}
                  title={fit === 'fill' ? 'Covers the screen; the image is cropped' : 'The whole image; the colour fills what is left'}
                  onClick={() => save({ fit })}
                  data-background-fit={fit}
                >
                  {fit === 'fill' ? 'Fill' : 'Fit'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="background-row background-opacity" data-background-opacity={b.opacity}>
          <span className="background-label">Opacity</span>
          <Slider
            label="Opacity"
            value={b.opacity}
            min={0}
            max={100}
            step={5}
            unit="%"
            disabled={disabled}
            onPreview={(opacity) => onPreview(stored({ ...b, opacity }) ?? {})}
            onCommit={(opacity) => save({ opacity })}
          />
        </div>
        {b.opacity < 100 && (
          <p className="background-see-through muted small" data-background-line="">
            {SEE_THROUGH_LINE}
            {fullscreenWindow && (
              <span className="background-gnome" data-background-gnome="">
                {' '}
                This desktop shows the deck as a full-screen window, which may not let anything show through.
              </span>
            )}
          </p>
        )}
      </div>
      {choosing && (
        <ImageChooser
          current={b.image}
          iconStamps={iconStamps}
          onChoose={(image) => {
            setChoosing(false);
            save({ image });
          }}
          onCancel={() => setChoosing(false)}
        />
      )}
    </>,
    document.body,
  );
}

type Item = { kind: 'folder'; entry: IconFolderEntry } | { kind: 'image'; entry: IconFolderEntry | IconSearchMatch };

/**
 * Choosing a background image, picked like an icon (24b): the icon picker's
 * folder browser — path, bookmarks, filter — and a grid of images. An image
 * the limits refuse is dimmed, its reason on one line under the grid, and
 * cannot be chosen (25c); built-in icons are not offered. A path is stored as
 * an icon's is, the file never copied.
 */
function ImageChooser({ current, iconStamps, onChoose, onCancel }: { current: string | null; iconStamps: Record<string, string>; onChoose: (path: string) => void; onCancel: () => void }) {
  const [place, setPlace] = useState<PickerPlace>(EMPTY_PLACE);
  const browser = useFolderBrowser('icon', current, place, setPlace, () => setMessage(null));
  const { listing, search, listError, searching } = browser;
  const [message, setMessage] = useState<string | null>(null);
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onCancel]);

  const items: Item[] = (
    search
      ? search.matches.map((entry): Item => ({ kind: 'image', entry }))
      : [...(listing?.folders ?? []).map((entry): Item => ({ kind: 'folder', entry })), ...(listing?.images ?? []).map((entry): Item => ({ kind: 'image', entry }))]
  ).filter((item) => !item.entry.configPath.startsWith('builtin:'));

  const pick = async (entry: IconFolderEntry | IconSearchMatch) => {
    if (refused.has(entry.path)) return;
    setChecking(entry.path);
    const verdict = await checkImage(entry.configPath, iconStamps[entry.configPath]);
    setChecking(null);
    if (verdict.state === 'refused') {
      setRefused((s) => new Set(s).add(entry.path));
      setMessage(verdict.message);
      return;
    }
    onChoose(entry.configPath);
  };

  return createPortal(
    <div className="image-chooser-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="image-chooser glass" role="dialog" aria-label="Choose a background image" data-image-chooser="">
        <div className="picker">
          <FolderBar browser={browser} filterLabel="Filter images" />
          <div className="picker-grid" role="listbox" aria-label="Images">
            {items.map((item) => {
              const { entry } = item;
              const classes = ['picker-item', `picker-${item.kind}`];
              if (refused.has(entry.path)) classes.push('picker-item-refused');
              if (current !== null && entry.configPath === current) classes.push('picker-item-current');
              return (
                <button
                  key={entry.path}
                  className={classes.join(' ')}
                  role="option"
                  aria-selected={false}
                  aria-busy={checking === entry.path}
                  title={entry.configPath}
                  data-path={entry.path}
                  onClick={() => (item.kind === 'folder' ? browser.openFolder(entry.path) : void pick(entry))}
                >
                  {item.kind === 'folder' ? (
                    <span className="picker-folder-glyph" aria-hidden>
                      ▸
                    </span>
                  ) : (
                    <img className="picker-thumb" src={iconUrl(entry.path, entry.stamp)} alt="" loading="lazy" decoding="async" draggable={false} />
                  )}
                  <span className="picker-name">{entry.name}</span>
                </button>
              );
            })}
          </div>
          <div className="picker-bottom">
            <p className={message ? 'small picker-status image-chooser-refused' : 'muted small picker-status'} data-image-chooser-message="">
              {message ??
                (listError
                  ? `Cannot open this folder: ${listError}`
                  : searching
                    ? 'Searching…'
                    : 'PNG, JPEG, WebP, GIF or SVG, up to 10 MB and 4096 px on the longer side.')}
            </p>
            <div className="picker-actions">
              <button onClick={onCancel}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
