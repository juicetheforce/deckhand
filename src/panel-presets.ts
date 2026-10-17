/**
 * A virtual deck's key grid, from a size: Small, Medium, Large or Custom.
 * Import-free, so the editor makes panels with the daemon's own rule and the
 * tests hold it against the screens measured.
 *
 * **A size is a key pitch, not a count**: Small ~23 mm, Medium ~30 mm, Large
 * ~45 mm. Rows are the screen's short side divided by the pitch, rounded (at
 * least one); columns are as many square keys as fit along the long side;
 * the grid is centred, with a 12% gap. On the 10.3" panel (243 × 91 mm, 1920
 * × 720) that is 4 × 10, 3 × 8 and 2 × 5; on the Xeneon Edge (364 × 113 mm,
 * 2560 × 720) 5 × 17, 4 × 14 and 3 × 10. **A reported size is not trusted
 * blindly**: one that is implausible falls back to pixel pitches, 180, 240
 * and 360 px (the 10.3" panel's). **Custom**: the person chooses the rows,
 * and may set the columns; keys stay square either way.
 *
 * Controls are named k1, k2, … in reading order. A panel's canvas is in the
 * screen's pixels, so keys are drawn at the screen's own resolution.
 */

export type PanelSize = 'small' | 'medium' | 'large' | 'custom';

export const PRESET_SIZES: ReadonlyArray<Exclude<PanelSize, 'custom'>> = ['small', 'medium', 'large'];

/** The key pitch of each size: millimetres when the screen's size is plausible, else pixels. */
const PITCH_MM: Record<Exclude<PanelSize, 'custom'>, number> = { small: 23, medium: 30, large: 45 };
const PITCH_PX: Record<Exclude<PanelSize, 'custom'>, number> = { small: 180, medium: 240, large: 360 };
/** The gap between keys, as a share of the pitch. */
const GAP = 0.12;
/** Keys smaller than this are "very small": the editor says so, and never refuses. */
export const SMALL_KEY_MM = 15;
export const SMALL_KEY_PX = 96;

export interface ScreenSize {
  /** The canvas: the screen's size in pixels. */
  width: number;
  height: number;
  /** Its physical size from the EDID, when it has one (0 or absent when not). */
  widthMm?: number;
  heightMm?: number;
}

export interface PanelControl {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Panel {
  size: { width: number; height: number };
  controls: PanelControl[];
  preset: PanelSize;
}

export interface Grid {
  rows: number;
  columns: number;
  /** The pitch in screen pixels: a key and its share of the gap. */
  pitch: number;
  /** A key's side in screen pixels, and in millimetres when the size is known. */
  keyPx: number;
  keyMm: number | null;
  /** Below SMALL_KEY_MM (or SMALL_KEY_PX with no plausible size). */
  verySmall: boolean;
}

/**
 * Whether an EDID size can be believed for this screen: both sides given,
 * 2–25 pixels per mm, and the millimetres in the same proportion as the
 * pixels within 10%. Cheap panels misreport it.
 */
export function plausibleSize(screen: ScreenSize): boolean {
  const { width, height } = screen;
  const [wMm, hMm] = physical(screen);
  if (!wMm || !hMm || width <= 0 || height <= 0) return false;
  const density = [width / wMm, height / hMm];
  if (density.some((d) => d < 2 || d > 25)) return false;
  return Math.abs(wMm / hMm / (width / height) - 1) <= 0.1;
}

/** The physical size turned to match the pixels: a screen rotated to portrait still reports its EDID landscape. */
function physical(screen: ScreenSize): [number, number] {
  const wMm = screen.widthMm ?? 0;
  const hMm = screen.heightMm ?? 0;
  const pxPortrait = screen.height > screen.width;
  const mmPortrait = hMm > wMm;
  return pxPortrait === mmPortrait ? [wMm, hMm] : [hMm, wMm];
}

/** Pixels per mm along the short side, or null when the size is not plausible. */
function pxPerMm(screen: ScreenSize): number | null {
  if (!plausibleSize(screen)) return null;
  const [wMm, hMm] = physical(screen);
  return screen.width <= screen.height ? screen.width / wMm : screen.height / hMm;
}

/**
 * Rows, columns and pitch for a size. `custom` takes `rows` (at least 1) and,
 * optionally, `columns`: with both, keys are as large as fits both ways, still
 * square.
 */
export function gridFor(screen: ScreenSize, size: PanelSize, custom?: { rows: number; columns?: number }): Grid {
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  const perMm = pxPerMm(screen);
  let rows: number;
  let pitch: number;
  let columns: number;
  if (size === 'custom') {
    rows = Math.max(1, Math.floor(custom?.rows ?? 1));
    pitch = short / rows;
    if (custom?.columns !== undefined) {
      const wanted = Math.max(1, Math.floor(custom.columns));
      pitch = Math.min(pitch, long / wanted);
      columns = wanted;
    } else {
      columns = Math.max(1, Math.floor(long / pitch + 1e-9));
    }
  } else {
    const pitchPx = perMm === null ? PITCH_PX[size] : PITCH_MM[size] * perMm;
    rows = Math.max(1, Math.round(short / pitchPx));
    pitch = short / rows;
    columns = Math.max(1, Math.floor(long / pitch + 1e-9));
  }
  const keyPx = Math.round(pitch * (1 - GAP));
  const keyMm = perMm === null ? null : keyPx / perMm;
  return { rows, columns, pitch, keyPx, keyMm, verySmall: keyMm !== null ? keyMm < SMALL_KEY_MM : keyPx < SMALL_KEY_PX };
}

/**
 * The panel itself: controls k1, k2, … in reading order, each a square key
 * centred in its cell, the grid centred on the screen. Rows run along the
 * short side, so a portrait screen's grid stands up: there, "rows" across
 * are the columns of the landscape grid.
 */
export function makePanel(screen: ScreenSize, size: PanelSize, custom?: { rows: number; columns?: number }): Panel {
  const grid = gridFor(screen, size, custom);
  const portrait = screen.height > screen.width;
  const across = portrait ? grid.rows : grid.columns;
  const down = portrait ? grid.columns : grid.rows;
  const left = (screen.width - across * grid.pitch) / 2;
  const top = (screen.height - down * grid.pitch) / 2;
  const inset = (grid.pitch - grid.keyPx) / 2;
  const controls: PanelControl[] = [];
  for (let r = 0; r < down; r++) {
    for (let c = 0; c < across; c++) {
      controls.push({
        id: `k${controls.length + 1}`,
        x: Math.round(left + c * grid.pitch + inset),
        y: Math.round(top + r * grid.pitch + inset),
        w: grid.keyPx,
        h: grid.keyPx,
      });
    }
  }
  return { size: { width: screen.width, height: screen.height }, controls, preset: size };
}
