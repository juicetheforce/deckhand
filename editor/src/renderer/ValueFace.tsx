import type { CSSProperties } from 'react';
import { DEFAULTS, fontFamily } from '../../../src/config-common.js';
import type { ButtonDef, Config } from '../../../src/types.js';
import { anglesOf, builtinLayerSvg, builtinSliderTravel, knobAngle, LAYERS, levelAt, takesValue, thumbOffset, type LayerName } from '../../../src/value-controls.js';
import { iconUrl } from '../shared/icons.js';

/**
 * A slider or dial drawn in the editor as the deck draws it (src/value-face.ts):
 * its layers — the built-in art, from the same drawing the daemon uses
 * (src/value-controls.ts), or the images chosen — each drawn to the art's
 * area, with the level shown by clipping the fill or ring and moving the thumb
 * or turning the knob. The label in its band at the foot. No outline: a
 * slider's or dial's zone is drawn only in Edit layout.
 *
 * The level is the deck's, from the daemon's status (`values`), when the page
 * shown is the one the deck is on; otherwise the control is drawn at its
 * lowest. A chosen thumb image travels by the built-in thumb's proportions
 * here; on the deck, by what the image itself draws.
 */
export function ValueFace({
  kind,
  direction,
  w,
  h,
  button,
  config,
  value,
  stamps,
  held = false,
}: {
  kind: 'slider' | 'dial';
  direction?: 'vertical' | 'horizontal';
  /** The control's box, in canvas pixels. */
  w: number;
  h: number;
  button: ButtonDef | undefined;
  config: Config;
  /** Whole percent of its range, or null when the deck has not said. */
  value: number | null;
  stamps: Record<string, string>;
  /** Drawn as a held one is: the thumb or knob brighter, with its halo. */
  held?: boolean;
}) {
  const d = { ...DEFAULTS, ...config.defaults };
  const type = button?.action && takesValue(button.action.type) ? button.action.type : undefined;
  const label = (button?.label ?? '').split('\n').filter((l) => l.length > 0);
  const size = button?.labelSize ?? d.labelSize;
  const band = label.length === 0 ? 0 : Math.min(Math.floor(h / 2), label.length * Math.round(size * 1.15) + 4);
  const artH = Math.max(1, h - band);
  const box = { w, h: artH };
  const angles = anglesOf(button);
  const v = value === null ? 0 : Math.max(0, Math.min(1, value / 100));
  const [still, fill, moving] = LAYERS[kind] as unknown as [LayerName, LayerName, LayerName];
  const art: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: `${(artH / h) * 100}%` };

  const layer = (name: LayerName, style: CSSProperties = {}, isHeld = false) => {
    const ref = button?.layers?.[name];
    if (ref === null) return null;
    const common: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', ...style };
    if (typeof ref === 'string' && ref !== '') {
      return <img key={name} className="value-layer" data-value-layer={name} src={iconUrl(ref, stamps[ref])} alt="" draggable={false} style={{ ...common, objectFit: 'fill', ...(isHeld ? { filter: 'brightness(1.25)' } : {}) }} />;
    }
    return (
      <span
        key={name}
        className="value-layer"
        data-value-layer={name}
        style={{ ...common, ...(isHeld ? { filter: 'brightness(1.15)' } : {}) }}
        // The same drawing the deck uses: built from numbers, no input from the config but colours and sizes.
        dangerouslySetInnerHTML={{ __html: builtinLayerSvg(name, box, { direction, angles, type, held: isHeld }).replace('<svg ', '<svg style="width:100%;height:100%;display:block" preserveAspectRatio="none" ') }}
      />
    );
  };

  let fillStyle: CSSProperties = {};
  let movingStyle: CSSProperties = {};
  if (kind === 'slider') {
    // The built-in's travel: a chosen thumb follows the same proportions here.
    const travel = builtinSliderTravel(box, direction);
    const level = levelAt(v, travel);
    const length = direction === 'horizontal' ? w : artH;
    const shift = thumbOffset(v, travel, length);
    if (direction === 'horizontal') {
      fillStyle = { clipPath: `inset(0 ${((w - level) / w) * 100}% 0 0)` };
      movingStyle = { transform: `translateX(${(shift / w) * 100}%)` };
    } else {
      fillStyle = { clipPath: `inset(${((artH - level) / artH) * 100}% 0 0 0)` };
      movingStyle = { transform: `translateY(${(-shift / artH) * 100}%)` };
    }
  } else {
    const angle = knobAngle(v, angles);
    fillStyle = { clipPath: sector(angles.start, angle, w, artH) };
    movingStyle = { transform: `rotate(${angle}deg)`, transformOrigin: '50% 50%' };
  }

  return (
    <span className="value-face" data-value-face={kind} data-value={value ?? ''} aria-hidden="true">
      <span style={art}>
        {layer(still)}
        {layer(fill, fillStyle)}
        {layer(moving, movingStyle, held)}
      </span>
      {band > 0 && (
        <span className="value-label" style={{ top: `${(artH / h) * 100}%`, color: button?.labelColor ?? d.labelColor, fontFamily: fontFamily(config.defaults?.labelFont), fontSize: `calc(${size / w} * 100cqw)` }}>
          {label.map((line, i) => (
            <span key={i} className="key-label-line">
              {line}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** A clip-path showing the sector from one angle to another round the centre (degrees from straight up, clockwise), in percent of the box. */
function sector(from: number, to: number, w: number, h: number): string {
  if (to <= from) return 'polygon(50% 50%, 50% 50%, 50% 50%)';
  const r = Math.hypot(w, h);
  const points = ['50% 50%'];
  for (let a = from; ; a = Math.min(to, a + 15)) {
    const rad = (a * Math.PI) / 180;
    points.push(`${((w / 2 + r * Math.sin(rad)) / w) * 100}% ${((h / 2 - r * Math.cos(rad)) / h) * 100}%`);
    if (a >= to) break;
  }
  return `polygon(${points.join(', ')})`;
}
