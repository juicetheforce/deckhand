import { useState, type CSSProperties } from 'react';
import { DEFAULTS, fontFamily } from '../../../src/config-common.js';
import type { ButtonDef, Config } from '../../../src/types.js';
import { anglesOf, builtinLayerSvg, knobAngle, layerArea, LAYERS, LAYERS_WITHOUT_BUILTIN, levelAt, levelOf, levelSvg, sliderTravel, takesValue, thumbOffset, type LayerName } from '../../../src/value-controls.js';
import { iconUrl } from '../shared/icons.js';

/**
 * A slider or dial drawn in the editor as the deck draws it (src/value-face.ts):
 * its image layers — the built-in art, from the same drawing the daemon uses
 * (src/value-controls.ts), or the images chosen, each in its own area
 * (layerArea: stretched, or fitted keeping its proportions) — and the level,
 * drawn in its colour: a slider's fill clipped to the level under the thumb,
 * a dial's ring swept to it over the knob. The background image covers the
 * whole box; the label sits in its band at the foot. No outline: a slider's
 * or dial's zone is drawn only in Edit layout.
 *
 * The level is the deck's, from the daemon's status (`values`), when the page
 * shown is the one the deck is on; otherwise the control is drawn at its
 * lowest. A slider's travel is the deck's own rule (value-controls.ts
 * sliderTravel): a chosen thumb's length from its image's own size, learnt
 * when the image loads.
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
  const level = levelOf(button, type);
  const v = value === null ? 0 : Math.max(0, Math.min(1, value / 100));
  const [back, still, moving] = LAYERS[kind] as unknown as [LayerName, LayerName, LayerName];
  const full: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
  // A chosen thumb's own size, from its image once loaded: the travel needs it, as the deck's does.
  const [thumbSize, setThumbSize] = useState<{ src: string; w: number; h: number } | null>(null);
  const custom = (name: LayerName) => {
    const ref = button?.layers?.[name];
    return typeof ref === 'string' && ref !== '' ? ref : null;
  };

  /** One image layer, filling its parent (the box or the art's area); `style` moves or turns it as a whole. */
  const layer = (name: LayerName, on: { w: number; h: number }, style: CSSProperties = {}, isHeld = false) => {
    const ref = button?.layers?.[name];
    if (ref === null) return null;
    const file = custom(name);
    if (file) {
      // In its own area: stretched to it, or fitted keeping its proportions (Ryan, 2026-11-22).
      const a = layerArea(name, on, direction);
      const at: CSSProperties = { position: 'absolute', left: `${(a.x / on.w) * 100}%`, top: `${(a.y / on.h) * 100}%`, width: `${(a.w / on.w) * 100}%`, height: `${(a.h / on.h) * 100}%`, objectFit: a.stretch ? 'fill' : 'contain' };
      return (
        <span key={name} className="value-layer" data-value-layer={name} style={{ ...full, ...style, ...(isHeld ? { filter: 'brightness(1.25)' } : {}) }}>
          <img
            src={iconUrl(file, stamps[file])}
            alt=""
            draggable={false}
            style={at}
            onLoad={name === 'thumb' ? (e) => setThumbSize({ src: file, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }) : undefined}
          />
        </span>
      );
    }
    if (LAYERS_WITHOUT_BUILTIN.includes(name)) return null;
    return (
      <span
        key={name}
        className="value-layer"
        data-value-layer={name}
        style={{ ...full, ...style, ...(isHeld ? { filter: 'brightness(1.15)' } : {}) }}
        // The same drawing the deck uses: built from numbers, no input from the config but colours and sizes.
        dangerouslySetInnerHTML={{ __html: svgFilling(builtinLayerSvg(name, box, { direction, angles, type, held: isHeld })) }}
      />
    );
  };

  let levelStyle: CSSProperties = {};
  /** A slider's travel as drawn, for the checks: start, end and thumb, whole pixels. */
  let travelSaid: string | undefined;
  let movingStyle: CSSProperties = {};
  if (kind === 'slider') {
    const thumbFile = custom('thumb');
    // Until a chosen thumb's image has loaded, its area's length stands in for it.
    const area = layerArea('thumb', box, direction);
    const thumb = thumbFile === null ? null : thumbSize?.src === thumbFile ? thumbSize : { w: area.w, h: area.h };
    const travel = sliderTravel(box, direction, { customTrack: custom('track') !== null, thumb });
    travelSaid = [travel.start, travel.end, travel.thumb].map((n) => Math.round(n)).join(',');
    const at = levelAt(v, travel);
    const length = direction === 'horizontal' ? w : artH;
    const shift = thumbOffset(v, travel, length);
    if (direction === 'horizontal') {
      levelStyle = { clipPath: `inset(0 ${((w - at) / w) * 100}% 0 0)` };
      movingStyle = { transform: `translateX(${(shift / w) * 100}%)` };
    } else {
      levelStyle = { clipPath: `inset(${((artH - at) / artH) * 100}% 0 0 0)` };
      movingStyle = { transform: `translateY(${(-shift / artH) * 100}%)` };
    }
  } else {
    const angle = knobAngle(v, angles);
    levelStyle = { clipPath: sector(angles.start, angle, w, artH) };
    movingStyle = { transform: `rotate(${angle}deg)`, transformOrigin: '50% 50%' };
  }
  // Drawn by Deckhand, never an image: shown unless switched off, in its colour.
  const levelLayer = level.show ? (
    <span key="level" className="value-layer" data-value-layer="level" style={{ ...full, ...levelStyle }} dangerouslySetInnerHTML={{ __html: svgFilling(levelSvg(kind, box, { direction, angles, color: level.color })) }} />
  ) : null;

  return (
    <span className="value-face" data-value-face={kind} data-value={value ?? ''} data-travel={travelSaid} aria-hidden="true">
      {layer(back, { w, h })}
      <span style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `${(artH / h) * 100}%` }}>
        {layer(still, box)}
        {/* A slider's fill under its thumb; a dial's ring over its knob, so no knob image hides it. */}
        {kind === 'slider' && levelLayer}
        {layer(moving, box, movingStyle, held)}
        {kind === 'dial' && levelLayer}
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

/** An SVG drawn to fill its element. */
function svgFilling(svg: string): string {
  return svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" preserveAspectRatio="none" ');
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
