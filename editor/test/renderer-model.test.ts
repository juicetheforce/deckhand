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
import { pagesWithNoWayOff } from '../src/shared/links.js';
import { CATALOGUE, pendingReason, searchCatalogue } from '../src/renderer/catalogue.js';
import {
  canSwitchDeck,
  deckChoices,
  deckForProfile,
  describeAction,
  followDeck,
  keyFace,
  keyKind,
  knownDecks,
  actionEditable,
  profileCoverage,
  pageDeletion,
  reconcileSelection,
  clickKeys,
  clipboardSummary,
  placementMessage,
  deviceTargets,
} from '../src/renderer/model.js';

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

await check('phase B: hotkey, page and profile are editable; the rest wait for phase C', () => {
  const editable = CATALOGUE.flatMap((g) => g.entries.filter((e) => e.editable).map((e) => e.type));
  assert.deepEqual(editable, ['hotkey', 'page', 'profile']);
  // Every editable entry must have an inspector that will accept a bare key.
  for (const type of editable) assert.equal(actionEditable(undefined, type), true, type);
});

console.log('the navigation guard (M4 phase B, B2)');

const layoutOf = (pages: Record<string, unknown>, startPage = Object.keys(pages)[0]) =>
  ({ startPage, pages } as never);

await check('a page with no key that can leave it is flagged', () => {
  const layout = layoutOf({
    home: { name: 'Home', buttons: { '0': { action: { type: 'page', to: 'far' } } } },
    far: { name: 'Far', buttons: { '0': { action: { type: 'hotkey', keys: 'ctrl+1' } } } },
  });
  assert.deepEqual(pagesWithNoWayOff(layout), ['far']);
});

await check('back, a profile key, and a step inside a multi all count as ways off', () => {
  const ways: Record<string, unknown> = {
    back: { type: 'page', back: true },
    profile: { type: 'profile', to: 'Other' },
    multi: { type: 'multi', steps: [{ type: 'audio.micMute' }, { type: 'page', back: true }] },
  };
  for (const [name, action] of Object.entries(ways)) {
    const layout = layoutOf({ home: { buttons: {} }, far: { buttons: { '0': { action } } } });
    assert.deepEqual(pagesWithNoWayOff(layout), ['home'], `${name} did not count`);
  }
  // On release counts too.
  const onRelease = layoutOf({ home: { buttons: {} }, far: { buttons: { '0': { onRelease: { type: 'page', back: true } } } } });
  assert.deepEqual(pagesWithNoWayOff(onRelease), ['home']);
});

await check('a page key pointing nowhere is not a way off, because the daemon does nothing with it', () => {
  const layout = layoutOf({
    home: { buttons: { '0': { action: { type: 'page', to: 'deleted-page' } } } },
    other: { buttons: { '0': { action: { type: 'page', to: 'home' } } } },
  });
  assert.deepEqual(pagesWithNoWayOff(layout), ['home'], 'a dangling target must not count as an exit');
});

await check('a single-page layout is never flagged — there is nowhere to go', () => {
  assert.deepEqual(pagesWithNoWayOff(layoutOf({ only: { buttons: {} } })), []);
  // And the real config: each deck's start page links onward, so nothing is flagged.
  const xl = EXAMPLE.profiles.default.layouts[XL];
  assert.deepEqual(pagesWithNoWayOff(xl), [], 'the example config has no stranded page');
});

console.log('library search (M4 phase B, B2)');

const names = (q: string) => searchCatalogue(q).map((m) => m.entry.name).sort();

await check('search matches aliases, not just the names the daemon uses', () => {
  // The §2 case: nobody types "audio.sink".
  assert.deepEqual(names('headphones'), ['Cycle outputs', 'Output device']);
  assert.deepEqual(names('skip'), ['Media control']);
  assert.deepEqual(names('forward'), ['Go to page']);
  assert.deepEqual(names('ptt'), ['Press / Release']);
  assert.deepEqual(names('backlight'), ['Brightness']);
});

await check('deliberately ambiguous words find every action they could mean', () => {
  assert.deepEqual(names('macro'), ['Multi action', 'Type text']);
  assert.deepEqual(names('mute'), ['Mic mute', 'Mute output']);
});

await check('search is case-insensitive, an empty query matches nothing, and player names are not aliases', () => {
  assert.deepEqual(names('HEADPHONES'), ['Cycle outputs', 'Output device']);
  assert.deepEqual(names('  '), [], 'the caller shows the grouped list instead');
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('spotify'), [], 'player names date and were left out');
  assert.deepEqual(names('tidal'), []);
});

await check('search is independent of collapse — it reads the catalogue, not the DOM', () => {
  // The requirement: collapsing everything must make search more useful, not
  // break it. searchCatalogue takes no collapse state at all, so there is no
  // way for it to miss a shut section.
  assert.equal(searchCatalogue.length, 1, 'searchCatalogue takes only the query');
  const everything = CATALOGUE.flatMap((g) => g.entries);
  for (const entry of everything) {
    assert.ok(names(entry.name).includes(entry.name), `${entry.type} cannot be found by its own name`);
  }
});

await check('aliases add only what the name and description do not already say', () => {
  for (const group of CATALOGUE) {
    for (const entry of group.entries) {
      const already = `${entry.name} ${entry.description}`.toLowerCase();
      for (const alias of entry.aliases ?? []) {
        assert.equal(alias, alias.toLowerCase(), `${entry.type}: "${alias}" is not lowercase`);
        assert.ok(!already.includes(alias), `${entry.type}: "${alias}" is already in the name or description`);
      }
    }
  }
});

await check('every greyed library entry says why, and daemon-blocked ones say so differently', () => {
  const later = CATALOGUE.flatMap((g) => g.entries.filter((e) => !e.editable));
  assert.ok(later.length > 0);
  for (const entry of later) {
    assert.ok(entry.pending, `${entry.type} is greyed with no reason`);
    assert.match(pendingReason(entry), /\S/);
  }
  // Nothing is blocked on daemon work any more: audio.sink and audio.cycle
  // left with C1 piece 1 (node + label), audio.mute with piece 3 (its face).
  // The daemon reason stays for whatever needs daemon work next.
  const daemon = later.filter((e) => e.pending === 'daemon').map((e) => e.type).sort();
  assert.deepEqual(daemon, []);
  const byType = (t: string) => later.find((e) => e.type === t)!;
  assert.match(pendingReason({ ...byType('audio.mute'), pending: 'daemon' }), /daemon work/);
  // Everything else works today if hand-written; command is not special.
  assert.match(pendingReason(byType('command')), /by hand/);
  assert.match(pendingReason(byType('clock')), /by hand/);
  assert.equal(pendingReason(byType('command')), pendingReason(byType('clock')));
});

await check('an action is editable only when the inspector knows every field on it', () => {
  // A key with nothing on it can become any of them.
  assert.equal(actionEditable({}, 'page'), true);
  assert.equal(actionEditable(undefined, 'profile'), true);
  // The right type, carrying only fields the inspector has a control for.
  assert.equal(actionEditable({ action: { type: 'page', to: 'x' } }, 'page'), true);
  assert.equal(actionEditable({ action: { type: 'page', back: true } }, 'page'), true);
  assert.equal(actionEditable({ action: { type: 'profile', to: 'x' } }, 'profile'), true);
  // The wrong type.
  assert.equal(actionEditable({ action: { type: 'page', to: 'x' } }, 'profile'), false);
  // A field the inspector would silently drop.
  assert.equal(actionEditable({ action: { type: 'page', to: 'x', unknownThing: 1 } }, 'page'), false);
  // onRelease makes it a two-phase key, which is phase C.
  assert.equal(actionEditable({ action: { type: 'page', to: 'x' }, onRelease: { type: 'noop' } }, 'page'), false);
  // hotkey keeps phase A's rule: single combos only, never a sequence.
  assert.equal(actionEditable({ action: { type: 'hotkey', keys: 'ctrl+1' } }, 'hotkey'), true);
  assert.equal(actionEditable({ action: { type: 'hotkey', keys: ['ctrl+1', 'ctrl+2'] } }, 'hotkey'), false);
  assert.equal(actionEditable({ action: { type: 'hotkey', keys: 'ctrl+1', repeat: 2 } }, 'hotkey'), false);
  // A type with no inspector is never editable.
  assert.equal(actionEditable({ action: { type: 'clock' } }, 'clock'), false);
});

await check('profileCoverage names the decks a profile changes, and the connected ones it leaves out', () => {
  const view = daemonView([XL, V2]);
  const both = profileCoverage(EXAMPLE, view, 'default');
  assert.deepEqual(both.covered, ['XL', 'Original V2'], 'names from config');
  assert.deepEqual(both.uncoveredConnected, [], 'default covers both');

  const xlOnly = profileCoverage(EXAMPLE, view, 'prof_game');
  assert.deepEqual(xlOnly.covered, ['XL']);
  assert.deepEqual(xlOnly.uncoveredConnected, ['Original V2'], 'the V2 is plugged in and not covered');

  // A deck that is not plugged in is not a warning: nothing is left showing.
  assert.deepEqual(profileCoverage(EXAMPLE, daemonView([XL]), 'prof_game').uncoveredConnected, []);
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
  const current = { profile: 'default', serial: XL, page: 'games', key: 3, keys: [3] };
  assert.deepEqual(reconcileSelection(EXAMPLE, daemonView([XL, V2]), current), current);
  assert.deepEqual(reconcileSelection(EXAMPLE, daemonView([]), current), current, 'a deck unplugging does not move the editor off its page');
});

await check('a deleted page falls back to the start page and drops the key; an unknown profile falls back too', () => {
  const edited = structuredClone(EXAMPLE);
  delete edited.profiles.default.layouts[XL].pages.games;
  const s = reconcileSelection(edited, daemonView([XL]), { profile: 'default', serial: XL, page: 'games', key: 3, keys: [3] });
  assert.deepEqual([s.page, s.key, s.keys], ['main', null, []]);
  const p = reconcileSelection(EXAMPLE, daemonView([XL]), { profile: 'gone', serial: XL, page: 'main', key: 1, keys: [1] });
  assert.equal(p.profile, 'default');
});

await check('a new page added by the editor can be selected immediately', () => {
  const edited = structuredClone(EXAMPLE);
  edited.profiles.default.layouts[XL].pages.pg_beef = { name: 'Combat', buttons: {} };
  const s = reconcileSelection(edited, daemonView([XL]), { profile: 'default', serial: XL, page: 'pg_beef', key: null, keys: [] });
  assert.equal(s.page, 'pg_beef');
});

console.log('live switching: following the decks');

/** A daemon view where each listed deck shows the given profile and page. */
function showing(decks: Array<{ serial: string; profile: string; page: string }>): DaemonView {
  const view = daemonView(decks.map((d) => d.serial));
  view.status!.decks = decks.map((d) => ({ serial: d.serial, connected: true, configured: true, profile: d.profile, page: d.page }));
  return view;
}

await check('the breadcrumb follows a page change on the deck, and drops the key it no longer points at', () => {
  const s = followDeck(EXAMPLE, showing([{ serial: XL, profile: 'default', page: 'games' }]), { profile: 'default', serial: XL, page: 'main', key: 5, keys: [5] });
  assert.deepEqual(s, { profile: 'default', serial: XL, page: 'games', key: null, keys: [] });
});

await check('the breadcrumb follows a profile change on the deck', () => {
  const s = followDeck(EXAMPLE, showing([{ serial: XL, profile: 'prof_game', page: 'pg_hotbar' }]), { profile: 'default', serial: XL, page: 'main', key: null, keys: [] });
  assert.deepEqual([s.profile, s.page], ['prof_game', 'pg_hotbar']);
});

await check('when the deck has not moved, the selected key stays (mid-edit)', () => {
  const current = { profile: 'default', serial: XL, page: 'games', key: 3, keys: [3] };
  assert.deepEqual(followDeck(EXAMPLE, showing([{ serial: XL, profile: 'default', page: 'games' }]), current), current);
});

await check('nothing to follow — disconnected deck, daemon not connected — leaves the selection alone', () => {
  const current = { profile: 'default', serial: XL, page: 'games', key: 3, keys: [3] };
  assert.deepEqual(followDeck(EXAMPLE, showing([{ serial: V2, profile: 'default', page: 'main' }]), current), current, 'another deck moving');
  const down = showing([{ serial: XL, profile: 'default', page: 'main' }]);
  down.connected = false;
  assert.deepEqual(followDeck(EXAMPLE, down, current), current, 'daemon not connected: stale state is not followed');
});

await check('a deck showing a profile the editor does not have (outside edit not reloaded yet) is not followed into nowhere', () => {
  // Not the start page, and a key selected: a follow that fell back would show as a change.
  const current = { profile: 'default', serial: XL, page: 'games', key: 3, keys: [3] };
  assert.deepEqual(followDeck(EXAMPLE, showing([{ serial: XL, profile: 'not-in-config', page: 'x' }]), current), current);
});

await check('choosing a profile keeps the deck if the profile covers it, otherwise moves to a connected deck it covers', () => {
  const both = showing([
    { serial: XL, profile: 'default', page: 'main' },
    { serial: V2, profile: 'default', page: 'main' },
  ]);
  assert.equal(deckForProfile(EXAMPLE, both, 'default', V2), V2);
  assert.equal(deckForProfile(EXAMPLE, both, 'prof_game', V2), XL, 'prof_game has no V2 layout');
});

await check('a switch is sent only for a connected deck with a session, with the daemon connected', () => {
  const view = showing([{ serial: XL, profile: 'default', page: 'main' }]);
  // V2 connected but with no session (no profile covers it): listed, with no page.
  view.status!.decks.push({ serial: V2, connected: true, configured: false });
  assert.equal(canSwitchDeck(view, XL), true);
  assert.equal(canSwitchDeck(view, V2), false, 'a connected deck with no session');
  assert.equal(canSwitchDeck(view, 'NOT-LISTED'), false);
  view.connected = false;
  assert.equal(canSwitchDeck(view, XL), false);
});

console.log('profiles and pages (M4 phase B, B1)');

await check('knownDecks lists every deck in config, then connected decks that are not', async () => {
  // prof_game covers only the XL, but both decks are in "decks", so a new
  // profile can be given either.
  const both = knownDecks(EXAMPLE, daemonView([XL]));
  assert.deepEqual(
    both.map((d) => [d.id, d.connected]),
    [
      [XL, true],
      [V2, false],
    ],
  );
  // A deck connected but never named in config still has to be offerable.
  const stranger = knownDecks({ profiles: EXAMPLE.profiles }, daemonView([XL, V2]));
  assert.deepEqual(
    stranger.map((d) => [d.id, d.connected]),
    [
      [XL, true],
      [V2, true],
    ],
  );
  assert.equal(knownDecks(EXAMPLE, daemonView([XL]))[0].label, 'XL', 'named from config');
  assert.equal(stranger[0].label, 'Test 8x4', "and from the daemon's product name when config does not name it");
});

await check('pageDeletion names the keys that would lose their navigation', async () => {
  const d = pageDeletion(EXAMPLE, 'default', XL, 'games')!;
  assert.equal(d.refusal, null);
  // XL "main" key 24 navigates to "Games" by name.
  assert.deepEqual(d.links, [{ page: 'main', index: 24, where: 'action', inMulti: false }]);
  assert.equal(d.startPageAfter, null, 'the deck still starts on main');
});

await check('pageDeletion reports a start page that would move, and refuses a last page', async () => {
  const moved = pageDeletion(EXAMPLE, 'default', XL, 'main')!;
  assert.equal(moved.startPageAfter, 'games');
  assert.deepEqual(moved.links, [], 'the back key on games names no page');

  const last = pageDeletion(EXAMPLE, 'prof_game', XL, 'pg_hotbar')!;
  assert.match(String(last.refusal), /only page/);

  assert.equal(pageDeletion(EXAMPLE, 'default', XL, 'no-such-page'), null);
  assert.equal(pageDeletion(EXAMPLE, 'default', 'NO-SUCH-DECK', 'main'), null);
});

await check('pageDeletion reports a start page moving even when no key pointed at the page', async () => {
  // A layout with no explicit startPage: deleting the first page silently
  // changes where the deck starts, so the confirmation has to say so.
  const implicit: Config = {
    profiles: {
      p1: { layouts: { [XL]: { pages: { first: { name: 'First', buttons: {} }, second: { name: 'Second', buttons: {} } } } } },
    },
  };
  const d = pageDeletion(implicit, 'p1', XL, 'first')!;
  assert.deepEqual(d.links, []);
  assert.equal(d.startPageAfter, 'second');
});

console.log('multi-select and bulk messages (M4 phase B3)');

const GRID = { keys: Array.from({ length: 32 }, (_, i) => ({ index: i, row: Math.floor(i / 8), column: i % 8 })) };
const none = { key: null, keys: [] as number[] };
const plain = { ctrl: false, shift: false };

await check('click selects one key; Ctrl+click adds and removes; Shift+click selects a run from the anchor', () => {
  const one = clickKeys(GRID, none, 3, plain);
  assert.deepEqual(one, { key: 3, keys: [3] });
  const two = clickKeys(GRID, one, 10, { ctrl: true, shift: false });
  assert.deepEqual(two, { key: 10, keys: [3, 10] });
  assert.deepEqual(clickKeys(GRID, two, 10, { ctrl: true, shift: false }), { key: 3, keys: [3] }, 'removing the anchor falls back to the key before it');
  assert.deepEqual(clickKeys(GRID, two, 3, { ctrl: true, shift: false }), { key: 10, keys: [10] }, 'removing another key keeps the anchor');
  assert.deepEqual(clickKeys(GRID, { key: 3, keys: [3] }, 3, { ctrl: true, shift: false }), none, 'removing the last key selects nothing');
  const run = clickKeys(GRID, one, 9, { ctrl: false, shift: true });
  assert.deepEqual(run, { key: 3, keys: [3, 4, 5, 6, 7, 8, 9] });
  assert.deepEqual(clickKeys(GRID, run, 1, { ctrl: false, shift: true }), { key: 3, keys: [1, 2, 3] }, 'the anchor stays, so a second Shift+click re-draws the run');
  assert.deepEqual(clickKeys(GRID, run, 20, plain), { key: 20, keys: [20] }, 'a plain click starts over');
  assert.deepEqual(clickKeys(GRID, none, 5, { ctrl: false, shift: true }), { key: 5, keys: [5] }, 'Shift with no anchor is a plain click');
});

await check('several selected keys survive a config change on the same page, and go with a page change', () => {
  const current = { profile: 'default', serial: XL, page: 'games', key: 3, keys: [1, 2, 3] };
  assert.deepEqual(reconcileSelection(EXAMPLE, daemonView([XL]), current), current);
  const moved = followDeck(EXAMPLE, showing([{ serial: XL, profile: 'default', page: 'main' }]), current);
  assert.deepEqual([moved.key, moved.keys], [null, []]);
});

await check('the clipboard line names up to three keys, then counts the rest', () => {
  const key = (label: string | undefined, sourceIndex: number) => ({ rowOffset: 0, columnOffset: 0, sourceIndex, button: label ? { label } : { icon: '~/x.png' } });
  assert.equal(clipboardSummary({ origin: { row: 0, column: 0 }, keys: [key('Jump', 0)] }), '1 key (“Jump” (key 1))');
  assert.equal(
    clipboardSummary({ origin: { row: 0, column: 0 }, keys: [key('Jump', 0), key(undefined, 6), key('Sprint', 2)] }),
    '3 keys (“Jump” (key 1), key 7 and “Sprint” (key 3))',
  );
  assert.equal(
    clipboardSummary({ origin: { row: 0, column: 0 }, keys: [key('A', 0), key('B', 1), key('C', 2), key('D', 3)] }),
    '4 keys (“A” (key 1), “B” (key 2) and 2 more)',
  );
});

await check('a paste message names what was skipped and what lost its navigation', () => {
  const wide = { rowOffset: 0, columnOffset: 6, sourceIndex: 6, button: { label: 'Wide' } };
  const combat = { rowOffset: 0, columnOffset: 0, sourceIndex: 0, button: { label: 'Combat', action: { type: 'page', to: 'pg_c' } } };
  const message = placementMessage(
    'Copied',
    { writes: [{ index: 0, button: { label: 'Combat' } }], skipped: [wide], lostNavigation: [{ index: 0, key: combat }] },
    'Little deck › Main',
  );
  assert.equal(
    message,
    'Copied 1 key to Little deck › Main. Skipped “Wide” (key 7): it has no place on that deck. “Combat” (key 1) lost its Go to page: that page is not on this deck, so it needs a new target.',
  );
  assert.match(placementMessage('Pasted', { writes: [], skipped: [wide], lostNavigation: [] }, '“Main”'), /^Nothing pasted: no copied key has a place on “Main”\.$/);
});

await check('Copy to device offers the other decks this profile covers, with their pages, and says which are not connected', () => {
  const selection = { profile: 'default', serial: XL, page: 'main', key: 0, keys: [0] };
  const targets = deviceTargets(EXAMPLE, daemonView([XL]), selection);
  assert.deepEqual(
    targets.map((t) => [t.serial, t.connected, t.pages.map((p) => p.id)]),
    [[V2, false, ['main']]],
    'the deck being edited is not a target, and a disconnected deck is listed as such',
  );
  assert.deepEqual(deviceTargets(EXAMPLE, daemonView([XL, V2]), selection)[0].connected, true);
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
