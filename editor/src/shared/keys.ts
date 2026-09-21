/**
 * Key naming for hotkey capture and "Type manually".
 * Import-free apart from the daemon's own keymap, which has no imports: the
 * renderer uses this.
 *
 * Capture reads KeyboardEvent.code, never KeyboardEvent.key. The helper sends
 * physical evdev keycodes, and `code` names the physical key; `key` names the
 * character the layout produces, so shift+1 would arrive as "!" and a
 * non-US layout would record the wrong key.
 *
 * Every name written here is one the daemon's parseCombo() accepts, and each
 * evdev code has exactly one name the editor writes (checked by
 * test/keys.test.ts against the daemon's KEYS table).
 */
import { KEYS, parseCombo } from '../../../src/keymap.js';

/** KeyboardEvent.code → the daemon key name the editor writes. */
export const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Escape: 'esc',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
  Minus: '-', Equal: '=', Backspace: 'backspace', Tab: 'tab',
  KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u', KeyI: 'i', KeyO: 'o', KeyP: 'p',
  BracketLeft: '[', BracketRight: ']', Enter: 'enter',
  KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
  // "backslash" rather than "\", which JSON would write as "\\".
  Semicolon: ';', Quote: "'", Backquote: '`', Backslash: 'backslash',
  KeyZ: 'z', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm',
  Comma: ',', Period: '.', Slash: '/', Space: 'space', CapsLock: 'capslock',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6', F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
  F13: 'f13', F14: 'f14', F15: 'f15', F16: 'f16', F17: 'f17', F18: 'f18', F19: 'f19', F20: 'f20', F21: 'f21', F22: 'f22', F23: 'f23', F24: 'f24',
  NumLock: 'numlock', ScrollLock: 'scrolllock',
  Numpad0: 'kp0', Numpad1: 'kp1', Numpad2: 'kp2', Numpad3: 'kp3', Numpad4: 'kp4',
  Numpad5: 'kp5', Numpad6: 'kp6', Numpad7: 'kp7', Numpad8: 'kp8', Numpad9: 'kp9',
  NumpadMultiply: 'kpasterisk', NumpadSubtract: 'kpminus', NumpadAdd: 'kpplus', NumpadDecimal: 'kpdot',
  NumpadEnter: 'kpenter', NumpadDivide: 'kpslash',
  PrintScreen: 'print', Pause: 'pause', ContextMenu: 'menu',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  AudioVolumeMute: 'mute', AudioVolumeDown: 'volumedown', AudioVolumeUp: 'volumeup',
  MediaTrackNext: 'next', MediaPlayPause: 'playpause', MediaTrackPrevious: 'previous', MediaStop: 'stop',
  ControlLeft: 'ctrl', ShiftLeft: 'shift', AltLeft: 'alt', MetaLeft: 'meta',
  ControlRight: 'rightctrl', ShiftRight: 'rightshift', AltRight: 'rightalt', MetaRight: 'rightmeta',
};

export type Modifier = 'ctrl' | 'shift' | 'alt' | 'meta';

/** Order modifiers are written in. */
export const MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'shift', 'alt', 'meta'];

/** Codes of the modifier keys themselves, left and right. */
export const MODIFIER_CODES: Readonly<Record<string, Modifier>> = {
  ControlLeft: 'ctrl', ControlRight: 'ctrl',
  ShiftLeft: 'shift', ShiftRight: 'shift',
  AltLeft: 'alt', AltRight: 'alt',
  MetaLeft: 'meta', MetaRight: 'meta',
};

/** evdev code → the one name the editor writes for it. */
const NAME_BY_EVDEV: ReadonlyMap<number, string> = new Map(Object.values(CODE_TO_KEY).map((name) => [KEYS[name], name]));

/** The evdev codes of the four modifiers' names, left and right. */
const MODIFIER_BY_EVDEV: ReadonlyMap<number, Modifier> = new Map([
  [KEYS.ctrl, 'ctrl'], [KEYS.rightctrl, 'ctrl'],
  [KEYS.shift, 'shift'], [KEYS.rightshift, 'shift'],
  [KEYS.alt, 'alt'], [KEYS.rightalt, 'alt'],
  [KEYS.meta, 'meta'], [KEYS.rightmeta, 'meta'],
]);

export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type Captured =
  /** A complete combo, in the editor's spelling. */
  | { kind: 'combo'; combo: string }
  /** A modifier on its own: keep listening. */
  | { kind: 'modifier'; modifier: Modifier }
  /** A key the daemon has no name for (e.g. IntlBackslash): use Type manually. */
  | { kind: 'unknown'; code: string };

/**
 * Turn a keydown into a combo. Modifiers come from the flags on the
 * non-modifier key — confirmed for Meta with physical key presses; only a modifier's own keydown may lack its flag, which is why a
 * modifier on its own is reported by code. A right-hand modifier used as a
 * modifier is written as the left-hand name ("ctrl+1"), which is what a game
 * binding means.
 */
export function captureKey(event: KeyEventLike): Captured {
  const modifier = Object.prototype.hasOwnProperty.call(MODIFIER_CODES, event.code) ? MODIFIER_CODES[event.code] : undefined;
  if (modifier) return { kind: 'modifier', modifier };
  const key = Object.prototype.hasOwnProperty.call(CODE_TO_KEY, event.code) ? CODE_TO_KEY[event.code] : undefined;
  if (!key) return { kind: 'unknown', code: event.code };
  const held: Modifier[] = [];
  if (event.ctrlKey) held.push('ctrl');
  if (event.shiftKey) held.push('shift');
  if (event.altKey) held.push('alt');
  if (event.metaKey) held.push('meta');
  return { kind: 'combo', combo: [...held, key].join('+') };
}

/**
 * A typed combo in the editor's spelling: names as the daemon's parseCombo()
 * reads them, each written with its one canonical name, modifiers first in a
 * fixed order and other keys in the order typed. Throws the daemon's own
 * message for anything it would refuse.
 */
export function canonicalCombo(text: string): string {
  // The daemon reads an empty part oddly: "ctrl++" as a bare Ctrl, "ctrl+" as
  // ctrl+= (src/keymap.ts parseCombo; test/keys.test.ts checks it). So an
  // empty part is refused here rather than saved as something unintended.
  if (text.trim() !== '' && text.split('+').some((part) => part.trim() === '')) {
    throw new Error('a key name is missing between "+" signs — for the + key, write "=" (+ is shift+= on a US layout)');
  }
  const codes = parseCombo(text);
  const modifiers: Array<{ modifier: Modifier; name: string }> = [];
  const others: string[] = [];
  codes.forEach((code, i) => {
    const name = NAME_BY_EVDEV.get(code);
    if (name === undefined) throw new Error(`no name for key code ${code}`);
    const modifier = MODIFIER_BY_EVDEV.get(code);
    // A modifier that is the last key is the key being pressed ("ctrl" alone), not a modifier.
    if (modifier && i < codes.length - 1) modifiers.push({ modifier, name });
    else others.push(name);
  });
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a.modifier) - MODIFIER_ORDER.indexOf(b.modifier));
  return [...modifiers.map((m) => m.name), ...others].join('+');
}

/**
 * The combo for modifier keys pressed and let go with no other key in between,
 * given their `KeyboardEvent.code`s in the order pressed: a lone Left Shift is
 * `shift`, a lone Right Shift `rightshift`, Ctrl then Shift `ctrl+shift`.
 * Null if any code is not a modifier key.
 *
 * For Press/Release, where holding a modifier on its own is a real binding.
 * Hotkey capture does not use
 * it: there a modifier going down is the start of a combo, not the combo.
 */
export function loneModifierCombo(codes: readonly string[]): string | null {
  if (codes.length === 0) return null;
  if (!codes.every((code) => Object.prototype.hasOwnProperty.call(MODIFIER_CODES, code))) return null;
  // In the fixed modifier order, so the spelling does not depend on which went
  // down first (canonicalCombo keeps the last name last, as the key pressed).
  const ordered = [...codes].sort((a, b) => MODIFIER_ORDER.indexOf(MODIFIER_CODES[a]) - MODIFIER_ORDER.indexOf(MODIFIER_CODES[b]));
  return canonicalCombo(ordered.map((code) => CODE_TO_KEY[code]).join('+'));
}

/** Keycap labels for showing a combo: "ctrl+shift+1" → ["Ctrl", "Shift", "1"]. */
export function keycaps(combo: string): string[] {
  const LABELS: Record<string, string> = {
    ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta',
    rightctrl: 'Right Ctrl', rightshift: 'Right Shift', rightalt: 'Right Alt', rightmeta: 'Right Meta',
    esc: 'Esc', space: 'Space', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', backslash: '\\',
    up: '↑', down: '↓', left: '←', right: '→', pageup: 'PgUp', pagedown: 'PgDn',
  };
  return combo
    .split(/\+(?!$)/)
    .map((part) => LABELS[part] ?? (/^f\d+$/.test(part) ? part.toUpperCase() : part.length === 1 ? part.toUpperCase() : part));
}

/**
 * Keys the standard XKB layout turns into other keys before KDE sees them
 * (per /usr/share/X11/xkb/symbols/inet). A lookup of
 * KDE shortcuts cannot see these, so they get a fixed note instead.
 */
export const LAYOUT_REMAPPED_KEYS: ReadonlySet<string> = new Set(['f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f20', 'f21', 'f22', 'f23']);
