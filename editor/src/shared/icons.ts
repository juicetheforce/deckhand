/** The scheme main serves icon files on (src/main/icon-protocol.ts). Import-free: the renderer uses it. */
export const ICON_SCHEME = 'deckhand-icon';

/** The URL the renderer uses to show an icon path from the config. */
export function iconUrl(configPath: string): string {
  return `${ICON_SCHEME}://icon/?path=${encodeURIComponent(configPath)}`;
}
