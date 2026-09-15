import { useState, type CSSProperties } from 'react';
import missingIconUrl from '../../../assets/icons/missing.svg';
import type { ButtonDef, Config, PageDef } from '../../../src/types.js';
import { iconUrl } from '../shared/icons.js';
import { actionName } from './catalogue.js';
import { describeAction, keyFace, keyKind, type DeckGeometryWithSerial } from './model.js';

interface Props {
  config: Config;
  geometry: DeckGeometryWithSerial;
  page: PageDef;
  /** Icon path → its file's stamp (src/main/icon-files.ts), so a changed file is fetched again. */
  iconStamps: Record<string, string>;
  selectedKey: number | null;
  onSelectKey: (index: number) => void;
}

/**
 * The page's keys, laid out from the daemon's geometry: each key at the row
 * and column the deck reports, never an assumed row-major order (scope §7,
 * "decks"). Key faces are a CSS approximation; the deck is the truth (§10).
 */
export function DeckGrid({ config, geometry, page, iconStamps, selectedKey, onSelectKey }: Props) {
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${geometry.rows}, auto)`,
    // Keys keep roughly the deck's proportions whatever the column count.
    maxWidth: `calc(${geometry.columns} * 104px)`,
  };

  return (
    <div className="grid" style={gridStyle}>
      {geometry.keys.map((k) => (
        <Key
          key={k.index}
          config={config}
          index={k.index}
          row={k.row}
          column={k.column}
          hasScreen={k.feedback === 'lcd'}
          iconSize={geometry.iconSize}
          button={page.buttons[String(k.index)]}
          iconStamps={iconStamps}
          selected={selectedKey === k.index}
          onSelect={() => onSelectKey(k.index)}
        />
      ))}
    </div>
  );
}

interface KeyProps {
  config: Config;
  index: number;
  row: number;
  column: number;
  hasScreen: boolean;
  iconSize: number | null;
  button: ButtonDef | undefined;
  iconStamps: Record<string, string>;
  selected: boolean;
  onSelect: () => void;
}

function Key({ config, index, row, column, hasScreen, iconSize, button, iconStamps, selected, onSelect }: KeyProps) {
  const kind = keyKind(button);
  const face = keyFace(config, button, iconSize);
  const stamp = face.icon === null ? undefined : iconStamps[face.icon];
  // Which icon failed to load, by path and stamp, so a changed path — or the
  // same path whose file changed — is tried again.
  const [missingIcon, setMissingIcon] = useState<string | null>(null);
  const iconId = face.icon === null ? null : `${face.icon}|${stamp ?? ''}`;
  const iconMissing = iconId !== null && missingIcon === iconId;
  const classes = ['key', `key-${kind}`, selected ? 'key-selected' : '', hasScreen ? '' : 'key-no-screen'].filter(Boolean).join(' ');
  const title = kind === 'empty' ? `Key ${index + 1}: empty` : `Key ${index + 1}: ${describeAction(button)}`;

  return (
    <button
      className={classes}
      style={{ gridRow: row + 1, gridColumn: column + 1, background: kind === 'empty' ? undefined : face.background }}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {face.icon && !iconMissing && (
        <img
          className="key-icon"
          src={iconUrl(face.icon, stamp)}
          alt=""
          style={{ objectFit: face.iconFit }}
          draggable={false}
          onError={() => setMissingIcon(iconId)}
        />
      )}
      {iconMissing && (
        // The same built-in the deck draws for an icon it cannot read (scope §3).
        <img className="key-icon key-icon-missing" src={missingIconUrl} alt="" title={`Cannot read ${face.icon}`} draggable={false} />
      )}
      {face.label && (
        <span
          className={`key-label key-label-${face.labelPosition}`}
          // The deck's label size relative to its key pixels, applied to this key's width (container units).
          style={{ color: face.labelColor, fontSize: `calc(${face.labelScale} * 100cqw)` }}
        >
          {face.label}
        </span>
      )}
      {!face.icon && !face.label && button?.action && (
        // A live face (now playing, clock) is not drawn here; name the action so the key is not blank.
        <span className="key-caption">{actionName(button.action.type)}</span>
      )}
      {kind === 'unbound' && (
        <span className="key-mark" title="Shows something, but does nothing when pressed">
          no action
        </span>
      )}
    </button>
  );
}
