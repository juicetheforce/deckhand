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
 * place and ring, for a key whose integration (OBS) is not set up — drawn
 * instead of the failed badge, so the two are never confused. Placeholder
 * glyph until Claude Design's; shared later by Twitch and VTube Studio.
 */
export function unsetBadgeSvg(diameter: number): string {
  // Drawn on a 24-unit grid; the ring keeps the failed badge's pixel width.
  const ring = (Math.max(1.5, diameter / 14.4) * 24) / diameter;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="${12 - ring / 2}" fill="#6b7080" stroke="rgba(0,0,0,0.85)" stroke-width="${ring}"/>
  <path d="M9.5 5.5v3.5M14.5 5.5v3.5M7.5 9h9v2.5a4.5 4.5 0 0 1-9 0zM12 16v2.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
