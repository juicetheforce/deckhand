import { execFile } from 'node:child_process';
import { KEYS } from '../../../src/keymap.js';
import type { SystemShortcut } from '../shared/bridge.js';

/**
 * Whether a combo is a KDE global shortcut (docs/scope.md §10): asked of
 * KDE's shortcut service over D-Bus, `org.kde.kglobalaccel`
 * `getGlobalShortcutsByKey`, through `busctl --user --json=short` — read-only.
 *
 * Two limits, recorded in scope §10: a miss does not mean the combo is safe
 * (Alt+F6 was grabbed in proof 0b and the service does not know it), and keys
 * the layout remaps (F13–F18, F20–F23) cannot be found this way at all.
 * Without KDE's service — another desktop, no busctl — every lookup is a miss.
 */

/** Qt::KeyboardModifier values (Qt 6.11.2 qnamespace.h). */
const QT_MODIFIER = {
  shift: ['ShiftModifier', 0x02000000],
  ctrl: ['ControlModifier', 0x04000000],
  alt: ['AltModifier', 0x08000000],
  meta: ['MetaModifier', 0x10000000],
  keypad: ['KeypadModifier', 0x20000000],
} as const;

type QtEntry = readonly [qtName: string, value: number, keypad?: 'keypad'];

/**
 * The editor's key names (src/shared/keys.ts) → Qt::Key. Each entry carries
 * the Qt enum name so test/system-shortcuts.test.ts can check every value
 * against Qt's qnamespace.h (fetched for the purpose, scope §10) rather than
 * trusting this table. Keypad keys are the plain key plus KeypadModifier.
 */
export const QT_KEYS: Readonly<Record<string, QtEntry>> = {
  esc: ['Key_Escape', 0x01000000], tab: ['Key_Tab', 0x01000001], backspace: ['Key_Backspace', 0x01000003],
  enter: ['Key_Return', 0x01000004], kpenter: ['Key_Enter', 0x01000005, 'keypad'],
  insert: ['Key_Insert', 0x01000006], delete: ['Key_Delete', 0x01000007], pause: ['Key_Pause', 0x01000008],
  print: ['Key_Print', 0x01000009], home: ['Key_Home', 0x01000010], end: ['Key_End', 0x01000011],
  left: ['Key_Left', 0x01000012], up: ['Key_Up', 0x01000013], right: ['Key_Right', 0x01000014], down: ['Key_Down', 0x01000015],
  pageup: ['Key_PageUp', 0x01000016], pagedown: ['Key_PageDown', 0x01000017],
  shift: ['Key_Shift', 0x01000020], ctrl: ['Key_Control', 0x01000021], meta: ['Key_Meta', 0x01000022], alt: ['Key_Alt', 0x01000023],
  rightshift: ['Key_Shift', 0x01000020], rightctrl: ['Key_Control', 0x01000021], rightmeta: ['Key_Meta', 0x01000022], rightalt: ['Key_Alt', 0x01000023],
  capslock: ['Key_CapsLock', 0x01000024], numlock: ['Key_NumLock', 0x01000025], scrolllock: ['Key_ScrollLock', 0x01000026],
  f1: ['Key_F1', 0x01000030], f2: ['Key_F2', 0x01000031], f3: ['Key_F3', 0x01000032], f4: ['Key_F4', 0x01000033],
  f5: ['Key_F5', 0x01000034], f6: ['Key_F6', 0x01000035], f7: ['Key_F7', 0x01000036], f8: ['Key_F8', 0x01000037],
  f9: ['Key_F9', 0x01000038], f10: ['Key_F10', 0x01000039], f11: ['Key_F11', 0x0100003a], f12: ['Key_F12', 0x0100003b],
  f13: ['Key_F13', 0x0100003c], f14: ['Key_F14', 0x0100003d], f15: ['Key_F15', 0x0100003e], f16: ['Key_F16', 0x0100003f],
  f17: ['Key_F17', 0x01000040], f18: ['Key_F18', 0x01000041], f19: ['Key_F19', 0x01000042], f20: ['Key_F20', 0x01000043],
  f21: ['Key_F21', 0x01000044], f22: ['Key_F22', 0x01000045], f23: ['Key_F23', 0x01000046], f24: ['Key_F24', 0x01000047],
  menu: ['Key_Menu', 0x01000055],
  volumedown: ['Key_VolumeDown', 0x01000070], mute: ['Key_VolumeMute', 0x01000071], volumeup: ['Key_VolumeUp', 0x01000072],
  playpause: ['Key_MediaPlay', 0x01000080], stop: ['Key_MediaStop', 0x01000081],
  previous: ['Key_MediaPrevious', 0x01000082], next: ['Key_MediaNext', 0x01000083],
  space: ['Key_Space', 0x20],
  "'": ['Key_Apostrophe', 0x27], ',': ['Key_Comma', 0x2c], '-': ['Key_Minus', 0x2d], '.': ['Key_Period', 0x2e], '/': ['Key_Slash', 0x2f],
  '0': ['Key_0', 0x30], '1': ['Key_1', 0x31], '2': ['Key_2', 0x32], '3': ['Key_3', 0x33], '4': ['Key_4', 0x34],
  '5': ['Key_5', 0x35], '6': ['Key_6', 0x36], '7': ['Key_7', 0x37], '8': ['Key_8', 0x38], '9': ['Key_9', 0x39],
  ';': ['Key_Semicolon', 0x3b], '=': ['Key_Equal', 0x3d],
  a: ['Key_A', 0x41], b: ['Key_B', 0x42], c: ['Key_C', 0x43], d: ['Key_D', 0x44], e: ['Key_E', 0x45], f: ['Key_F', 0x46],
  g: ['Key_G', 0x47], h: ['Key_H', 0x48], i: ['Key_I', 0x49], j: ['Key_J', 0x4a], k: ['Key_K', 0x4b], l: ['Key_L', 0x4c],
  m: ['Key_M', 0x4d], n: ['Key_N', 0x4e], o: ['Key_O', 0x4f], p: ['Key_P', 0x50], q: ['Key_Q', 0x51], r: ['Key_R', 0x52],
  s: ['Key_S', 0x53], t: ['Key_T', 0x54], u: ['Key_U', 0x55], v: ['Key_V', 0x56], w: ['Key_W', 0x57], x: ['Key_X', 0x58],
  y: ['Key_Y', 0x59], z: ['Key_Z', 0x5a],
  '[': ['Key_BracketLeft', 0x5b], backslash: ['Key_Backslash', 0x5c], ']': ['Key_BracketRight', 0x5d], '`': ['Key_QuoteLeft', 0x60],
  kp0: ['Key_0', 0x30, 'keypad'], kp1: ['Key_1', 0x31, 'keypad'], kp2: ['Key_2', 0x32, 'keypad'], kp3: ['Key_3', 0x33, 'keypad'],
  kp4: ['Key_4', 0x34, 'keypad'], kp5: ['Key_5', 0x35, 'keypad'], kp6: ['Key_6', 0x36, 'keypad'], kp7: ['Key_7', 0x37, 'keypad'],
  kp8: ['Key_8', 0x38, 'keypad'], kp9: ['Key_9', 0x39, 'keypad'],
  kpasterisk: ['Key_Asterisk', 0x2a, 'keypad'], kpplus: ['Key_Plus', 0x2b, 'keypad'], kpminus: ['Key_Minus', 0x2d, 'keypad'],
  kpdot: ['Key_Period', 0x2e, 'keypad'], kpslash: ['Key_Slash', 0x2f, 'keypad'],
};

/**
 * With Shift held, Qt can register a symbol key as the shifted character
 * (KDE shows "Alt+~" for Alt+Shift+`), so those are looked up too. US layout,
 * as textToTaps in the daemon assumes.
 */
export const QT_SHIFTED: Readonly<Record<string, QtEntry>> = {
  '1': ['Key_Exclam', 0x21], '2': ['Key_At', 0x40], '3': ['Key_NumberSign', 0x23], '4': ['Key_Dollar', 0x24],
  '5': ['Key_Percent', 0x25], '6': ['Key_AsciiCircum', 0x5e], '7': ['Key_Ampersand', 0x26], '8': ['Key_Asterisk', 0x2a],
  '9': ['Key_ParenLeft', 0x28], '0': ['Key_ParenRight', 0x29], '-': ['Key_Underscore', 0x5f], '=': ['Key_Plus', 0x2b],
  '[': ['Key_BraceLeft', 0x7b], ']': ['Key_BraceRight', 0x7d], ';': ['Key_Colon', 0x3a], "'": ['Key_QuoteDbl', 0x22],
  '`': ['Key_AsciiTilde', 0x7e], backslash: ['Key_Bar', 0x7c], ',': ['Key_Less', 0x3c], '.': ['Key_Greater', 0x3e], '/': ['Key_Question', 0x3f],
};

export { QT_MODIFIER };

const MODIFIER_OF: Record<string, keyof typeof QT_MODIFIER> = {
  ctrl: 'ctrl', rightctrl: 'ctrl', shift: 'shift', rightshift: 'shift', alt: 'alt', rightalt: 'alt', meta: 'meta', rightmeta: 'meta',
};

/**
 * The Qt key codes a combo (in the editor's spelling, one final key) could be
 * registered under. Empty for a combo Qt cannot describe, e.g. a sequence.
 */
export function qtCodesFor(combo: string): number[] {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((m) => !MODIFIER_OF[m]) || !Object.prototype.hasOwnProperty.call(QT_KEYS, key)) return [];
  let bits = 0;
  for (const m of modifiers) bits |= QT_MODIFIER[MODIFIER_OF[m]][1];
  const [, value, keypad] = QT_KEYS[key];
  const codes = [bits | value | (keypad ? QT_MODIFIER.keypad[1] : 0)];
  const shifted = Object.prototype.hasOwnProperty.call(QT_SHIFTED, key) ? QT_SHIFTED[key] : undefined;
  if (shifted && modifiers.some((m) => MODIFIER_OF[m] === 'shift')) {
    codes.push((bits & ~QT_MODIFIER.shift[1]) | shifted[1], bits | shifted[1]);
  }
  return codes;
}

export type BusctlRunner = (args: string[]) => Promise<string>;

const runBusctl: BusctlRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('busctl', args, { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** The first KDE shortcut found for a combo, or null (including when KDE's service is not there). */
export async function findSystemShortcut(combo: string, run: BusctlRunner = runBusctl): Promise<SystemShortcut | null> {
  for (const code of qtCodesFor(combo)) {
    let stdout: string;
    try {
      stdout = await run([
        '--user', '--json=short', 'call', 'org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel',
        'getGlobalShortcutsByKey', 'i', String(code),
      ]);
    } catch {
      return null; // no busctl, no KDE, no answer: nothing to warn about
    }
    try {
      // a(ssssssaiai): action id, action name, component id, component name, context id, context name, keys, default keys
      const found = (JSON.parse(stdout) as { data: [Array<[string, string, string, string, ...unknown[]]>] }).data[0];
      if (found.length > 0) return { component: found[0][3] || found[0][2], componentId: found[0][2] };
    } catch {
      return null;
    }
  }
  return null;
}

/** For tests: every daemon key name the table covers. */
export const QT_TABLE_NAMES = (): string[] => Object.keys(QT_KEYS).filter((name) => KEYS[name] !== undefined);
