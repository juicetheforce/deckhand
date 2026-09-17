/**
 * The action library (docs/scope.md §6, §10): the whole catalogue, grouped,
 * so an action is visible to someone who does not know it exists (§2).
 * Every type here is checked against the daemon's registry by
 * test/renderer-model.test.ts.
 *
 * `editable` is what the inspector can configure so far: every type with a
 * form (model.ts `hasForm`, which a test holds this to). Phase A: hotkey;
 * phase B: page and profile; phase C2 the rest, piece by piece (§7).
 */

import { defaultIconFor, type BuiltinIcon } from '../../../src/default-icons.js';

export interface CatalogueEntry {
  type: string;
  name: string;
  description: string;
  editable: boolean;
  /**
   * Why there is no inspector yet, for the tooltip on a greyed entry. Shown
   * rather than hidden (the maintainer, 2026-09-16): an action you know exists but
   * cannot see reads as broken, whereas greyed and explained reads as pending
   * — the same reasoning as showing unrenderable files in the icon picker.
   *
   * - 'daemon': blocked on phase C1 daemon work, not just an inspector.
   * - 'inspector': the action works today if written into config.json by
   *   hand; only the editor's form is missing (phase C2).
   */
  pending?: 'daemon' | 'inspector';
  /**
   * Extra words the search box matches, beyond the name and description
   * (the maintainer, 2026-09-16). §2's discoverability point applied to search: someone
   * looking for `audio.sink` types "headphones" or "output", not the name the
   * daemon uses. Only terms the name and description do not already contain
   * are listed — "Switch the default output" already answers "output".
   *
   * Deliberate overlaps, approved by the maintainer: "headphones"/"speakers" hit three
   * audio actions, "macro" hits Type text and Multi action, "mute" hits both
   * mute keys. Ambiguous words should find every action they could mean. No
   * media player names: they date, and go wrong when the player changes.
   * Aliases match but are not drawn on the row, which keeps it legible.
   */
  aliases?: readonly string[];
}

/** The tooltip for an entry with no inspector. */
export function pendingReason(entry: CatalogueEntry): string {
  if (entry.pending === 'daemon') {
    return 'Needs daemon work before it can be configured here (phase C1). It is not usable by hand yet either.';
  }
  return 'Works today if you write it into config.json by hand — only the editor form is missing (phase C).';
}

export interface CatalogueGroup {
  name: string;
  /** Colour family from the mockups: navigation amber, media green. */
  tone: 'accent' | 'navigation' | 'media' | 'neutral';
  entries: CatalogueEntry[];
}

export const CATALOGUE: CatalogueGroup[] = [
  {
    name: 'Keyboard',
    tone: 'accent',
    entries: [
      { type: 'hotkey', name: 'Hotkey', description: 'Send a key combo to the focused window', editable: true, aliases: ['keys', 'shortcut', 'keybind', 'bind', 'keypress'] },
      { type: 'text', name: 'Type text', description: 'Type a string, US layout', editable: false, pending: 'inspector', aliases: ['phrase', 'paste', 'autotype', 'macro'] },
      { type: 'keyHold', name: 'Press / Release', description: 'Hold a key while the deck key is held', editable: false, pending: 'inspector', aliases: ['momentary', 'ptt', 'push to talk'] },
      { type: 'multi', name: 'Multi action', description: 'Several actions in order, with delays', editable: false, pending: 'inspector', aliases: ['sequence', 'steps', 'chain', 'macro', 'series'] },
    ],
  },
  {
    name: 'Navigation',
    tone: 'navigation',
    entries: [
      { type: 'page', name: 'Go to page', description: 'Show another page on this deck, or go back', editable: true, aliases: ['navigate', 'navigation', 'folder', 'menu', 'forward'] },
      { type: 'profile', name: 'Switch profile', description: 'Change what every deck shows at once', editable: true, aliases: ['layout', 'mode', 'game', 'set'] },
    ],
  },
  {
    name: 'Media',
    tone: 'media',
    entries: [
      { type: 'media.control', name: 'Media control', description: 'Play/pause, next, previous', editable: true, aliases: ['skip', 'track', 'transport', 'music'] },
      { type: 'media.info', name: 'Now playing', description: 'Track and album art on the key', editable: true, aliases: ['song', 'artist', 'music'] },
    ],
  },
  {
    name: 'Audio',
    tone: 'neutral',
    entries: [
      { type: 'audio.sink', name: 'Output device', description: 'Switch the default output', editable: false, pending: 'inspector', aliases: ['speakers', 'headphones', 'headset', 'sound', 'sink', 'playback'] },
      { type: 'audio.cycle', name: 'Cycle outputs', description: 'Step through a list of outputs', editable: false, pending: 'inspector', aliases: ['swap', 'headphones', 'speakers', 'next output'] },
      { type: 'audio.source', name: 'Input device', description: 'Switch the default input', editable: false, pending: 'inspector', aliases: ['microphone', 'mic', 'headset', 'recording', 'source', 'capture'] },
      { type: 'audio.micMute', name: 'Mic mute', description: 'Toggle the default input, shown on the key', editable: true, aliases: ['microphone', 'unmute', 'talk'] },
      { type: 'audio.volume', name: 'Volume', description: 'Nudge the output volume', editable: true, aliases: ['louder', 'quieter', 'gain'] },
      { type: 'audio.mute', name: 'Mute output', description: 'Toggle output mute, shown on the key', editable: true, aliases: ['silence', 'speakers'] },
    ],
  },
  {
    name: 'System',
    tone: 'neutral',
    entries: [
      { type: 'command', name: 'Run command', description: 'Start a program or shell command', editable: false, pending: 'inspector', aliases: ['launch', 'execute', 'exec', 'script', 'app', 'open'] },
      { type: 'brightness', name: 'Brightness', description: "Set or nudge this deck's brightness", editable: true, aliases: ['dim', 'backlight', 'screen'] },
      { type: 'clock', name: 'Clock', description: 'The time on the key', editable: true, aliases: ['watch', 'hour', 'date'] },
      { type: 'noop', name: 'Nothing', description: 'A key that does nothing', editable: true, aliases: ['blank', 'empty', 'spacer', 'none', 'placeholder'] },
    ],
  },
];

/**
 * Entries matching a search, with their group. Matches the name, the
 * description and the aliases, and **ignores whether the group is collapsed**
 * (the maintainer, 2026-09-16): collapsing everything to keep the library tidy must make
 * search more useful, not break it. An empty query matches nothing here — the
 * caller shows the ordinary grouped list instead, restoring the collapse state
 * the user had.
 */
export function searchCatalogue(query: string): Array<{ group: CatalogueGroup; entry: CatalogueEntry }> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const found: Array<{ group: CatalogueGroup; entry: CatalogueEntry }> = [];
  for (const group of CATALOGUE) {
    for (const entry of group.entries) {
      const haystack = [entry.name, entry.description, ...(entry.aliases ?? [])];
      if (haystack.some((term) => term.toLowerCase().includes(needle))) found.push({ group, entry });
    }
  }
  return found;
}

/**
 * The icon a library row shows (scope §10: the library shows each action's
 * default icon). The deck's own default, for a representative setting where
 * the default depends on one — Go to page shows `forward`, Brightness
 * `brightness-up`. Two library-side exceptions (docs/code-state.md, C2 notes):
 * Clock and Now playing show `clock` and `now-playing`, though on the deck their
 * face is the time or the track (§7 C1 call 4). Nothing has none: it is a spacer.
 */
export function libraryIcon(type: string): BuiltinIcon | null {
  if (type === 'clock') return 'clock';
  if (type === 'media.info') return 'now-playing';
  if (type === 'brightness') return defaultIconFor({ type, delta: 10 });
  return defaultIconFor({ type });
}

/** The catalogue name for an action type, or the type itself if it is not listed. */
export function actionName(type: string): string {
  for (const group of CATALOGUE) {
    const entry = group.entries.find((e) => e.type === type);
    if (entry) return entry.name;
  }
  return type;
}
