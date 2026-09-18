// Key naming for capture and Type manually, checked against the daemon's own
// KEYS table and parseCombo (M4 phase A, step 4).

import assert from 'node:assert/strict';
import { KEYS, parseCombo } from '../../src/keymap.js';
import { CODE_TO_KEY, LAYOUT_REMAPPED_KEYS, MODIFIER_CODES, canonicalCombo, captureKey, keycaps, loneModifierCombo } from '../src/shared/keys.js';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const ev = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
});

console.log('the key table');

await check('every name the editor writes is a name the daemon accepts', () => {
  const unknown = Object.values(CODE_TO_KEY).filter((name) => KEYS[name] === undefined);
  assert.deepEqual(unknown, []);
});

await check('every evdev code the daemon knows has exactly one name the editor writes', () => {
  const written = new Map<number, string[]>();
  for (const name of Object.values(CODE_TO_KEY)) written.set(KEYS[name], [...(written.get(KEYS[name]) ?? []), name]);
  const daemonCodes = new Set(Object.values(KEYS));
  const missing = [...daemonCodes].filter((code) => !written.has(code));
  const doubled = [...written].filter(([, names]) => names.length > 1);
  assert.deepEqual(missing, [], 'codes with no capture name');
  assert.deepEqual(doubled, [], 'codes written two ways');
  assert.equal(written.size, daemonCodes.size);
});

console.log('capture');

await check('reads the physical key (code), never the character: shift+1 is shift+1, not "!"', () => {
  assert.deepEqual(captureKey(ev('Digit1', { shiftKey: true })), { kind: 'combo', combo: 'shift+1' });
});

await check('FFXIV-style combos, modifiers in a fixed order whatever order they were pressed', () => {
  assert.deepEqual(captureKey(ev('Digit5', { ctrlKey: true })), { kind: 'combo', combo: 'ctrl+5' });
  assert.deepEqual(captureKey(ev('Minus', { ctrlKey: true, shiftKey: true })), { kind: 'combo', combo: 'ctrl+shift+-' });
  assert.deepEqual(captureKey(ev('KeyJ', { metaKey: true, shiftKey: true })), { kind: 'combo', combo: 'shift+meta+j' });
  assert.deepEqual(captureKey(ev('F24')), { kind: 'combo', combo: 'f24' });
});

await check('a modifier on its own keeps listening, left or right, flags or not', () => {
  for (const [code, modifier] of Object.entries(MODIFIER_CODES)) {
    assert.deepEqual(captureKey(ev(code)), { kind: 'modifier', modifier });
    assert.deepEqual(captureKey(ev(code, { metaKey: true, ctrlKey: true })), { kind: 'modifier', modifier });
  }
});

await check('modifiers let go with no other key: the combo Press/Release records, left and right kept apart', () => {
  assert.equal(loneModifierCombo(['ShiftLeft']), 'shift');
  assert.equal(loneModifierCombo(['ShiftRight']), 'rightshift');
  assert.equal(loneModifierCombo(['ControlLeft']), 'ctrl');
  assert.equal(loneModifierCombo(['MetaLeft']), 'meta');
  assert.equal(loneModifierCombo(['ShiftLeft', 'ControlLeft']), 'ctrl+shift', 'modifiers in the fixed order, whatever order pressed');
  assert.equal(loneModifierCombo(['AltRight', 'ControlLeft']), 'ctrl+rightalt');
  assert.equal(loneModifierCombo([]), null);
  assert.equal(loneModifierCombo(['ShiftLeft', 'KeyA']), null, 'a combo with a non-modifier is not a lone modifier');
  assert.equal(loneModifierCombo(['__proto__']), null);
  // Each is what the daemon holds: the same evdev codes, in any order.
  for (const [codes, keys] of [[['ShiftLeft'], ['shift']], [['ShiftRight'], ['rightshift']], [['ShiftLeft', 'ControlLeft'], ['ctrl', 'shift']]] as const) {
    assert.deepEqual([...parseCombo(loneModifierCombo(codes)!)].sort(), keys.map((k) => KEYS[k]).sort());
  }
});

await check('a key the daemon has no name for is reported, not guessed', () => {
  assert.deepEqual(captureKey(ev('IntlBackslash')), { kind: 'unknown', code: 'IntlBackslash' });
  assert.deepEqual(captureKey(ev('__proto__')), { kind: 'unknown', code: '__proto__' });
});

await check('every captured combo parses in the daemon to the same keys', () => {
  for (const code of Object.keys(CODE_TO_KEY)) {
    if (MODIFIER_CODES[code]) continue;
    const c = captureKey(ev(code, { ctrlKey: true, altKey: true }));
    assert.equal(c.kind, 'combo', code);
    const codes = parseCombo((c as { combo: string }).combo);
    assert.deepEqual(codes, [KEYS.ctrl, KEYS.alt, KEYS[CODE_TO_KEY[code]]], code);
  }
});

console.log('type manually');

await check('typed combos come out in the editor spelling: aliases, case, order, spaces', () => {
  assert.equal(canonicalCombo('ctrl+1'), 'ctrl+1');
  assert.equal(canonicalCombo('Control + 1'), 'ctrl+1');
  assert.equal(canonicalCombo('shift+ctrl+F13'), 'ctrl+shift+f13');
  assert.equal(canonicalCombo('super+pgup'), 'meta+pageup');
  assert.equal(canonicalCombo('ctrl+backslash'), 'ctrl+backslash');
  assert.equal(canonicalCombo('alt+\\'), 'alt+backslash');
  assert.equal(canonicalCombo('rctrl+x'), 'rightctrl+x', 'a typed right-hand modifier is kept as typed');
  assert.equal(canonicalCombo('ctrl'), 'ctrl', 'a lone modifier is the key');
});

await check("typed combos the daemon refuses throw the daemon's message", () => {
  assert.throws(() => canonicalCombo('ctrl+nope'), /unknown key "nope"/);
  assert.throws(() => canonicalCombo(''), /empty key combo/);
});

await check('an empty part is refused, because the daemon misreads it: "ctrl++" is a bare Ctrl, "ctrl+" is ctrl+=', () => {
  // The daemon's own behaviour, recorded so a fix there is noticed:
  assert.deepEqual(parseCombo('ctrl++'), [KEYS.ctrl]);
  assert.deepEqual(parseCombo('ctrl+'), [KEYS.ctrl, KEYS['=']]);
  for (const text of ['ctrl++', 'ctrl+', '+1', 'ctrl++1', 'ctrl+ +1']) {
    assert.throws(() => canonicalCombo(text), /missing between/, text);
  }
});

await check('keycaps for display', () => {
  assert.deepEqual(keycaps('ctrl+shift+1'), ['Ctrl', 'Shift', '1']);
  assert.deepEqual(keycaps('meta+pageup'), ['Meta', 'PgUp']);
  assert.deepEqual(keycaps('f13'), ['F13']);
  assert.deepEqual(keycaps('ctrl+-'), ['Ctrl', '-']);
});

await check('the layout-remapped F-keys are F13–F18 and F20–F23, not F19 or F24', () => {
  assert.equal(LAYOUT_REMAPPED_KEYS.has('f20'), true);
  assert.equal(LAYOUT_REMAPPED_KEYS.has('f19'), false);
  assert.equal(LAYOUT_REMAPPED_KEYS.has('f24'), false);
  assert.equal(LAYOUT_REMAPPED_KEYS.size, 10);
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
