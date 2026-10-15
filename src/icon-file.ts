import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './backups.js';
import { ICON_CONTENT_TYPES, iconExtension, isShownIcon, sniffIconType } from './icon-types.js';

/**
 * Reading an icon file: the one rule for every place that does — the daemon's
 * renderer, the editor's icon protocol and its export. A config's icon path
 * can name any file (hand-written, or imported from someone else's bundle),
 * so before anything is read:
 *
 * - **a regular file**: a device such as /dev/zero, or a FIFO, never ends,
 *   and reading one hung the reader;
 * - **at most MAX_ICON_BYTES**;
 * - **never under Deckhand's state directory**, after following links:
 *   credentials.json lives there, and an icon naming it would be exported
 *   with its tokens inside. Nothing there is an icon;
 * - for the editor and the export, **an image**: one of the shown extensions,
 *   or first bytes that are one of those formats (app icons without an
 *   extension). The daemon leaves the type to sharp, which draws more formats
 *   than Chromium shows and refuses anything that is not an image.
 */

export const MAX_ICON_BYTES = 10 * 1024 * 1024;

export type IconRefusal = 'not found' | 'not a file' | 'too large' | 'not an image' | "in Deckhand's state directory" | 'cannot be read';

export class IconFileError extends Error {
  constructor(
    readonly reason: IconRefusal,
    readonly filePath: string,
  ) {
    super(reason);
  }
}

/** Where a path really leads, links followed; the path itself if it does not exist yet. */
async function real(filePath: string): Promise<string> {
  return fs.realpath(filePath).catch(() => path.resolve(filePath));
}

/** Whether a path is in Deckhand's state directory, after following links on both. */
export async function isInStateDir(filePath: string): Promise<boolean> {
  const [file, dir] = await Promise.all([real(filePath), real(STATE_DIR)]);
  return file === dir || file.startsWith(dir + path.sep);
}

/**
 * Check an icon file without reading it: found, a regular file, small enough,
 * not in the state directory. Throws IconFileError; returns its size.
 */
export async function checkIconFile(filePath: string): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new IconFileError(code === 'ENOENT' || code === 'ENOTDIR' ? 'not found' : 'cannot be read', filePath);
  }
  if (!stat.isFile()) throw new IconFileError('not a file', filePath);
  if (stat.size > MAX_ICON_BYTES) throw new IconFileError('too large', filePath);
  if (await isInStateDir(filePath)) throw new IconFileError("in Deckhand's state directory", filePath);
  return stat.size;
}

/**
 * Read an icon file under the rule above. With `image`, it must also be an
 * image the editor shows, and its content type is returned; without, the type
 * is left to whoever decodes it (the daemon's sharp), and is null.
 */
export async function readIconFile(filePath: string, options: { image: boolean }): Promise<{ data: Buffer; type: string | null }> {
  await checkIconFile(filePath);
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    throw new IconFileError('cannot be read', filePath);
  }
  // Checked again on what was read: the file may have grown since the stat.
  if (data.length > MAX_ICON_BYTES) throw new IconFileError('too large', filePath);
  if (!options.image) return { data, type: null };
  const type = isShownIcon(filePath) ? ICON_CONTENT_TYPES[iconExtension(filePath)] : sniffIconType(data);
  if (!type) throw new IconFileError('not an image', filePath);
  return { data, type };
}
