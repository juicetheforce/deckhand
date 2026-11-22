/**
 * An image's pixel size from its bytes, for the five formats Deckhand draws
 * (src/image-limits.ts): PNG, JPEG, WebP, GIF and SVG. Import-free, for the
 * editor's main process, which has no sharp: its config migration needs each
 * icon's proportions (src/icon-fit.ts). The daemon asks sharp; the two are
 * held to the same answers by scripts/smoke-appearance.mjs.
 *
 * An SVG's size is its width and height attributes in pixels (a bare number
 * or "px"), else its viewBox — as sharp (librsvg) reads it. Null for anything
 * it cannot tell.
 */
export interface PixelSize {
  width: number;
  height: number;
}

export function imageSize(data: Uint8Array): PixelSize | null {
  const u16be = (i: number) => (data[i] << 8) | data[i + 1];
  const u16le = (i: number) => data[i] | (data[i + 1] << 8);
  const u24le = (i: number) => data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
  const u32be = (i: number) => ((data[i] << 24) >>> 0) + (data[i + 1] << 16) + (data[i + 2] << 8) + data[i + 3];
  const ascii = (i: number, text: string) => [...text].every((c, n) => data[i + n] === c.charCodeAt(0));
  const ok = (s: PixelSize | null) => (s && s.width > 0 && s.height > 0 ? s : null);

  if (data.length >= 24 && data[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    return ok({ width: u32be(16), height: u32be(20) });
  }
  if (data.length >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) {
    return ok({ width: u16le(6), height: u16le(8) });
  }
  if (data.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) return ok({ width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    if (ascii(12, 'VP8L')) {
      const b = data.subarray(21, 25);
      return ok({ width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) });
    }
    if (ascii(12, 'VP8X')) return ok({ width: 1 + u24le(24), height: 1 + u24le(27) });
    return null;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // Walk the markers to the first start-of-frame.
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok({ width: u16be(i + 7), height: u16be(i + 5) });
      i += 2 + length;
    }
    return null;
  }
  return svgSize(data);
}

function svgSize(data: Uint8Array): PixelSize | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, 64 * 1024));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined) ?? null;
  const px = (v: string | null) => {
    const m = v === null ? null : /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const viewBox = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const box = viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0 ? { width: viewBox[2], height: viewBox[3] } : null;
  const w = px(attr('width'));
  const h = px(attr('height'));
  if (w !== null && h !== null) return w > 0 && h > 0 ? { width: w, height: h } : null;
  if (box && w !== null) return { width: w, height: (w * box.height) / box.width };
  if (box && h !== null) return { width: (h * box.width) / box.height, height: h };
  return box;
}
