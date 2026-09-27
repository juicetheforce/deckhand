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
 * The pencil.
 *
 * Drawn with `currentColor` rather than a fixed colour: a fixed colour would
 * stay bright while the button is disabled — which it is whenever editing is
 * blocked — and that would be a lie about whether it can be clicked.
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
      {/* The pencil body, with a translucent fill. */}
      <path d="M14.5 5.5 L18.5 9.5 L9 19 H5 V15 Z" fill="currentColor" fillOpacity={0.18} />
      {/* The ferrule. */}
      <path d="M12.8 7.2 L16.8 11.2" />
      {/* The line being written on. */}
      <path d="M5 22 H19" opacity={0.45} />
    </svg>
  );
}

/**
 * The padlock on a deck's header on the canvas: shut when the deck is
 * locked in place, open when it can be dragged.
 */
export function LockIcon({ locked, size = 14 }: { locked: boolean; size?: number }) {
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
      <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" fillOpacity={locked ? 0.35 : 0.12} />
      {/* The shackle: closed into the body, or swung open. */}
      <path d={locked ? 'M8 11 V8 a4 4 0 0 1 8 0 V11' : 'M8 11 V8 a4 4 0 0 1 7.6 -1.8'} />
    </svg>
  );
}
