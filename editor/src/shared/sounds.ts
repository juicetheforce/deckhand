/**
 * What the sound picker lists: the files Play sound can play — what libsndfile,
 * behind both pw-play and paplay, reads. By extension only: a sound is never
 * read by the editor, so there is nothing to sniff. No Node imports: the
 * renderer uses this module.
 */
export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac'] as const;

export function isSoundFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && (SOUND_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}
