// The KDE global-shortcut lookup.
//
// Always: the Qt key table's coverage, the codes built for a combo, and the
// lookup against a fake busctl.
// DECKHAND_QT_HEADER=<path to Qt 6.11 qnamespace.h>: every table value checked
// against the header's enum.
// DECKHAND_TEST_REAL_KGLOBALACCEL=1: the lookup against the real KDE service,
// for every measured KDE combo in test/fixtures/kde-shortcut-batches.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODE_TO_KEY } from '../src/shared/keys.js';
import { QT_KEYS, QT_MODIFIER, QT_SHIFTED, findSystemShortcut, qtCodesFor, type BusctlRunner } from '../src/main/system-shortcuts.js';

const REPO = path.resolve(import.meta.dirname, '../../..');

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/** A fake busctl answering from a map of Qt code → component display name. */
function fakeBusctl(bound: Record<number, string>, calls: string[][] = []): BusctlRunner {
  return async (args) => {
    calls.push(args);
    const code = Number(args[args.length - 1]);
    const hit = bound[code];
    const data = hit ? [[['action', 'Action', hit.toLowerCase(), hit, 'default', 'Default Context', [code], [code]]]] : [[]];
    return JSON.stringify({ type: 'a(ssssssaiai)', data });
  };
}

console.log('the Qt key table');

await check('every key the editor writes has a Qt code', () => {
  const missing = Object.values(CODE_TO_KEY).filter((name) => !Object.prototype.hasOwnProperty.call(QT_KEYS, name));
  assert.deepEqual(missing, []);
});

const header = process.env.DECKHAND_QT_HEADER;
if (header) {
  await check(`every Qt value matches ${path.basename(header)}`, async () => {
    const text = await fs.readFile(header, 'utf8');
    const value = (name: string): number | null => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)`).exec(text);
      return m ? Number(m[1]) : null;
    };
    const wrong: string[] = [];
    for (const [key, [qtName, v]] of [...Object.entries(QT_KEYS), ...Object.entries(QT_SHIFTED).map(([k, e]) => [`shift+${k}`, e] as const)]) {
      const actual = value(qtName);
      if (actual !== v) wrong.push(`${key}: ${qtName} is ${actual === null ? 'not in the header' : `0x${actual.toString(16)}`}, table has 0x${v.toString(16)}`);
    }
    for (const [m, [qtName, v]] of Object.entries(QT_MODIFIER)) {
      if (value(qtName) !== v) wrong.push(`${m}: ${qtName}`);
    }
    assert.deepEqual(wrong, []);
    console.log(`       (${Object.keys(QT_KEYS).length + Object.keys(QT_SHIFTED).length + Object.keys(QT_MODIFIER).length} values checked)`);
  });
} else {
  console.log('  skip Qt values against qnamespace.h (set DECKHAND_QT_HEADER)');
}

console.log('codes for a combo');

await check('modifier bits plus the key; keypad keys carry KeypadModifier', () => {
  assert.deepEqual(qtCodesFor('ctrl+f1'), [0x04000000 | 0x01000030]);
  assert.deepEqual(qtCodesFor('meta+d'), [0x10000000 | 0x44]);
  assert.deepEqual(qtCodesFor('alt+tab'), [0x08000000 | 0x01000001]);
  assert.deepEqual(qtCodesFor('ctrl+alt+delete'), [0x04000000 | 0x08000000 | 0x01000007]);
  assert.deepEqual(qtCodesFor('kp7'), [0x20000000 | 0x37]);
  assert.deepEqual(qtCodesFor('rightctrl+1'), [0x04000000 | 0x31], 'right-hand modifiers are the same Qt modifier');
});

await check('with Shift and a symbol key, the shifted character is looked up too', () => {
  assert.deepEqual(qtCodesFor('alt+shift+`'), [0x08000000 | 0x02000000 | 0x60, 0x08000000 | 0x7e, 0x08000000 | 0x02000000 | 0x7e]);
  assert.equal(qtCodesFor('shift+a').length, 1, 'letters have no shifted symbol');
});

await check('a sequence or an unknown name gives no codes', () => {
  assert.deepEqual(qtCodesFor('ctrl+c+v'), []);
  assert.deepEqual(qtCodesFor('ctrl+nope'), []);
  assert.deepEqual(qtCodesFor('__proto__'), []);
});

console.log('the lookup');

await check('a bound combo returns the component display name; an unbound one returns null', async () => {
  const run = fakeBusctl({ [0x04000030 | 0x01000000]: 'KWin' });
  assert.deepEqual(await findSystemShortcut('ctrl+f1', run), { component: 'KWin', componentId: 'kwin' });
  assert.equal(await findSystemShortcut('ctrl+1', run), null);
});

await check('the shifted-character form is found', async () => {
  const run = fakeBusctl({ [0x08000000 | 0x7e]: 'KWin' });
  assert.deepEqual(await findSystemShortcut('alt+shift+`', run), { component: 'KWin', componentId: 'kwin' });
});

await check('the busctl call is read-only and exactly the documented one', async () => {
  const calls: string[][] = [];
  await findSystemShortcut('meta+d', fakeBusctl({}, calls));
  assert.deepEqual(calls, [['--user', '--json=short', 'call', 'org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel', 'getGlobalShortcutsByKey', 'i', String(0x10000044)]]);
});

await check('no KDE, no busctl, a timeout or garbage: no warning, no throw', async () => {
  assert.equal(await findSystemShortcut('ctrl+f1', async () => Promise.reject(new Error('ENOENT'))), null);
  assert.equal(await findSystemShortcut('ctrl+f1', async () => 'not json'), null);
});

if (process.env.DECKHAND_TEST_REAL_KGLOBALACCEL === '1') {
  console.log('against the real KDE shortcut service (the measured KDE combos)');
  const { BATCHES } = (await import(pathToFileURL(path.join(REPO, 'editor/test/fixtures/kde-shortcut-batches.mjs')).href)) as {
    BATCHES: Record<string, { combos: string[] }>;
  };
  const { canonicalCombo } = await import('../src/shared/keys.js');
  // Measured: batches 3 and 4 were all grabbed; of batches 1 and 2, only alt+f2 (KRunner),
  // alt+f6 (owner unknown) and the layout-remapped F13, F20, F21, F22.
  const grabbed = [...BATCHES[3].combos, ...BATCHES[4].combos, 'alt+f2'];
  const reached = [...BATCHES[1].combos, ...BATCHES[2].combos].filter((c) => !['alt+f2', 'alt+f6', 'f13', 'f20', 'f21', 'f22'].includes(c));
  const results = new Map<string, string | null>();
  for (const combo of [...new Set([...grabbed, ...reached, 'alt+f6', 'f13', 'f20', 'f21', 'f22'])]) {
    results.set(combo, (await findSystemShortcut(canonicalCombo(combo)))?.component ?? null);
  }
  await check(`every combo measured reaching the window (${reached.length}) has no KDE shortcut — no false warnings`, () => {
    assert.deepEqual(reached.filter((c) => results.get(c) !== null).map((c) => `${c} → ${results.get(c)}`), []);
  });
  await check(`the combos measured as grabbed (${grabbed.length}): which KDE knows`, () => {
    const found = grabbed.filter((c) => results.get(c) !== null);
    const missed = grabbed.filter((c) => results.get(c) === null);
    console.log(`       found ${found.length}: ${found.map((c) => `${c}(${results.get(c)})`).join(' ')}`);
    console.log(`       missed ${missed.length}: ${missed.join(' ')}`);
    assert.deepEqual(missed, [], 'measured as grabbed but not found');
  });
  await check("the recorded limits: Alt+F6 and the layout-remapped F-keys are grabbed but KDE's service does not know them", () => {
    assert.deepEqual(['alt+f6', 'f13', 'f20', 'f21', 'f22'].map((c) => results.get(c)), [null, null, null, null, null]);
  });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
