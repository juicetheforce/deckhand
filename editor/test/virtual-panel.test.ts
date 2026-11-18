// Every page of a virtual deck has its own layout (decided 2026-11-17), and
// the deck keeps a default size for every page made automatically (2026-11-18):
// src/panel-presets.ts's lookup and migration, and the edits in
// src/main/config-document.ts. Found on both machines, 2026-10-17: a profile
// created after a virtual deck was added gave the deck no panel ("0 keys, no
// screens") — so no page made here may be left without one.

import assert from 'node:assert/strict';
import type { Config } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';
import { defaultPanelOf, makePanel, migratePagePanels, pagePanelIn } from '../../src/panel-presets.js';
import { applyEdit } from '../src/main/config-document.js';
import { geometryOfPanel } from '../../src/geometry.js';
import { pageGeometry } from '../src/renderer/model.js';
import type { DaemonView } from '../src/shared/bridge.js';
import type { Edit } from '../src/shared/edits.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

let n = 0;
const env = { homeDir: '/home/test', randomHex: () => (n++).toString(16).padStart(4, '0') };
const apply = (config: Config, edit: Edit) => applyEdit(config, edit, env);
const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const MEDIUM = makePanel(SCREEN, 'medium');
const SMALL = makePanel(SCREEN, 'small');
const LARGE = makePanel(SCREEN, 'large');
const KEY = 'GRA-6e4e';
const TOUCH = { vendor: '222a', product: '0001', path: 'pci-0000:00:14.0-usb-0:2.3:1.0' };

function withDeck(): Config {
  const config: Config = { decks: { XL: { name: 'XL' } }, profiles: { default: { name: 'Default', layouts: { XL: { pages: { main: { name: 'Main', buttons: {} } } } } } } };
  apply(config, { kind: 'addVirtualDeck', key: KEY, output: 'DP-4', touch: TOUCH, profile: 'default', panel: MEDIUM, pageName: 'Main' });
  return config;
}
const pagesOf = (config: Config, profile: string) => Object.values(config.profiles[profile].layouts[KEY].pages);
const firstPage = (config: Config, profile: string) => Object.keys(config.profiles[profile].layouts[KEY].pages)[0];

check('adding a virtual deck: the size chosen is its default, and its first page has it', () => {
  const config = withDeck();
  assert.deepEqual(config.decks?.[KEY]?.virtual?.panel, MEDIUM);
  assert.equal(config.profiles.default.layouts[KEY].panel, undefined, 'no panel on the layout: pages have their own');
  assert.deepEqual(pagesOf(config, 'default').map((p) => p.panel), [MEDIUM]);
  validateConfig(structuredClone(config));
});

check('a profile created after the deck: its blank page at the deck\'s default size, never no panel', () => {
  const config = withDeck();
  const { profileId } = apply(config, { kind: 'addProfile', name: 'Test', serials: ['XL', KEY], pageName: 'Main' }) as { profileId: string };
  assert.deepEqual(pagesOf(config, profileId).map((p) => [Object.keys(p.buttons).length, p.panel?.preset]), [[0, 'medium']]);
  assert.equal(Object.values(config.profiles[profileId].layouts.XL.pages)[0].panel, undefined, 'a Stream Deck\'s page has none');
  validateConfig(structuredClone(config));
});

check('a layout added later (the editor\'s automatic page) takes the deck\'s default, copied from no other profile', () => {
  const config = withDeck();
  apply(config, { kind: 'setPagePanel', profile: 'default', serial: KEY, page: firstPage(config, 'default'), panel: LARGE });
  config.profiles.other = { name: 'Other', layouts: {} };
  apply(config, { kind: 'addLayout', profile: 'other', serial: KEY, pageName: 'Main' });
  assert.deepEqual(pagesOf(config, 'other').map((p) => p.panel?.preset), ['medium']);
});

check('New page: the grid picked; with none picked, the deck\'s default; a Stream Deck\'s page has none and refuses one', () => {
  const config = withDeck();
  const picked = apply(config, { kind: 'addPage', profile: 'default', serial: KEY, name: 'Small one', panel: SMALL }) as { pageId: string };
  assert.equal(config.profiles.default.layouts[KEY].pages[picked.pageId].panel?.preset, 'small');
  const plain = apply(config, { kind: 'addPage', profile: 'default', serial: KEY, name: 'Plain' }) as { pageId: string };
  assert.equal(config.profiles.default.layouts[KEY].pages[plain.pageId].panel?.preset, 'medium');
  const xl = apply(config, { kind: 'addPage', profile: 'default', serial: 'XL', name: 'Second' }) as { pageId: string };
  assert.equal(config.profiles.default.layouts.XL.pages[xl.pageId].panel, undefined);
  assert.throws(() => apply(config, { kind: 'addPage', profile: 'default', serial: 'XL', name: 'Third', panel: SMALL }), /virtual deck/);
  validateConfig(structuredClone(config));
});

check('Change layout…: one page re-gridded, keys by row and column, the rest dropped; other pages and the default untouched', () => {
  const config = withDeck();
  const other = apply(config, { kind: 'addPage', profile: 'default', serial: KEY, name: 'Other' }) as { pageId: string };
  const page = firstPage(config, 'default');
  // Medium on this screen is 3 × 8: k1 is row 0 column 0, k24 row 2 column 7. Large is 2 × 5.
  config.profiles.default.layouts[KEY].pages[page].buttons = { k1: { label: 'Corner' }, k10: { label: 'Second row' }, k24: { label: 'Gone' } };
  apply(config, { kind: 'setPagePanel', profile: 'default', serial: KEY, page, panel: LARGE });
  const changed = config.profiles.default.layouts[KEY].pages[page];
  assert.equal(changed.panel?.preset, 'large');
  assert.deepEqual(changed.buttons, { k1: { label: 'Corner' }, k7: { label: 'Second row' } }, 'row 1 column 1 is k7 on a 2 × 5 grid');
  assert.equal(config.profiles.default.layouts[KEY].pages[other.pageId].panel?.preset, 'medium', 'only that page');
  assert.equal(config.decks?.[KEY]?.virtual?.panel?.preset, 'medium', 'the deck\'s default is not the page\'s');
  assert.throws(() => apply(config, { kind: 'setPagePanel', profile: 'default', serial: 'XL', page: 'main', panel: SMALL }), /not a virtual deck/);
  validateConfig(structuredClone(config));
});

check('Tap again keeps the default size', () => {
  const config = withDeck();
  apply(config, { kind: 'repairVirtualDeck', key: KEY, output: 'DP-5', touch: TOUCH });
  assert.deepEqual(config.decks?.[KEY]?.virtual?.panel, MEDIUM);
});

check('Remove keeps every page with its size; added again, its pages are used as they are and the kept size is the default', () => {
  const config = withDeck();
  apply(config, { kind: 'addProfile', name: 'Later', serials: [KEY], pageName: 'Main' });
  apply(config, { kind: 'setPagePanel', profile: 'default', serial: KEY, page: firstPage(config, 'default'), panel: SMALL });
  apply(config, { kind: 'removeVirtualDeck', key: KEY });
  const sizes = Object.values(config.profiles).flatMap((p) => Object.values(p.layouts[KEY]?.pages ?? {}).map((page) => page.panel?.preset));
  assert.deepEqual(sizes.sort(), ['medium', 'small']);
  validateConfig(structuredClone(config));
  apply(config, { kind: 'addVirtualDeck', key: KEY, output: 'DP-4', touch: TOUCH, profile: 'default', panel: LARGE, pageName: 'Main' });
  assert.equal(pagesOf(config, 'default')[0].panel?.preset, 'small', 'the kept page as it was');
  assert.ok(['small', 'medium'].includes(String(config.decks?.[KEY]?.virtual?.panel?.preset)), 'a kept size, not the one the picker defaulted to');
});

check('migration: a page takes its profile\'s own panel, else the deck\'s default; the layout\'s goes; buttons untouched', () => {
  const config: Config = {
    decks: { [KEY]: { virtual: { output: 'DP-4', panel: structuredClone(MEDIUM) } }, XL: {} },
    profiles: {
      own: { layouts: { [KEY]: { panel: structuredClone(SMALL), pages: { a: { buttons: { k1: { label: 'A' } } }, b: { buttons: {} } } } } },
      follows: { layouts: { [KEY]: { pages: { m: { buttons: { k3: { label: 'M' } } } } }, XL: { pages: { x: { buttons: { '0': { label: 'X' } } } } } } },
    },
  };
  const before = structuredClone(config);
  assert.equal(migratePagePanels(config), true);
  assert.deepEqual(Object.values(config.profiles.own.layouts[KEY].pages).map((p) => p.panel), [SMALL, SMALL]);
  assert.equal(config.profiles.own.layouts[KEY].panel, undefined);
  assert.deepEqual(config.profiles.follows.layouts[KEY].pages.m.panel, MEDIUM);
  assert.deepEqual(config.profiles.follows.layouts.XL, before.profiles.follows.layouts.XL, 'a Stream Deck\'s layout untouched');
  assert.deepEqual(config.profiles.own.layouts[KEY].pages.a.buttons, before.profiles.own.layouts[KEY].pages.a.buttons);
  assert.notEqual(config.profiles.own.layouts[KEY].pages.a.panel, config.profiles.own.layouts[KEY].pages.b.panel, 'each page its own copy');
  assert.equal(migratePagePanels(config), false, 'a second run changes nothing');
  validateConfig(structuredClone(config));
});

check('migration of a config from before defaults: the deck is given the first profile\'s panel as its default, and every page keeps what it showed', () => {
  const config: Config = {
    decks: { [KEY]: { virtual: { output: 'DP-4' } } },
    profiles: { a: { layouts: { [KEY]: { panel: structuredClone(SMALL), pages: { m: { buttons: {} } } } } }, b: { layouts: { [KEY]: { pages: { m: { buttons: {} } } } } } },
  };
  assert.equal(defaultPanelOf(config, KEY)?.preset, 'small');
  assert.equal(pagePanelIn(config, 'b', KEY, 'm')?.preset, 'small', 'before: the first profile\'s');
  migratePagePanels(config);
  assert.equal(config.decks?.[KEY]?.virtual?.panel?.preset, 'small');
  assert.equal(config.profiles.b.layouts[KEY].pages.m.panel?.preset, 'small', 'after: the same, now its own');
});

check('migration keeps a removed deck\'s layout with a panel, onto its pages', () => {
  const config: Config = { profiles: { a: { layouts: { [KEY]: { panel: structuredClone(LARGE), pages: { m: { buttons: {} } } } } } } };
  migratePagePanels(config);
  assert.equal(config.profiles.a.layouts[KEY].pages.m.panel?.preset, 'large');
  assert.equal(config.profiles.a.layouts[KEY].panel, undefined);
});

check('a page\'s own panel is what it shows, whatever its layout or the deck says', () => {
  const config = withDeck();
  const page = firstPage(config, 'default');
  config.profiles.default.layouts[KEY].pages[page].panel = structuredClone(SMALL);
  assert.equal(pagePanelIn(config, 'default', KEY, page)?.preset, 'small');
  assert.equal(pagePanelIn(config, 'default', KEY, 'no-such-page')?.preset, 'medium', 'a page not there yet: the default');
});

check('the editor draws a virtual deck\'s page at that page\'s grid, not the one the deck shows now; a Stream Deck at its own', () => {
  const config = withDeck();
  const small = apply(config, { kind: 'addPage', profile: 'default', serial: KEY, name: 'Small', panel: SMALL }) as { pageId: string };
  const first = firstPage(config, 'default');
  // The deck is on its first, Medium page; Copy to device or a link's key number may name the other.
  const daemon = {
    decks: [
      { serial: KEY, ...geometryOfPanel(MEDIUM, 'Panel') },
      { serial: 'XL', ...geometryOfPanel(undefined, 'Stream Deck XL'), keyCount: 32, rows: 4, columns: 8 },
    ],
  } as unknown as DaemonView;
  assert.equal(pageGeometry(config, daemon, KEY, 'default', first)?.keyCount, 24);
  assert.equal(pageGeometry(config, daemon, KEY, 'default', small.pageId)?.keyCount, 40, 'the page\'s own 4 × 10');
  assert.equal(pageGeometry(config, daemon, KEY, 'default', small.pageId)?.serial, KEY, 'still the deck\'s');
  assert.equal(pageGeometry(config, daemon, 'XL', 'default', 'main')?.keyCount, 32, 'a Stream Deck: the daemon\'s');
  assert.equal(pageGeometry(config, { decks: [] } as unknown as DaemonView, KEY, 'default', first), null, 'not described by the daemon: nothing drawn');
});

console.log(failures === 0 ? 'virtual panel: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
