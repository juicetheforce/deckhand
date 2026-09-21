/**
 * Chrome icons for the editor's own controls.
 *
 * These are **not** the built-in deck icons in `assets/icons/`. Those are
 * resolved by name by the daemon (`src/builtin-icons.ts`), shipped with the app
 * and drawn on the hardware; these are part of the editor's interface and never
 * reach a key or `config.json`. Keeping them apart stops an editor glyph
 * looking like something the daemon could draw.
 *
 * Inline rather than files loaded through Vite, so they can take
 * `currentColor`: a toolbar control has to dim when it is disabled and brighten
 * on hover, which an `<img>` cannot do.
 */

/**
 * The pencil, from `edit.svg` in the design mockups.
 *
 * Drawn as in the mockup, with one deliberate change: the source hard-codes the
 * periwinkle `#8f9cf0`, and this takes `currentColor` instead. A fixed colour
 * would stay bright while the button is disabled — which it is whenever editing
 * is blocked — and that would be a lie about whether it can be clicked.
 */
export function EditIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The pencil body, with the mockup's translucent fill. */}
      <path d="M14.5 5.5 L18.5 9.5 L9 19 H5 V15 Z" fill="currentColor" fillOpacity={0.18} />
      {/* The ferrule. */}
      <path d="M12.8 7.2 L16.8 11.2" />
      {/* The line being written on. */}
      <path d="M5 22 H19" opacity={0.45} />
    </svg>
  );
}
