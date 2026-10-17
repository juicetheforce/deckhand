import { useEffect, useState } from 'react';
import { geometryOfPanel } from '../../../src/geometry.js';
import { gridFor, makePanel, PRESET_SIZES, type ScreenSize } from '../../../src/panel-presets.js';
import type { Config, PanelDef } from '../../../src/types.js';

/**
 * "Add a layout" for a virtual deck in a profile that has none: its panel is
 * per profile, so the size is asked again — preselected to a panel it
 * already has elsewhere, copied as it is, or Small, Medium or Large on its
 * screen.
 */
export function VirtualLayoutPicker({ config, serial, label, disabled, onAdd }: {
  config: Config;
  serial: string;
  label: string;
  disabled: boolean;
  onAdd: (panel: PanelDef) => void;
}) {
  const existing = Object.entries(config.profiles).flatMap(([id, p]) => (p.layouts[serial]?.panel ? [{ id, name: p.name ?? id, panel: p.layouts[serial].panel! }] : []))[0];
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [choice, setChoice] = useState<string>(existing ? 'same' : 'medium');
  useEffect(() => {
    void window.deckhand.virtualScreenSize(serial).then(setScreen);
  }, [serial]);

  const sameGeometry = existing ? geometryOfPanel(existing.panel, '') : null;
  const panel = (): PanelDef | null => {
    if (choice === 'same' && existing) return structuredClone(existing.panel);
    const size = PRESET_SIZES.find((s) => s === choice);
    return size && screen ? makePanel(screen, size) : null;
  };

  return (
    <div className="virtual-layout-picker" data-virtual-layout={serial}>
      <label>
        <span className="muted small">Key size </span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} data-virtual-layout-size="">
          {existing && sameGeometry && (
            <option value="same">
              Same as in “{existing.name}” ({sameGeometry.rows} × {sameGeometry.columns})
            </option>
          )}
          {screen &&
            PRESET_SIZES.map((s) => {
              const g = gridFor(screen, s);
              return (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)} ({g.rows} × {g.columns})
                </option>
              );
            })}
        </select>
      </label>
      <button
        className="primary"
        disabled={disabled || panel() === null}
        onClick={() => {
          const p = panel();
          if (p) onAdd(p);
        }}
      >
        Add a layout for {label}
      </button>
    </div>
  );
}
