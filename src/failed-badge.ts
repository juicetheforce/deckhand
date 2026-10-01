/**
 * The key badges. The failed-key badge: a red disc with a white X, with a dark
 * ring so it holds over red icons and bright album art. The one drawing of it:
 * the daemon rasterises it over a key's face (src/render.ts), and the editor's
 * grid inlines it over the same key, so the mirror matches the deck.
 *
 * Pure and import-free, so the editor can import it.
 *
 * 30% of the key, in its top-right corner: 22 px on a 72 px key, 29 on a 96 px
 * one. Checked on both deck sizes: the X stays legible at 72 px.
 */

/** The badge's diameter and its inset from the key's top and right edges, for a key `size` pixels square. */
export function failedBadgePlacement(size: number): { diameter: number; inset: number } {
  return { diameter: Math.round(size * 0.3), inset: Math.round(size * 0.04) };
}

/** The badge as SVG text, `diameter` pixels square. */
export function failedBadgeSvg(diameter: number): string {
  const r = diameter / 2;
  const ring = Math.max(1.5, diameter / 14.4);
  const arm = diameter * 0.22;
  const stroke = Math.max(2, diameter / 9);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}">
  <circle cx="${r}" cy="${r}" r="${r - ring / 2}" fill="#e5484d" stroke="rgba(0,0,0,0.85)" stroke-width="${ring}"/>
  <path d="M${r - arm} ${r - arm} L${r + arm} ${r + arm} M${r + arm} ${r - arm} L${r - arm} ${r + arm}" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round"/>
</svg>`;
}

/**
 * The not-set-up badge: a grey disc with a white plug, in the failed badge's
 * place, for a key whose integration (OBS) is not set up — drawn instead of
 * the failed badge, so the two are never confused. Claude Design's
 * `badge-not-setup.svg` (screen 10a), as drawn; generic, so Twitch and
 * VTube Studio reuse it.
 */
export function unsetBadgeSvg(diameter: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="11" fill="#6b7086" stroke="#11121c" stroke-width="2"/>
  <g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.5 5.5 V8.5 M14.5 5.5 V8.5"/>
    <path d="M7.5 8.5 H16.5 V11.5 A4.5 4.5 0 0 1 7.5 11.5 Z" fill="#fff"/>
    <path d="M12 16 V19"/>
  </g>
</svg>`;
}
