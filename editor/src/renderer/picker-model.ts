/**
 * The icon picker's pure pieces: breadcrumb segments and moving through the
 * grid with the arrow keys. No DOM, so test/icon-picker.test.ts runs them in
 * Node.
 */

import { BUILTIN_FOLDER } from '../shared/icons.js';

export interface Crumb {
  /** What is shown: "~" for the home directory, then one folder name each. */
  label: string;
  /** The absolute folder this segment opens. */
  path: string;
}

/**
 * The open folder as clickable segments. `configPath` is the same folder as
 * the config would store it (~/... under home), so the renderer never needs
 * to know the home directory: when it starts with "~", the part of `path` it
 * replaces is the home directory and becomes one "~" segment.
 */
export function folderCrumbs(path: string, configPath: string): Crumb[] {
  // The pinned Built-in section is one place, with nothing above it.
  if (path === BUILTIN_FOLDER) return [{ label: 'Built-in', path }];
  const crumbs: Crumb[] = [];
  let rest = path;
  let base = '';
  if (configPath === '~' || configPath.startsWith('~/')) {
    const home = configPath === '~' ? path : path.slice(0, path.length - (configPath.length - 1));
    const homePath = home.endsWith('/') && home.length > 1 ? home.slice(0, -1) : home;
    crumbs.push({ label: '~', path: homePath });
    rest = path.slice(homePath.length);
    base = homePath;
  } else {
    crumbs.push({ label: '/', path: '/' });
  }
  for (const part of rest.split('/').filter((p) => p !== '')) {
    base = base === '/' || base === '' ? `/${part}` : `${base}/${part}`;
    crumbs.push({ label: part, path: base });
  }
  return crumbs;
}

/** The folder a file lives in. */
export function parentFolder(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash <= 0 ? '/' : filePath.slice(0, slash);
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * Where an arrow key moves the cursor in a grid of `count` items laid out in
 * `columns` columns. With nothing selected (`index` -1) any key goes to the
 * first item. Stops at the ends rather than wrapping.
 */
export function moveCursor(count: number, columns: number, index: number, key: GridKey): number {
  if (count === 0) return -1;
  if (index < 0 || index >= count) return 0;
  const cols = Math.max(1, columns);
  const step: Record<GridKey, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -count, End: count };
  const next = index + step[key];
  // Up or down past the edge of the grid stays put, instead of jumping to the first or last item.
  if ((key === 'ArrowUp' || key === 'ArrowDown') && (next < 0 || next >= count)) return index;
  return Math.min(count - 1, Math.max(0, next));
}

/** A breadcrumb with its middle elided, for a path too long for one fixed-height row. */
export interface ElidedCrumbs {
  crumbs: Crumb[];
  /** The segments left out, for the ellipsis's tooltip; empty when nothing was. */
  elided: string[];
}

/**
 * The breadcrumb field has a fixed height and cannot wrap, so a
 * deep path keeps its root and its last `tail` segments and drops the middle.
 * The folder you are in is always the last one.
 */
export function elideCrumbs(crumbs: Crumb[], tail = 2): ElidedCrumbs {
  if (crumbs.length <= tail + 1) return { crumbs, elided: [] };
  return {
    crumbs: [crumbs[0], ...crumbs.slice(-tail)],
    elided: crumbs.slice(1, -tail).map((c) => c.label),
  };
}

/**
 * What a bookmark chip says: **the folder's own name**, nothing else; the
 * full path made chips needlessly long, and is in the chip's tooltip.
 *
 * The accepted cost: two bookmarks whose folders share a name read the same,
 * as `dps/Job` and `healer/Job` both read "Job".
 */
export function bookmarkLabel(configPath: string, max = 18): string {
  const leaf = configPath.split('/').filter((p) => p !== '').at(-1) ?? configPath;
  return leaf.length > max ? `${leaf.slice(0, max - 1)}…` : leaf;
}

