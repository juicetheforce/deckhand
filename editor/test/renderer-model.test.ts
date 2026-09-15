// Offline test of the shell's pure logic (M4 phase A, step 3): the action
// catalogue against the daemon's real registry, key kinds, key faces, the
// Device dropdown and how the selection survives changes. No DOM, no Electron.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../../src/types.js';
import type { DaemonView } from '../src/shared/bridge.js';
import { iconUrl } from '../src/shared/icons.js';
import { CATALOGUE } from '../src/renderer/catalogue.js';
import { deckChoices, describeAction, keyFace, keyKind, reconcileSelection } from '../src/renderer/model.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');
const { registry } = await import(pathToFileURL(path.join(REPO, 'dist/actions/index.js')).href);

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

const EXAMPLE = JSON.parse(await fs.readFile(path.join(REPO, 'config.example.json'), 'utf8')) as Config;
const XL = 'REPLACE-WITH-XL-SERIAL';
const V2 = 'REPLACE-WITH-ORIGINAL-V2-SERIAL';

function geometry(serial: string, columns: number, rows: number, pixels: number) {
  return {
    serial,
    model: 'test',
    productName: `Test ${columns}x${rows}`,
    keyCount: columns * rows,
    iconSize: pixels,
    rows,
    columns,
    keys: Array.from({ length: columns * rows }, (_, i) => ({ index: i, row: Math.floor(i / columns), column: i % columns, feedback: 'lcd' })),
    unsupported: [],
  };
}

function daemonView(connected: string[], active: string | null = 'default'): DaemonView {
  const decks = connected.map((s) => (s === V2 ? geometry(s, 5, 3, 72) : geometry(s, 8, 4, 96)));
  return {
    connected: true,
    problem: null,
    decks,
    status: {
      protocol: 1,
      pid: 1,
      config: { path: '/x', lastReload: { ok: true, at: 'now' } },
      activeProfile: active ? { id: active, name: null } : null,
      decks: connected.map((serial) => ({ serial, connected: true, configured: true })),
    },
  };
}

console.log('the action library');

await check("every catalogue entry is an action the daemon's registry has", () => {
  const listed = CATALOGUE.flatMap((g) => g.entries.map((e) => e.type));
  const unknown = listed.filter((type) => !Object.prototype.hasOwnProperty.call(registry, type));
  assert.deepEqual(unknown, []);
  assert.equal(new Set(listed).size, listed.length, 'an action is listed twice');
});

await check("every action in the daemon's registry is in the catalogue (scope §2: nothing invisible)", () => {
  const listed = new Set(CATALOGUE.flatMap((g) => g.entries.map((e) => e.type)));
  assert.deepEqual(Object.keys(registry).filter((type) => !listed.has(type)), []);
});

await check('phase A: only hotkey is editable', () => {
  const editable = CATALOGUE.flatMap((g) => g.entries.filter((e) => e.editable).map((e) => e.type));
  assert.deepEqual(editable, ['hotkey']);
});

console.log('keys');

await check('key kinds: empty, unbound (shows something, does nothing), hotkey, other', () => {
  assert.equal(keyKind(undefined), 'empty');
  assert.equal(keyKind({}), 'empty');
  assert.equal(keyKind({ icon: '~/x.png' }), 'unbound');
  assert.equal(keyKind({ label: 'x' }), 'unbound');
  assert.equal(keyKind({ background: '#123456' }), 'unbound');
  assert.equal(keyKind({ action: { type: 'hotkey', keys: 'ctrl+1' } }), 'hotkey');
  assert.equal(keyKind({ action: { type: 'media.info' } }), 'other');
  assert.equal(keyKind({ onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } }), 'other', 'onRelease alone is bound');
});

await check("key faces use the button's values, then config defaults, then the daemon's DEFAULTS", () => {
  const bare = keyFace({ profiles: {} } as unknown as Config, { label: 'x' }, 96);
  assert.equal(bare.background, '#101014');
  assert.equal(bare.labelPosition, 'bottom');
  assert.equal(bare.labelScale, 14 / 96);
  const withDefaults = keyFace({ profiles: {}, defaults: { background: '#222222', labelSize: 20 } } as unknown as Config, { label: 'x' }, 72);
  assert.equal(withDefaults.background, '#222222');
  assert.equal(withDefaults.labelScale, 20 / 72);
  const own = keyFace(EXAMPLE, { background: '#2a1f3d', labelPosition: 'top', icon: '~/a.png', iconFit: 'contain' }, 96);
  assert.deepEqual([own.background, own.labelPosition, own.icon, own.iconFit], ['#2a1f3d', 'top', '~/a.png', 'contain']);
});

await check('describeAction: combos, sequences, and keys that do nothing', () => {
  assert.equal(describeAction({ action: { type: 'hotkey', keys: 'ctrl+1' } }), 'hotkey ctrl+1');
  assert.equal(describeAction({ action: { type: 'hotkey', keys: ['ctrl+c', 'ctrl+v'] } }), 'hotkey ctrl+c, then ctrl+v');
  assert.equal(describeAction({ icon: '~/x.png' }), 'does nothing when pressed');
});

await check('icon URLs carry paths with spaces, parentheses and ~ intact', () => {
  const p = '~/Pictures/icons/FFXIV/IconKit Battle(Set)/14_BEAR/Bolt_III.png';
  const url = new URL(iconUrl(p));
  assert.equal(url.protocol, 'deckhand-icon:');
  assert.equal(url.searchParams.get('path'), p);
});

console.log('breadcrumb and selection');

await check('Device dropdown: layouts in config order, then connected decks with none; names from config', () => {
  const extra = 'UNCONFIGURED';
  const choices = deckChoices(EXAMPLE, 'default', daemonView([V2, extra]));
  assert.deepEqual(
    choices.map((c) => [c.id, c.label, c.connected, c.hasLayout]),
    [
      [XL, 'XL', false, true],
      [V2, 'Original V2', true, true],
      [extra, 'Test 8x4', true, false],
    ],
  );
});

await check("initial selection: the daemon's active profile, the first connected deck with a layout, its start page", () => {
  const s = reconcileSelection(EXAMPLE, daemonView([V2], 'prof_game'), null);
  assert.equal(s.profile, 'prof_game');
  // prof_game only has an XL layout; with the XL disconnected it is still chosen, as the only layout.
  assert.equal(s.serial, XL);
  assert.equal(s.page, 'pg_hotbar', 'startPage "Hotbar" resolves by name, the daemon rule');
  assert.equal(s.key, null);

  const d = reconcileSelection(EXAMPLE, daemonView([V2]), null);
  assert.deepEqual([d.profile, d.serial, d.page], ['default', V2, 'main'], 'the connected deck wins over the disconnected XL');
});

await check('a selection that still exists is kept, key included, across config and daemon changes', () => {
  const current = { profile: 'default', serial: XL, page: 'games', key: 3 };
  assert.deepEqual(reconcileSelection(EXAMPLE, daemonView([XL, V2]), current), current);
  assert.deepEqual(reconcileSelection(EXAMPLE, daemonView([]), current), current, 'a deck unplugging does not move the editor off its page');
});

await check('a deleted page falls back to the start page and drops the key; an unknown profile falls back too', () => {
  const edited = structuredClone(EXAMPLE);
  delete edited.profiles.default.layouts[XL].pages.games;
  const s = reconcileSelection(edited, daemonView([XL]), { profile: 'default', serial: XL, page: 'games', key: 3 });
  assert.deepEqual([s.page, s.key], ['main', null]);
  const p = reconcileSelection(EXAMPLE, daemonView([XL]), { profile: 'gone', serial: XL, page: 'main', key: 1 });
  assert.equal(p.profile, 'default');
});

await check('a new page added by the editor can be selected immediately', () => {
  const edited = structuredClone(EXAMPLE);
  edited.profiles.default.layouts[XL].pages.pg_beef = { name: 'Combat', buttons: {} };
  const s = reconcileSelection(edited, daemonView([XL]), { profile: 'default', serial: XL, page: 'pg_beef', key: null });
  assert.equal(s.page, 'pg_beef');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
