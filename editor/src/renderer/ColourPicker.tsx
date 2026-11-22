import { useEffect, useRef, useState } from 'react';
import { BACKGROUND_SWATCHES } from './BackgroundPanel.js';

/**
 * A key's colour (round 4, board 27a): **Default**, round 3's preset swatches
 * (BackgroundPanel.tsx, BACKGROUND_SWATCHES), or a colour typed as hex. There
 * is no None: every button has a solid fill, the icon drawn on top. Used for
 * a key's own background in the inspector's Key tab and for the default key
 * colour in Settings › General › Appearance, drawn as the page background's
 * colour row is — the same classes and swatches.
 *
 * The row shows the colour and its hex, "Default" while none is set; the
 * swatches open under it. A change saves at once; Esc or a click outside
 * closes them.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

export function ColourPicker({
  value,
  defaultColor,
  defaultTitle,
  label,
  disabled,
  onChange,
  name,
}: {
  /** The colour set, or null: Default. */
  value: string | null;
  /** What Default draws as now. */
  defaultColor: string;
  /** What Default follows, said on its chip. */
  defaultTitle: string;
  /** The row's accessible name. */
  label: string;
  disabled?: boolean;
  onChange: (color: string | null) => void;
  /** For the checks: data-colour-picker="<name>". */
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = value ?? defaultColor;
  const [hex, setHex] = useState(value ?? '');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setHex(value ?? ''), [value]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  const typed = (text: string) => {
    setHex(text);
    const withHash = text.startsWith('#') ? text : `#${text}`;
    if (HEX.test(withHash) && withHash.toLowerCase() !== value?.toLowerCase()) onChange(withHash.toLowerCase());
  };

  return (
    <div className="colour-picker" ref={root} data-colour-picker={name} data-value={value ?? 'default'}>
      <div className="background-row">
        <button
          className="background-swatch"
          style={{ background: shown }}
          aria-label={`${label}: ${value ?? 'Default'}`}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          data-colour-swatch=""
        />
        <input
          className="background-hex"
          aria-label={`${label} hex`}
          placeholder="Default"
          value={hex}
          spellCheck={false}
          maxLength={7}
          disabled={disabled}
          onChange={(e) => typed(e.target.value.trim())}
          onBlur={() => setHex(value ?? '')}
          data-colour-hex=""
        />
      </div>
      {open && (
        <div className="background-swatches colour-swatches" role="listbox" aria-label={`${label} colours`}>
          <button
            role="option"
            aria-selected={value === null}
            className={`background-chip colour-chip-default${value === null ? ' background-chip-current' : ''}`}
            style={{ background: defaultColor }}
            title={`Default: ${defaultTitle}`}
            disabled={disabled}
            onClick={() => value !== null && onChange(null)}
            data-colour-chip="default"
          >
            <span aria-hidden="true">D</span>
          </button>
          {BACKGROUND_SWATCHES.map((c) => (
            <button
              key={c}
              role="option"
              aria-selected={value?.toLowerCase() === c}
              className={value?.toLowerCase() === c ? 'background-chip background-chip-current' : 'background-chip'}
              style={{ background: c }}
              title={c}
              disabled={disabled}
              onClick={() => value?.toLowerCase() !== c && onChange(c)}
              data-colour-chip={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}
