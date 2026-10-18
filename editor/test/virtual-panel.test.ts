// A virtual deck's default size, and each profile's own (src/panel-presets.ts
// panelIn; the edits in src/main/config-document.ts). Found on both machines,
// 2026-10-17: a profile created after a virtual deck was added gave the deck
// no panel ("0 keys, no screens"), and Settings could not size it.

import assert from 'node:assert/strict';
import type { Config } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';
import { defaultPanelOf, makePanel, panelIn } from '../../src/panel-presets.js';
import { applyEdit } from '../src/main/config-document.js';
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

check('adding a virtual deck gives it a default size; its layout has no size of its own', () => {
  const config = withDeck();
  assert.deepEqual(config.decks?.[KEY]?.virtual?.panel, MEDIUM);
  assert.equal(config.profiles.default.layouts[KEY].panel, undefined);
  assert.equal(panelIn(config, 'default', KEY)?.controls.length, 24);
  validateConfig(structuredClone(config));
});

check('a profile created after the deck: a blank page at the full default size, never no panel', () => {
  const config = withDeck();
  const { profileId } = apply(config, { kind: 'addProfile', name: 'Test', serials: ['XL', KEY], pageName: 'Main' }) as { profileId: string };
  const layout = config.profiles[profileId].layouts[KEY];
  assert.ok(layout, 'the deck has a layout in the new profile');
  assert.deepEqual(Object.values(layout.pages).map((p) => Object.keys(p.buttons).length), [0], 'one blank page');
  assert.equal(panelIn(config, profileId, KEY)?.controls.length, 24, 'at the default size');
  validateConfig(structuredClone(config));
});

check('a layout added later (the editor\'s blank page) takes the default too', () => {
  const config = withDeck();
  config.profiles.other = { name: 'Other', layouts: {} };
  apply(config, { kind: 'addLayout', profile: 'other', serial: KEY, pageName: 'Main' });
  assert.equal(config.profiles.other.layouts[KEY].panel, undefined);
  assert.equal(panelIn(config, 'other', KEY)?.controls.length, 24);
});

check('one profile\'s own size: resized from the default it showed, keys by row and column; others unchanged', () => {
  const config = withDeck();
  config.profiles.second = { name: 'Second', layouts: { [KEY]: { pages: { main: { name: 'Main', buttons: {} } } } } };
  config.profiles.default.layouts[KEY].pages[Object.keys(config.profiles.default.layouts[KEY].pages)[0]].buttons = { k1: { label: 'First' } };
  apply(config, { kind: 'setPanel', profile: 'default', serial: KEY, panel: SMALL });
  const layout = config.profiles.default.layouts[KEY];
  assert.equal(layout.panel?.preset, 'small');
  assert.deepEqual(Object.values(layout.pages)[0].buttons, { k1: { label: 'First' } });
  assert.equal(panelIn(config, 'second', KEY)?.preset, 'medium', 'the other profile still follows the default');
});

check('a size for a profile with no layout for the deck yet: a layout made, with that size', () => {
  const config = withDeck();
  config.profiles.empty = { name: 'Empty', layouts: {} };
  apply(config, { kind: 'setPanel', profile: 'empty', serial: KEY, panel: LARGE });
  assert.equal(config.profiles.empty.layouts[KEY].panel?.preset, 'large');
  assert.equal(Object.keys(config.profiles.empty.layouts[KEY].pages).length, 1);
});

check('the default changed: every profile without its own follows, keys kept by row and column; one with its own does not', () => {
  const config = withDeck();
  const { profileId } = apply(config, { kind: 'addProfile', name: 'Later', serials: [KEY], pageName: 'Main' }) as { profileId: string };
  const page = Object.keys(config.profiles[profileId].layouts[KEY].pages)[0];
  config.profiles[profileId].layouts[KEY].pages[page].buttons = { k1: { label: 'Corner' }, k24: { label: 'Gone' } };
  config.profiles.own = { name: 'Own', layouts: { [KEY]: { panel: structuredClone(SMALL), pages: { main: { name: 'Main', buttons: {} } } } } };
  apply(config, { kind: 'setDefaultPanel', key: KEY, panel: LARGE });
  assert.equal(config.decks?.[KEY]?.virtual?.panel?.preset, 'large');
  assert.equal(config.profiles[profileId].layouts[KEY].panel, undefined, 'still following the default');
  assert.deepEqual(config.profiles[profileId].layouts[KEY].pages[page].buttons, { k1: { label: 'Corner' } }, 'a key with no place in the new size dropped');
  assert.equal(panelIn(config, profileId, KEY)?.preset, 'large');
  assert.equal(config.profiles.own.layouts[KEY].panel?.preset, 'small');
});

check('Tap again keeps the default size', () => {
  const config = withDeck();
  apply(config, { kind: 'repairVirtualDeck', key: KEY, output: 'DP-5', touch: TOUCH });
  assert.deepEqual(config.decks?.[KEY]?.virtual?.panel, MEDIUM);
});

check('Remove keeps every layout with a size: each following the default takes it as its own; added again, the kept one is the default', () => {
  const config = withDeck();
  apply(config, { kind: 'addProfile', name: 'Later', serials: [KEY], pageName: 'Main' });
  apply(config, { kind: 'removeVirtualDeck', key: KEY });
  for (const profile of Object.values(config.profiles)) {
    if (profile.layouts[KEY]) assert.equal(profile.layouts[KEY].panel?.preset, 'medium');
  }
  validateConfig(structuredClone(config));
  apply(config, { kind: 'addVirtualDeck', key: KEY, output: 'DP-4', touch: TOUCH, profile: 'default', panel: SMALL, pageName: 'Main' });
  assert.equal(config.decks?.[KEY]?.virtual?.panel?.preset, 'medium', 'the kept size, not the one the picker defaulted to');
});

check('a config from before defaults: the first profile\'s panel is the default', () => {
  const config: Config = {
    decks: { [KEY]: { virtual: { output: 'DP-4' } } },
    profiles: { a: { layouts: { [KEY]: { panel: structuredClone(SMALL), pages: { m: { buttons: {} } } } } }, b: { layouts: { [KEY]: { pages: { m: { buttons: {} } } } } } },
  };
  assert.equal(defaultPanelOf(config, KEY)?.preset, 'small');
  assert.equal(panelIn(config, 'b', KEY)?.preset, 'small');
});

console.log(failures === 0 ? 'virtual panel: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
