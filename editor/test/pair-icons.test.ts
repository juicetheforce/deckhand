// The pair icons — the state icons an action keeps (mute, play/pause, the
// latching toggle) — are named in one list, PAIR_ICON_FIELDS. The icon
// handler in main, export and import must all take every field on it: a
// toggle's icons were once missing from two copies of the list, so the picker
// refused them and an export left them out. check:forms drives main's handler
// with every field through real IPC; this covers export, import and the
// actions.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pair-icons-'));

const { ICON_FIELDS } = await import('../src/shared/backup.js');
const { PAIR_ICON_FIELDS, isPairIconField, pairIconFields } = await import('../src/shared/icons.js');
const { iconReferences } = await import('../src/main/export-bundle.js');
const { CATALOGUE } = await import('../src/renderer/catalogue.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

await check('every pair field is an icon field for export and import, and passes the handler test', () => {
  const iconFields: readonly string[] = ICON_FIELDS;
  for (const field of PAIR_ICON_FIELDS) {
    assert.ok(iconFields.includes(field), `${field} is not in ICON_FIELDS`);
    assert.ok(isPairIconField(field), `${field} is refused by isPairIconField`);
  }
  assert.equal(isPairIconField('icon'), false, "the key's own icon is not a pair field");
  assert.equal(isPairIconField('iconBogus'), false);
});

await check('an export finds a path in every pair field, on a key action, onRelease and a multi step', () => {
  for (const field of PAIR_ICON_FIELDS) {
    const config = {
      profiles: { p: { name: 'P', layouts: { S: { startPage: 'm', pages: { m: { name: 'M', buttons: {
        0: { action: { type: 'x', [field]: `~/${field}-action.png` }, onRelease: { type: 'x', [field]: `~/${field}-release.png` } },
        1: { action: { type: 'multi', steps: [{ type: 'x', [field]: `~/${field}-step.png` }] } },
      } } } } } } },
    };
    assert.deepEqual(iconReferences(config), [`~/${field}-action.png`, `~/${field}-release.png`, `~/${field}-step.png`], field);
  }
});

await check('every pair an action can have is on the list', () => {
  const methods = ['playpause', 'next', 'previous', 'stop', 'play', 'pause'];
  for (const entry of CATALOGUE.flatMap((g) => g.entries)) {
    for (const method of [undefined, ...methods]) {
      for (const field of pairIconFields({ type: entry.type, method })) {
        assert.ok(isPairIconField(field), `${entry.type} has ${field}, which is not on PAIR_ICON_FIELDS`);
      }
    }
  }
  assert.deepEqual(pairIconFields({ type: 'toggle' }), ['iconOn', 'iconOff']);
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
