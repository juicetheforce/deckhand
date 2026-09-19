/**
 * The failed-key badge (Ship piece 6): a red disc with a white X, with a dark
 * ring so it holds over red icons and bright album art. The one drawing of it:
 * the daemon rasterises it over a key's face (src/render.ts), and the editor's
 * grid inlines it over the same key, so the mirror matches the deck.
 *
 * Pure and import-free, so the editor can import it (docs/code-state.md, M4
 * phase A proof 0a).
 *
 * 30% of the key, in its top-right corner: 22 px on a 72 px key, 29 on a 96 px
 * one. The maintainer looked at both on the decks (2026-09-18): the X reads at 72.
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
