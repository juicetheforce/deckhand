// The app settings (Ship piece 3, src/shared/settings.ts): what is stored is
// read safely, what the settings window sends is cleaned, and the Default deck
// list offers every deck the editor knows.

import assert from 'node:assert/strict';
import type { Config } from '../../src/types.js';
import type { DecksResult } from '../../src/control/protocol.js';
import { ACCENTS, cleanSettingsPatch, deckOptions, DEFAULT_SETTINGS, readSettings } from '../src/shared/settings.js';

let failures = 0;
async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

await check('nothing stored: the defaults — Automatic, close to tray on, blue', () => {
  assert.deepEqual(readSettings({}), { defaultDeck: null, closeToTray: true, accent: 'blue' });
  assert.deepEqual(DEFAULT_SETTINGS, { defaultDeck: null, closeToTray: true, accent: 'blue' });
});

await check('stored settings are read; anything of the wrong kind is its default, and other preferences are ignored', () => {
  assert.deepEqual(readSettings({ defaultDeck: 'CL37', closeToTray: false, accent: 'teal', bookmarks: ['/x'] }), { defaultDeck: 'CL37', closeToTray: false, accent: 'teal' });
  assert.deepEqual(readSettings({ defaultDeck: 7, closeToTray: 'no', accent: 'orange' }), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ defaultDeck: '' }), DEFAULT_SETTINGS);
});

await check('a change from the settings window keeps only valid settings', () => {
  assert.deepEqual(cleanSettingsPatch({ accent: 'purple' }), { accent: 'purple' });
  assert.deepEqual(cleanSettingsPatch({ defaultDeck: null }), { defaultDeck: null }, 'null is Automatic, and must get through');
  assert.deepEqual(cleanSettingsPatch({ closeToTray: false, bookmarks: [], accent: '#ff0000', defaultDeck: 3 }), { closeToTray: false });
  assert.deepEqual(cleanSettingsPatch(null), {});
  assert.deepEqual(cleanSettingsPatch('accent'), {});
});

await check('the accents are the four of mockup 6a, blue first', () => {
  assert.deepEqual(ACCENTS.map((a) => [a.name, a.hex]), [['blue', '#5b6ee8'], ['purple', '#8b5fd6'], ['teal', '#2e9e8f'], ['sky', '#4a8fd9']]);
});

await check('Default deck offers only connected decks — in config order, then any config does not know — named where config names them', () => {
  const config = {
    decks: { NAMED: { name: 'Stream Deck XL' } },
    profiles: { a: { name: 'A', layouts: { NAMED: { pages: {} }, LAYOUT_ONLY: { pages: {} } } }, b: { name: 'B', layouts: { OTHER_PROFILE: { pages: {} } } } },
  } as unknown as Config;
  const decks = [
    { serial: 'PLUGGED_IN', productName: 'Stream Deck Mini' },
    { serial: 'OTHER_PROFILE', productName: 'Stream Deck' },
    { serial: 'NAMED', productName: 'Stream Deck XL' },
  ] as unknown as DecksResult;
  assert.deepEqual(
    deckOptions(config, decks).map((d) => [d.serial, d.label]),
    [
      ['NAMED', 'Stream Deck XL'],
      ['OTHER_PROFILE', 'Stream Deck'],
      ['PLUGGED_IN', 'Stream Deck Mini'],
    ],
  );
  // LAYOUT_ONLY is configured and not plugged in: not offered.
  assert.deepEqual(deckOptions(config, null), []);
  assert.deepEqual(deckOptions(null, null), []);
});

console.log(failures === 0 ? '\nsettings: all checks passed' : `\nsettings: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
