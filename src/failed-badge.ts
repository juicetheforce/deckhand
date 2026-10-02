/**
 * The key badges, failed and not set up, one set with the OBS icons:
 * drawn alike so they read as a pair in the same corner. The failed-key
 * badge: a red disc with a white X, with a dark ring so it holds over red
 * icons and bright album art. The one drawing of it:
 * the daemon rasterises it over a key's face (src/render.ts), and the editor's
 * grid inlines it over the same key, so the mirror matches the deck.
 *
 * Pure and import-free, so the editor can import it.
 *
 * 30% of the key, in its top-right corner: 22 px on a 72 px key, 29 on a 96 px
 * one. Its X is about 28% shorter than the earlier badge's, which was drawn
 * apart from the set; checked legible on a 72 px key.
 */

/** The badge's diameter and its inset from the key's top and right edges, for a key `size` pixels square. */
export function failedBadgePlacement(size: number): { diameter: number; inset: number } {
  return { diameter: Math.round(size * 0.3), inset: Math.round(size * 0.04) };
}

/** The badge as SVG text, `diameter` pixels square: `badge-failed.svg` from the icon set, as drawn. */
export function failedBadgeSvg(diameter: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="11" fill="#e0465c" stroke="#11121c" stroke-width="2"/>
  <path d="M8.2 8.2 L15.8 15.8 M15.8 8.2 L8.2 15.8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
}

/**
 * The not-set-up badge: a grey disc with a white plug, in the failed badge's
 * place, for a key whose integration (OBS) is not set up — drawn instead of
 * the failed badge, so the two are never confused. `badge-not-setup.svg`
 * from the icon set, as drawn; generic, so later integrations can reuse it.
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
