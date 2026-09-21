/**
 * All human-readable key naming lives here. The C helper only ever sees
 * numeric evdev keycodes, which is why it never has to change.
 *
 * Codes are from linux/input-event-codes.h.
 */

export const KEYS: Record<string, number> = {
  esc: 1, escape: 1,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, '-': 12,
  equal: 13, '=': 13,
  backspace: 14,
  tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  leftbrace: 26, '[': 26,
  rightbrace: 27, ']': 27,
  enter: 28, return: 28,
  ctrl: 29, leftctrl: 29, lctrl: 29, control: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  semicolon: 39, ';': 39,
  apostrophe: 40, "'": 40,
  grave: 41, '`': 41,
  shift: 42, leftshift: 42, lshift: 42,
  backslash: 43, '\\': 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51, ',': 51,
  dot: 52, period: 52, '.': 52,
  slash: 53, '/': 53,
  rightshift: 54, rshift: 54,
  kpasterisk: 55,
  alt: 56, leftalt: 56, lalt: 56,
  space: 57,
  capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  numlock: 69, scrolllock: 70,
  kp7: 71, kp8: 72, kp9: 73, kpminus: 74,
  kp4: 75, kp5: 76, kp6: 77, kpplus: 78,
  kp1: 79, kp2: 80, kp3: 81, kp0: 82, kpdot: 83,
  f11: 87, f12: 88,
  kpenter: 96,
  rightctrl: 97, rctrl: 97,
  kpslash: 98,
  sysrq: 99, printscreen: 99, print: 99,
  rightalt: 100, ralt: 100, altgr: 100,
  home: 102, up: 103, pageup: 104, pgup: 104,
  left: 105, right: 106, end: 107,
  down: 108, pagedown: 109, pgdn: 109,
  insert: 110, delete: 111, del: 111,
  mute: 113, volumedown: 114, volumeup: 115,
  pause: 119,
  meta: 125, leftmeta: 125, super: 125, win: 125, lmeta: 125,
  rightmeta: 126, rmeta: 126,
  compose: 127, menu: 127,
  nextsong: 163, next: 163,
  playpause: 164, play: 164,
  previoussong: 165, previous: 165, prev: 165,
  stopcd: 166, stop: 166,
  f13: 183, f14: 184, f15: 185, f16: 186, f17: 187, f18: 188,
  f19: 189, f20: 190, f21: 191, f22: 192, f23: 193, f24: 194,
};

/**
 * Parse a combo like "ctrl+alt+3" or "shift+F13" into evdev codes.
 * Order is preserved, so modifiers should be written first.
 */
export function parseCombo(combo: string): number[] {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // A single trailing "+" ("ctrl+") adds the =/+ key, unshifted: ctrl+=.
  // "ctrl++" is not special-cased — its empty parts are dropped, leaving a
  // bare Ctrl. The editor refuses both forms (editor/test/keys.test.ts).
  if (combo.trim().endsWith('+') && !combo.trim().endsWith('++')) {
    parts.push('=');
  }

  if (parts.length === 0) throw new Error(`empty key combo: "${combo}"`);

  return parts.map((part) => {
    const code = KEYS[part.toLowerCase()];
    if (code === undefined) {
      throw new Error(`unknown key "${part}" in combo "${combo}"`);
    }
    return code;
  });
}

/** US-layout ASCII characters that need shift held. */
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']',
  ':': ';', '"': "'", '~': '`', '|': '\\', '<': ',', '>': '.', '?': '/',
};

/**
 * Convert a string into a sequence of tap actions. Assumes a US layout.
 */
export function textToTaps(text: string): number[][] {
  const taps: number[][] = [];
  for (const ch of text) {
    if (ch === '\n') {
      taps.push([KEYS.enter]);
      continue;
    }
    if (ch === '\t') {
      taps.push([KEYS.tab]);
      continue;
    }
    if (ch === ' ') {
      taps.push([KEYS.space]);
      continue;
    }
    if (ch >= 'A' && ch <= 'Z') {
      taps.push([KEYS.leftshift, KEYS[ch.toLowerCase()]]);
      continue;
    }
    const shiftedBase = SHIFTED[ch];
    if (shiftedBase !== undefined) {
      taps.push([KEYS.leftshift, KEYS[shiftedBase]]);
      continue;
    }
    const code = KEYS[ch.toLowerCase()];
    if (code === undefined) {
      throw new Error(`cannot type character "${ch}" — not in the US-layout map`);
    }
    taps.push([code]);
  }
  return taps;
}
