/**
 * The action library (docs/scope.md §6, §10): the whole catalogue, grouped,
 * so an action is visible to someone who does not know it exists (§2).
 * Every type here is checked against the daemon's registry by
 * test/renderer-model.test.ts.
 *
 * `editable` is what the inspector can configure so far. Phase A: hotkey
 * only; the rest arrive in phase C (§7). audio.source is decided but not built
 * in the daemon, so it is not listed.
 */

export interface CatalogueEntry {
  type: string;
  name: string;
  description: string;
  editable: boolean;
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
      { type: 'hotkey', name: 'Hotkey', description: 'Send a key combo to the focused window', editable: true },
      { type: 'text', name: 'Type text', description: 'Type a string, US layout', editable: false },
      { type: 'keyHold', name: 'Press / Release', description: 'Hold a key while the deck key is held', editable: false },
      { type: 'multi', name: 'Multi action', description: 'Several actions in order, with delays', editable: false },
    ],
  },
  {
    name: 'Navigation',
    tone: 'navigation',
    entries: [
      { type: 'page', name: 'Go to page', description: 'Show another page on this deck, or go back', editable: false },
      { type: 'profile', name: 'Switch profile', description: 'Change what every deck shows at once', editable: false },
    ],
  },
  {
    name: 'Media',
    tone: 'media',
    entries: [
      { type: 'media.control', name: 'Media control', description: 'Play/pause, next, previous', editable: false },
      { type: 'media.info', name: 'Now playing', description: 'Track and album art on the key', editable: false },
    ],
  },
  {
    name: 'Audio',
    tone: 'neutral',
    entries: [
      { type: 'audio.sink', name: 'Output device', description: 'Switch the default output', editable: false },
      { type: 'audio.cycle', name: 'Cycle outputs', description: 'Step through a list of outputs', editable: false },
      { type: 'audio.micMute', name: 'Mic mute', description: 'Toggle the default input, shown on the key', editable: false },
      { type: 'audio.volume', name: 'Volume', description: 'Nudge the output volume', editable: false },
      { type: 'audio.mute', name: 'Mute output', description: 'Toggle output mute', editable: false },
    ],
  },
  {
    name: 'System',
    tone: 'neutral',
    entries: [
      { type: 'command', name: 'Run command', description: 'Start a program or shell command', editable: false },
      { type: 'brightness', name: 'Brightness', description: "Set or nudge this deck's brightness", editable: false },
      { type: 'clock', name: 'Clock', description: 'The time on the key', editable: false },
      { type: 'noop', name: 'Nothing', description: 'A key that does nothing', editable: false },
    ],
  },
];

/** The catalogue name for an action type, or the type itself if it is not listed. */
export function actionName(type: string): string {
  for (const group of CATALOGUE) {
    const entry = group.entries.find((e) => e.type === type);
    if (entry) return entry.name;
  }
  return type;
}
