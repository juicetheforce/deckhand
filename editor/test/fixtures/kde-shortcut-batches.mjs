// Combos measured once against KDE Plasma's global shortcuts, by injecting
// each and watching whether a focused window received it; each batch's title
// says what it holds. Data for the real-KDE part of
// test/system-shortcuts.test.ts (DECKHAND_TEST_REAL_KGLOBALACCEL=1), which
// records which of them KDE grabbed.

const DIGITS_ETC = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const F1_12 = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
const F13_24 = Array.from({ length: 12 }, (_, i) => `f${i + 13}`);

export const BATCHES = {
  1: {
    title: 'Batch 1 — combos KDE does not bind',
    confirmEach: false,
    combos: [
      ...['ctrl', 'shift', 'alt', 'ctrl+shift'].flatMap((mod) => DIGITS_ETC.map((k) => `${mod}+${k}`)),
      ...F1_12,
      ...F1_12.map((f) => `shift+${f}`),
      ...['f5', 'f6', 'f8', 'f11'].map((f) => `ctrl+${f}`),
      ...['f2', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'].map((f) => `alt+${f}`),
      ...F13_24,
    ],
  },
  2: {
    title: "Batch 2 — Electron's default menu shortcuts, with the menu removed",
    confirmEach: false,
    // ctrl+q last: if anything still quits the app, it should be the last thing.
    combos: ['ctrl+w', 'ctrl+r', 'ctrl+shift+r', 'ctrl+shift+i', 'f11', 'alt', 'ctrl+q'],
  },
  3: {
    title: 'Batch 3 — KDE binds these, focus should stay here',
    confirmEach: false,
    restoreAudio: true,
    combos: [
      'ctrl+f1', 'ctrl+f2', 'ctrl+f3', 'ctrl+f4',
      'meta+shift+esc',
      'alt+`',
      // desktop zoom in, out, then reset to actual size
      'meta+=', 'meta+-', 'meta+0',
      // twice each, so they end where they started (volume is restored exactly after)
      'mute', 'mute', 'volumeup', 'volumedown',
      'playpause', 'playpause',
    ],
  },
  4: {
    title: 'Batch 4 — KDE binds these and they move focus; one at a time',
    confirmEach: true,
    combos: [
      'ctrl+f7', 'ctrl+f9', 'ctrl+f10', 'ctrl+f12',
      'alt+tab', 'alt+shift+tab', 'alt+f1', 'alt+f3',
      'meta+d', 'meta+w', 'meta+g', 'meta+q', 'meta+a', 'meta+v', 'meta+t', 'meta+1',
      'meta+up', 'meta+down', 'meta+left', 'meta+right', 'meta+pgup', 'meta+pgdn',
      'meta',
    ],
  },
};

// KeyboardEvent.code for the final key of each combo above. The daemon's
// keymap.ts names evdev keys; this maps those names to what Chromium reports.
const DOM_CODE = {
  '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  esc: 'Escape', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown',
  mute: 'AudioVolumeMute', volumeup: 'AudioVolumeUp', volumedown: 'AudioVolumeDown', playpause: 'MediaPlayPause',
  ctrl: 'ControlLeft', shift: 'ShiftLeft', alt: 'AltLeft', meta: 'MetaLeft',
};

const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];

/** What a combo should look like if it arrives intact. */
export function expectationFor(combo) {
  const parts = combo.split('+').map((p) => (p === '' ? '+' : p));
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  let code = DOM_CODE[key];
  if (!code && /^[0-9]$/.test(key)) code = `Digit${key}`;
  if (!code && /^[a-z]$/.test(key)) code = `Key${key.toUpperCase()}`;
  if (!code && /^f[0-9]+$/.test(key)) code = key.toUpperCase();
  if (!code) throw new Error(`no DOM code known for "${key}" in "${combo}"`);
  const bareModifier = modifiers.length === 0 && MODIFIERS.includes(key);
  return { code, modifiers: bareModifier ? [key] : modifiers };
}
