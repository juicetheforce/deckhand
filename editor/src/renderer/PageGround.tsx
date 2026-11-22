import type { CSSProperties } from 'react';
import { backgroundOf } from '../../../src/background-def.js';
import type { PageBackgroundDef } from '../../../src/types.js';
import { iconUrl } from '../shared/icons.js';
import { useImageCheck } from './image-check.js';

/**
 * A virtual deck page's background as the editor draws it, behind its keys,
 * over the whole screen (24a, 24b): the colour, the image as Fill or Fit, at
 * the page's opacity. Below 100%, a checker shows through where the real
 * screen would show what is behind it — the checker is the editor's only,
 * never drawn on the deck. An image the limits refuse is left out, as the
 * deck leaves it out.
 *
 * `inset`: how far the screen reaches beyond the box this is drawn in, in
 * pixels either side — a layout made for another screen size sits centred in
 * a screen larger than itself.
 */
export function PageGround({ background, stamp, inset }: { background: PageBackgroundDef | undefined; stamp?: string; inset?: { x: number; y: number } }) {
  const b = backgroundOf(background);
  const verdict = useImageCheck(b.image, stamp);
  const image = b.image !== null && verdict?.state === 'ok' ? b.image : null;
  const style: CSSProperties = inset && (inset.x > 0 || inset.y > 0) ? { inset: `${-inset.y}px ${-inset.x}px` } : {};
  return (
    <div
      className="page-ground"
      aria-hidden="true"
      style={style}
      data-page-ground=""
      data-ground-color={b.color.toLowerCase()}
      data-ground-opacity={b.opacity}
      data-ground-fit={b.fit}
      data-ground-image={image ?? ''}
    >
      {b.opacity < 100 && <div className="page-ground-checker" />}
      <div
        className="page-ground-layer"
        style={{
          backgroundColor: b.color,
          backgroundImage: image ? `url("${iconUrl(image, stamp)}")` : undefined,
          backgroundSize: b.fit === 'fit' ? 'contain' : 'cover',
          opacity: b.opacity / 100,
        }}
      />
    </div>
  );
}
