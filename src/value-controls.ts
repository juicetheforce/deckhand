/**
 * Sliders and dials (scope §7, stage 2, round 5): what they are, what they
 * take, how a finger moves them, and their built-in art. Import-free, so the
 * daemon and the editor share one copy, as hit-test.ts and shapes.ts are.
 *
 * - **A slider** is vertical (lowest at the bottom) or horizontal (lowest at
 *   the left): a track that stays still, a fill shown up to the level, and a
 *   thumb that travels the track's length minus its own. Its touch is Drag
 *   only — a tap changes nothing, the level moves by how far the finger moves
 *   — or Jump to touch — the level goes to the finger, then follows it.
 * - **A dial** has a base that stays still, a level ring shown from the start
 *   angle round to the level, and a knob that rotates between a start and an
 *   end angle (−135° and 135° unless set: degrees from straight up,
 *   clockwise). It turns by dragging around its centre.
 * - **Both take only an action that carries a value** (VALUE_ACTIONS): a
 *   button keeps every action it has.
 *
 * Every layer is drawn to the control's box. A slider's thumb image covers the
 * whole box too, with the thumb drawn at its middle, so what moves is the whole
 * layer, by `thumbOffset`.
 */

/** What a control on a virtual deck's panel is. */
export type ControlKind = 'button' | 'slider' | 'dial';
export type ValueKind = 'slider' | 'dial';

export function controlKind(control: { kind?: string } | undefined): ControlKind {
  return control?.kind === 'slider' || control?.kind === 'dial' ? control.kind : 'button';
}

/** The actions a slider or dial can take: those that carry a value. */
export const VALUE_ACTIONS = ['audio.volume', 'brightness', 'discord.userVolume'] as const;

export function takesValue(type: string | undefined): boolean {
  return type !== undefined && (VALUE_ACTIONS as readonly string[]).includes(type);
}

/** What a drop of a button-only action on a slider or dial says (board 26e). */
export const NEEDS_VALUE = 'Needs an action with a value';

/** Each kind's layers, bottom first. */
export const LAYERS = { slider: ['track', 'fill', 'thumb'], dial: ['base', 'ring', 'knob'] } as const;
export type LayerName = (typeof LAYERS)[ValueKind][number];
/** The layers that may be None (board 26f): the rest always have art, built-in until something is chosen. */
export const LAYERS_THAT_MAY_BE_NONE: ReadonlyArray<LayerName> = ['fill', 'base', 'ring'];

export const LAYER_LABELS: Record<LayerName, string> = { track: 'Track', fill: 'Fill', thumb: 'Thumb', base: 'Base', ring: 'Level ring', knob: 'Knob' };

/** A dial's knob turns from start to end, degrees from straight up, clockwise. */
export const DEFAULT_ANGLES = { start: -135, end: 135 } as const;
/** Angles are within one turn either side of straight up; the knob turns at least 10° and at most one whole turn. */
export const ANGLE_LIMIT = 360;
export const MIN_SWEEP = 10;

export function validAngles(a: unknown): a is { start: number; end: number } {
  if (typeof a !== 'object' || a === null) return false;
  const { start, end } = a as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (Math.abs(start) > ANGLE_LIMIT || Math.abs(end) > ANGLE_LIMIT) return false;
  return end - start >= MIN_SWEEP && end - start <= 360;
}

export function anglesOf(button: { angles?: { start: number; end: number } } | undefined): { start: number; end: number } {
  return button?.angles && validAngles(button.angles) ? button.angles : DEFAULT_ANGLES;
}

/** Where the knob points at a value (0–1), degrees from straight up, clockwise. */
export function knobAngle(value: number, angles: { start: number; end: number }): number {
  return angles.start + clamp01(value) * (angles.end - angles.start);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * New controls' physical sizes (scope, "Controls in the mode"): a slider about
 * 14 × 60 mm, its long side never more than three-quarters of the panel's
 * shorter side; a dial about 25 mm across.
 */
export const SLIDER_MM = { across: 14, along: 60 } as const;
export const SLIDER_MAX_OF_SHORTER = 0.75;
export const DIAL_MM = 25;

// ---------------------------------------------------------------------------
// How a slider's thumb travels
// ---------------------------------------------------------------------------

/**
 * Where a slider's art lies along its axis, in its box's pixels from the
 * lowest end (the bottom, or the left): the track from `start` to `end`, and
 * the thumb's own length. Measured from the art (the extent of what it
 * draws), so a custom track and thumb travel as drawn.
 */
export interface Travel {
  start: number;
  end: number;
  thumb: number;
}

/** A box's length along a slider's axis. */
export function axisLength(box: { w: number; h: number }, direction: string | undefined): number {
  return direction === 'horizontal' ? box.w : box.h;
}

/** Travel with nothing measured yet: the whole box, a thumb of no length. */
export function boxTravel(box: { w: number; h: number }, direction: string | undefined): Travel {
  return { start: 0, end: axisLength(box, direction), thumb: 0 };
}

/** The level line — the thumb's centre, and the fill's edge — at a value, from the lowest end. */
export function levelAt(value: number, t: Travel): number {
  const from = t.start + t.thumb / 2;
  const to = t.end - t.thumb / 2;
  return from + clamp01(value) * Math.max(0, to - from);
}

/** How far the thumb has moved from the middle of its box, along the axis, towards the highest end. */
export function thumbOffset(value: number, t: Travel, length: number): number {
  return levelAt(value, t) - length / 2;
}

/** How far a finger must move for the level to go from lowest to highest. */
export function travelLength(t: Travel): number {
  return Math.max(1, t.end - t.start - t.thumb);
}

/** A point in a slider's box, as a distance from its lowest end: up is higher on a vertical slider. */
export function alongAxis(point: { x: number; y: number }, box: { w: number; h: number }, direction: string | undefined): number {
  return direction === 'horizontal' ? point.x : box.h - point.y;
}

/** Jump to touch: the value at a point in the box. */
export function valueAtPoint(point: { x: number; y: number }, box: { w: number; h: number }, direction: string | undefined, t: Travel): number {
  return clamp01((alongAxis(point, box, direction) - t.start - t.thumb / 2) / travelLength(t));
}

/** A finger's angle round a box's centre, degrees from straight up, clockwise, −180 to 180. */
export function angleAround(point: { x: number; y: number }, box: { w: number; h: number }): number {
  return (Math.atan2(point.x - box.w / 2, box.h / 2 - point.y) * 180) / Math.PI;
}

/** The shortest turn from one angle to another, −180 to 180: a finger crossing straight down is not a whole turn. */
export function turnBetween(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A value in an action's units, as a fraction of its range. */
export function fractionOf(value: number, range: { min: number; max: number }): number {
  return clamp01((value - range.min) / Math.max(1e-9, range.max - range.min));
}

/** A fraction of a range back in the action's units, whole numbers. */
export function valueOfFraction(fraction: number, range: { min: number; max: number }): number {
  return Math.round(range.min + clamp01(fraction) * (range.max - range.min));
}

// ---------------------------------------------------------------------------
// Built-in art (board 26a): drawn for the control's box, in its action's colour
// ---------------------------------------------------------------------------

/** Each value action's colour, as its built-in icons have it. */
export const ART_COLOURS: Record<string, string> = { 'audio.volume': '#8f9cf0', brightness: '#e8b45a', 'discord.userVolume': '#5ab8f5' };
/** The colour of art for a control with no action yet: Volume's, as board 26a draws the set. */
export const ART_DEFAULT_COLOUR = '#8f9cf0';
/** The dark cut-out of the family's solid parts. */
const CUT = '#11121c';

export function artColour(type: string | undefined): string {
  return (type && ART_COLOURS[type]) || ART_DEFAULT_COLOUR;
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const r2 = (n: number) => String(Math.round(n * 100) / 100);

function svg(width: number, height: number, body: string): string {
  return `<svg width="${r2(width)}" height="${r2(height)}" viewBox="0 0 ${r2(width)} ${r2(height)}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/**
 * The board's slider, 46 wide and 130 long, scaled by the box's width across
 * the axis and stretched along it: the track and fill run the box's length,
 * the thumb keeps its size, at the middle. A horizontal slider is the same art
 * lying down, lowest at the left (26a, "the same three, lying down").
 */
const SLIDER = { across: 46, track: { x: 17.48, w: 11.04, end: 4.76, rx: 5.52, stroke: 1.4 }, fillTop: 10.28, thumb: { x: 5.06, w: 35.88, h: 16.56, rx: 5, line: { x1: 13.67, x2: 32.33, w: 1.99 } } };

function sliderParts(across: number, along: number): { k: number; dx: number } {
  // Scaled by the box's width across the axis — never so far that the thumb is longer than a third of the slider.
  const k = Math.min(across / SLIDER.across, along / (SLIDER.thumb.h * 3));
  return { k, dx: (across - SLIDER.across * k) / 2 };
}

/** The held thumb's and knob's halo (26b, 26c): grown this much on each side, in the art's own units, in its colour at 30%. */
const HALO = { grow: 2.63, rx: 5.26, alpha: 0.3 };

/** One layer of the built-in slider, as an SVG the box's size: vertical, or lying down. `held`: the thumb with its halo. */
export function sliderLayerSvg(layer: 'track' | 'fill' | 'thumb', box: { w: number; h: number }, direction: string | undefined, colour: string, held = false): string {
  const horizontal = direction === 'horizontal';
  const across = horizontal ? box.h : box.w;
  const along = horizontal ? box.w : box.h;
  const { k, dx } = sliderParts(across, along);
  const t = SLIDER.track;
  let body: string;
  if (layer === 'track') {
    body = `<rect x="${r2(dx + t.x * k)}" y="${r2(t.end * k)}" width="${r2(t.w * k)}" height="${r2(along - 2 * t.end * k)}" rx="${r2(t.rx * k)}" fill="${rgba(colour, 0.12)}" stroke="${rgba(colour, 0.6)}" stroke-width="${r2(t.stroke * k)}"/>`;
  } else if (layer === 'fill') {
    body = `<rect x="${r2(dx + t.x * k)}" y="${r2(SLIDER.fillTop * k)}" width="${r2(t.w * k)}" height="${r2(along - SLIDER.fillTop * k - t.end * k)}" rx="${r2(t.rx * k)}" fill="${colour}" opacity=".9"/>`;
  } else {
    const th = SLIDER.thumb;
    const mid = along / 2;
    const g = HALO.grow * k;
    body =
      (held ? `<rect x="${r2(dx + th.x * k - g)}" y="${r2(mid - (th.h * k) / 2 - g)}" width="${r2(th.w * k + 2 * g)}" height="${r2(th.h * k + 2 * g)}" rx="${r2(HALO.rx * k)}" fill="${rgba(colour, HALO.alpha)}"/>` : '') +
      `<rect x="${r2(dx + th.x * k)}" y="${r2(mid - (th.h * k) / 2)}" width="${r2(th.w * k)}" height="${r2(th.h * k)}" rx="${r2(th.rx * k)}" fill="${colour}" stroke="${CUT}" stroke-width="${r2(k)}"/>` +
      `<path d="M${r2(dx + th.line.x1 * k)} ${r2(mid)} H${r2(dx + th.line.x2 * k)}" stroke="${CUT}" stroke-width="${r2(th.line.w * k)}" stroke-linecap="round"/>`;
  }
  if (!horizontal) return svg(box.w, box.h, body);
  // Lying down: the vertical art turned a quarter clockwise, so its bottom is the left.
  return svg(box.w, box.h, `<g transform="translate(${r2(box.w)} 0) rotate(90)">${body}</g>`);
}

/** The built-in slider's travel at this box, without measuring: the track's ends and the thumb's length. */
export function builtinSliderTravel(box: { w: number; h: number }, direction: string | undefined): Travel {
  const horizontal = direction === 'horizontal';
  const across = horizontal ? box.h : box.w;
  const along = horizontal ? box.w : box.h;
  const { k } = sliderParts(across, along);
  // To the outer edges of the strokes, as measuring the drawn art finds them (value-face.ts).
  const edge = (SLIDER.track.end - SLIDER.track.stroke / 2) * k;
  return { start: edge, end: along - edge, thumb: (SLIDER.thumb.h + 1) * k };
}

/** The board's dial, 76 across: a base and level ring on one arc, and a knob pointing straight up. */
const DIAL = { size: 76, arc: { r: 33.44, w: 4.56 }, knob: { r: 22.04, w: 1.6, from: 30.4, to: 20.52, line: 3.04 } };

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const at = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = at(start);
  const [x1, y1] = at(end);
  const large = end - start > 180 ? 1 : 0;
  return `M${r2(x0)} ${r2(y0)} A${r2(r)} ${r2(r)} 0 ${large} 1 ${r2(x1)} ${r2(y1)}`;
}

/** One layer of the built-in dial, as an SVG the box's size: drawn at its shorter side, centred. The arcs run from start to end. */
export function dialLayerSvg(layer: 'base' | 'ring' | 'knob', box: { w: number; h: number }, angles: { start: number; end: number }, colour: string, held = false): string {
  const k = Math.min(box.w, box.h) / DIAL.size;
  const cx = box.w / 2;
  const cy = box.h / 2;
  let body: string;
  if (layer === 'knob') {
    const n = DIAL.knob;
    body =
      (held ? `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2((n.r + HALO.grow) * k)}" fill="${rgba(colour, HALO.alpha)}"/>` : '') +
      `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(n.r * k)}" fill="${rgba(colour, 0.16)}" stroke="${colour}" stroke-width="${r2(n.w * k)}"/>` +
      `<path d="M${r2(cx)} ${r2(cy - (DIAL.size / 2 - n.from) * k)} L${r2(cx)} ${r2(cy - (DIAL.size / 2 - n.to) * k)}" stroke="${colour}" stroke-width="${r2(n.line * k)}" stroke-linecap="round"/>`;
  } else {
    const stroke = layer === 'base' ? 'rgba(255,255,255,.14)' : colour;
    body = `<path d="${arcPath(cx, cy, DIAL.arc.r * k, angles.start, angles.end)}" fill="none" stroke="${stroke}" stroke-width="${r2(DIAL.arc.w * k)}" stroke-linecap="round"/>`;
  }
  return svg(box.w, box.h, body);
}

/** The built-in art for one layer of a control. */
export function builtinLayerSvg(layer: LayerName, box: { w: number; h: number }, how: { direction?: string; angles?: { start: number; end: number }; type?: string; held?: boolean }): string {
  const colour = artColour(how.type);
  if (layer === 'track' || layer === 'fill' || layer === 'thumb') return sliderLayerSvg(layer, box, how.direction, colour, how.held);
  return dialLayerSvg(layer, box, how.angles ?? DEFAULT_ANGLES, colour, how.held);
}

/** The reference sizes board 26a draws the art at: what assets/art/ holds, and what the generator is tested against. */
export const ART_REFERENCE = { slider: { w: 46, h: 130 }, dial: { w: 76, h: 76 } } as const;
