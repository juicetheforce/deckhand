import { useEffect, useState } from 'react';
import { refusalText, sideRefusal } from '../../../src/image-limits.js';
import { iconUrl } from '../shared/icons.js';

/**
 * The image limits (src/image-limits.ts) for an image the editor shows on a
 * deck's page — a page's background: the file half asked of the main process
 * (window.deckhand.checkImage, the same rule as every icon), the pixel size
 * read from the image itself as it loads. A refused image says why, in the
 * same words the daemon logs; the editor draws it as the deck does, without
 * it. Each answer is kept per path and stamp, so a file changed on disk is
 * checked again.
 */
export type ImageVerdict = { state: 'ok'; width: number; height: number } | { state: 'refused'; message: string };

const verdicts = new Map<string, Promise<ImageVerdict>>();

export function checkImage(path: string, stamp?: string): Promise<ImageVerdict> {
  const key = `${path}\n${stamp ?? ''}`;
  let verdict = verdicts.get(key);
  if (!verdict) {
    verdict = judge(path, stamp);
    verdicts.set(key, verdict);
  }
  return verdict;
}

async function judge(path: string, stamp?: string): Promise<ImageVerdict> {
  const refusal = await window.deckhand.checkImage(path).catch(() => ({ kind: 'unreadable' as const }));
  if (refusal) return { state: 'refused', message: refusalText(path, refusal) };
  const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = iconUrl(path, stamp);
  });
  if (!size) return { state: 'refused', message: refusalText(path, { kind: 'not-an-image' }) };
  const side = sideRefusal(size.width, size.height);
  return side ? { state: 'refused', message: refusalText(path, side) } : { state: 'ok', ...size };
}

/** The verdict on an image, or null while it is being checked (or there is none). */
export function useImageCheck(path: string | null, stamp?: string): ImageVerdict | null {
  const [verdict, setVerdict] = useState<{ key: string; verdict: ImageVerdict } | null>(null);
  const key = path === null ? null : `${path}\n${stamp ?? ''}`;
  useEffect(() => {
    if (path === null) return;
    let current = true;
    void checkImage(path, stamp).then((v) => {
      if (current) setVerdict({ key: `${path}\n${stamp ?? ''}`, verdict: v });
    });
    return () => {
      current = false;
    };
  }, [key]);
  return key !== null && verdict?.key === key ? verdict.verdict : null;
}
