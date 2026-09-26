import sharp from 'sharp';

/**
 * Fitting a label line to a key: a line wider than the key is cut and ends in
 * an ellipsis, so its start stays readable instead of both ends running off
 * the key. No scrolling — an animated label would repaint the key for as long
 * as the page is visible.
 *
 * Widths are measured, not guessed from a character count: "WWWWWW" and
 * "iiiiii" are 81 px and 24 px at 14 px. A measurement draws the line with the
 * same SVG style the key uses (labelStyle(), below) and finds the edges of
 * its ink, so it is exactly what the key would show. Pango through sharp's
 * text input is not the renderer the key uses, and read 67 px for the same
 * "WWWWWW".
 *
 * A measurement costs milliseconds, so it happens only when a key is drawn
 * with a label it has not drawn before (renderButton() caches whole keys), and
 * each measured width is kept.
 */

/** The label's text style, shared by the key and by measurement so the two cannot drift. */
export function labelStyle(fontSize: number, color: string): string {
  // paint-order:stroke draws a dark outline behind the glyphs so light text
  // stays readable over a bright icon.
  return `.lbl {
      font-family: sans-serif;
      font-size: ${fontSize}px;
      font-weight: 600;
      fill: ${color};
      stroke: rgba(0,0,0,0.75);
      stroke-width: ${Math.max(2, Math.round(fontSize / 6))}px;
      paint-order: stroke;
      stroke-linejoin: round;
    }`;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const ELLIPSIS = '…';
/** Space kept clear at each side of the key. */
const SIDE_MARGIN = 2;

const widths = new Map<string, number>();
const MAX_WIDTHS = 1024;
/** How many lines have been measured — for the tests and for timing a track change. */
let measureCount = 0;

/** The drawn width of one line, in pixels, including its outline. 0 for a line with no ink. */
export async function measureLine(text: string, fontSize: number): Promise<number> {
  const key = `${fontSize}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;

  measureCount++;
  // Wide enough for any glyph at this size, so nothing is clipped before the trim.
  const pad = fontSize;
  const width = Math.ceil(Array.from(text).length * fontSize * 1.5) + pad * 2;
  const height = fontSize * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>${labelStyle(fontSize, '#fff')}</style>
  <text x="${pad}" y="${Math.round(fontSize * 1.4)}" class="lbl">${escapeXml(text)}</text>
</svg>`;

  // The ink's extent, read from the alpha channel here: sharp's trim() gives
  // the same answer at 20-35 ms a call, against about 6 ms for the render and
  // this scan (measured, 2026-09-25).
  let measured = 0;
  try {
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    let left = info.width;
    let right = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels + 3] === 0) continue;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (right >= left) measured = right - left + 1;
  } catch {
    measured = 0;
  }

  if (widths.size >= MAX_WIDTHS) {
    const oldest = widths.keys().next().value;
    if (oldest !== undefined) widths.delete(oldest);
  }
  widths.set(key, measured);
  return measured;
}

function cut(chars: string[], n: number): string {
  return `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * The line as it fits a key `keySize` px wide: unchanged if it fits, otherwise
 * its longest start that fits followed by an ellipsis.
 *
 * The cut is estimated from the full line's width — the fraction of it that
 * fits, less the ellipsis, applied to its length — then checked and moved a
 * character at a time. About two measurements on a real title, against five
 * or six for a binary search.
 */
export async function fitLine(text: string, fontSize: number, keySize: number): Promise<string> {
  const room = keySize - SIDE_MARGIN * 2;
  const full = await measureLine(text, fontSize);
  if (full <= room) return text;

  // Code points, so a cut never splits a surrogate pair. No check holds this:
  // a split pair draws as U+FFFD, wider than the room it would have to fit, so
  // measuring rejects it anyway (tried at every key width from 30 to 200 px).
  const chars = Array.from(text);
  const fits = async (n: number) => (await measureLine(cut(chars, n), fontSize)) <= room;

  // The ellipsis's own width is measured once for the life of the process.
  const ellipsis = await measureLine(ELLIPSIS, fontSize);
  const estimate = Math.floor((chars.length * (room - ellipsis)) / full);
  let n = Math.min(chars.length - 1, Math.max(1, estimate));
  if (await fits(n)) {
    while (n + 1 < chars.length && (await fits(n + 1))) n++;
  } else {
    // Never fewer than one character: a key that cannot fit even that shows it clipped.
    do n--;
    while (n > 1 && !(await fits(n)));
    n = Math.max(1, n);
  }
  return cut(chars, n);
}

export function labelMeasureCount(): number {
  return measureCount;
}

export function clearLabelWidths(): void {
  widths.clear();
}
