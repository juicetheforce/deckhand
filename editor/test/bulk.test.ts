// Offline test of where bulk operations put keys (src/shared/bulk.ts).
// Pure functions, plain Node. The geometries are the two real decks' shapes —
// XL 8×4 and Original V2 5×3, row-major as the library reports them — because
// the cross-geometry cases are the point.

import assert from 'node:assert/strict';
import type { LayoutDef, PageDef } from '../../src/types.js';
import {
  clearKeys,
  copyKeys,
  duplicateKeys,
  keyName,
  pasteAnchor,
  placeClipboard,
  rangeSelection,
  readingOrder,
  swapKeys,
  type KeyGrid,
} from '../src/shared/bulk.js';
import { keepResolvableNavigation } from '../src/shared/links.js';

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

function grid(columns: number, rows: number): KeyGrid {
  return { keys: Array.from({ length: columns * rows }, (_, i) => ({ index: i, row: Math.floor(i / columns), column: i % columns })) };
}
const XL = grid(8, 4);
const V2 = grid(5, 3);
const at = (g: KeyGrid, row: number, column: number) => g.keys.find((k) => k.row === row && k.column === column)!.index;

const hotkey = (keys: string, label?: string) => ({ ...(label ? { label } : {}), icon: `~/icons/${keys}.png`, action: { type: 'hotkey', keys } });
const layoutWith = (pages: Record<string, PageDef>): LayoutDef => ({ startPage: Object.keys(pages)[0], pages });

console.log('selection');

await check('reading order is row by row, whatever order the indices come in', () => {
  // A deck reporting keys out of order must still read left to right, top to bottom.
  const shuffled: KeyGrid = { keys: [...XL.keys].reverse() };
  assert.deepEqual(readingOrder(shuffled, [9, 0, 8, 1]), [0, 1, 8, 9]);
  assert.deepEqual(readingOrder(XL, [40]), [], 'an index not on the deck is dropped');
});

await check('shift+click selects the run between two keys, in either direction', () => {
  assert.deepEqual(rangeSelection(XL, 6, 9), [6, 7, 8, 9], 'wraps across a row end like text');
  assert.deepEqual(rangeSelection(XL, 9, 6), [6, 7, 8, 9]);
  assert.deepEqual(rangeSelection(XL, 3, 3), [3]);
});

console.log('copy and paste');

await check('copy keeps each key at its place relative to the top-left, and skips empty slots', () => {
  const page: PageDef = { buttons: { '9': hotkey('ctrl+1'), '18': hotkey('ctrl+2'), '11': {} } };
  // Keys 9 (row 1, col 1), 10 (empty), 11 ({}), 18 (row 2, col 2).
  const clip = copyKeys(page, XL, [18, 10, 9, 11])!;
  assert.deepEqual(clip.origin, { row: 1, column: 1 });
  assert.deepEqual(
    clip.keys.map((k) => [k.sourceIndex, k.rowOffset, k.columnOffset]),
    [
      [9, 0, 0],
      [18, 1, 1],
    ],
  );
  assert.equal(copyKeys(page, XL, [10, 11]), null, 'nothing but empty slots copies nothing');
});

await check('the clipboard holds a copy: editing the page afterwards does not change it', () => {
  const page: PageDef = { buttons: { '0': hotkey('ctrl+1', 'Jump') } };
  const clip = copyKeys(page, XL, [0])!;
  page.buttons['0'].label = 'Changed';
  assert.equal(clip.keys[0].button.label, 'Jump');
});

await check('paste lands with its top-left on the anchor and replaces what is there', () => {
  const layout = layoutWith({ main: { buttons: { '0': hotkey('ctrl+1'), '1': hotkey('ctrl+2'), '20': hotkey('f1', 'Old') } } });
  const clip = copyKeys(layout.pages.main, XL, [0, 1])!;
  const placed = placeClipboard(clip, { row: 2, column: 3 }, XL, layout);
  assert.deepEqual(
    placed.writes.map((w) => [w.index, w.button?.action?.keys]),
    [
      [19, 'ctrl+1'],
      [20, 'ctrl+2'],
    ],
  );
  assert.deepEqual(placed.skipped, []);
});

await check('the paste anchor is the first selected key in reading order, else where the keys came from', () => {
  const clip = copyKeys({ buttons: { '10': hotkey('a') } }, XL, [10])!;
  assert.deepEqual(pasteAnchor(XL, [30, 12], clip), { row: 1, column: 4 });
  assert.deepEqual(pasteAnchor(XL, [], clip), { row: 1, column: 2 });
});

await check('XL to Original V2: placed by row and column, and keys with no place are skipped', () => {
  const xlPage: PageDef = {
    buttons: {
      [at(XL, 0, 0)]: hotkey('ctrl+1', 'One'),
      [at(XL, 1, 4)]: hotkey('ctrl+2', 'Two'), // index 12 on the XL, index 9 on the V2
      [at(XL, 0, 6)]: hotkey('ctrl+3', 'Wide'), // column 6: the V2 has 5 columns
      [at(XL, 3, 0)]: hotkey('ctrl+4', 'Low'), // row 3: the V2 has 3 rows
    },
  };
  const clip = copyKeys(xlPage, XL, Object.keys(xlPage.buttons).map(Number))!;
  const target = layoutWith({ main: { buttons: {} } });
  const placed = placeClipboard(clip, clip.origin, V2, target);
  assert.deepEqual(
    placed.writes.map((w) => [w.index, w.button?.label]),
    [
      [0, 'One'],
      [9, 'Two'],
    ],
    'by index, "Two" would have gone to V2 key 12 — row 2, column 2 — which is the wrong place',
  );
  assert.deepEqual(placed.skipped.map((k) => k.button.label).sort(), ['Low', 'Wide']);
  assert.ok(placed.writes.every((w) => w.index < 15), 'nothing written past the V2 key count');
});

await check('a paste that runs off the right edge skips the overflow rather than wrapping onto the next row', () => {
  const layout = layoutWith({ main: { buttons: { '0': hotkey('a'), '1': hotkey('b'), '2': hotkey('c') } } });
  const clip = copyKeys(layout.pages.main, XL, [0, 1, 2])!;
  const placed = placeClipboard(clip, { row: 0, column: 6 }, XL, layout);
  assert.deepEqual(placed.writes.map((w) => w.index), [6, 7]);
  assert.equal(placed.skipped.length, 1);
});

console.log('navigation across layouts');

await check('Go to page keys keep a target that resolves in the destination, and lose one that does not', () => {
  const source = layoutWith({
    main: {
      buttons: {
        '0': { label: 'Combat', icon: '~/c.png', action: { type: 'page', to: 'pg_combat' } },
        '1': { label: 'Home', action: { type: 'page', to: 'main' } },
        '2': { label: 'Back', action: { type: 'page', back: true } },
        '3': { label: 'Both', action: { type: 'hotkey', keys: 'f1' }, onRelease: { type: 'page', to: 'pg_combat' } },
      },
    },
    pg_combat: { name: 'Combat', buttons: {} },
  });
  const destination = layoutWith({ main: { buttons: {} } }); // has "main", no "pg_combat"
  const clip = copyKeys(source.pages.main, V2, [0, 1, 2, 3])!;
  const placed = placeClipboard(clip, clip.origin, V2, destination);
  assert.deepEqual(placed.writes[0].button, { label: 'Combat', icon: '~/c.png' }, 'icon and label kept, navigation gone');
  assert.deepEqual(placed.writes[1].button?.action, { type: 'page', to: 'main' }, 'resolves there, so kept');
  assert.deepEqual(placed.writes[2].button?.action, { type: 'page', back: true }, 'back names no page');
  assert.deepEqual(placed.writes[3].button, { label: 'Both', action: { type: 'hotkey', keys: 'f1' } }, 'only onRelease lost');
  assert.deepEqual(placed.lostNavigation.map((l) => l.index), [0, 3]);
  // Pasted back into its own layout, nothing is lost.
  assert.deepEqual(placeClipboard(clip, clip.origin, V2, source).lostNavigation, []);
  // And the clipboard itself is untouched by the fixup.
  assert.deepEqual(clip.keys[0].button.action, { type: 'page', to: 'pg_combat' });
});

await check('a key with nothing left after losing its navigation is written as an empty slot', () => {
  const source = layoutWith({ main: { buttons: { '0': { action: { type: 'page', to: 'gone' } } } }, gone: { buttons: {} } });
  const placed = placeClipboard(copyKeys(source.pages.main, XL, [0])!, { row: 0, column: 0 }, XL, layoutWith({ main: { buttons: {} } }));
  assert.deepEqual(placed.writes, [{ index: 0, button: null }]);
});

await check('a multi action loses only the steps that go nowhere', () => {
  const layout = layoutWith({ main: { buttons: {} } });
  const multi = { type: 'multi', steps: [{ type: 'hotkey', keys: 'f1' }, { type: 'page', to: 'gone' }] };
  assert.deepEqual(keepResolvableNavigation(multi, layout), { action: { type: 'multi', steps: [{ type: 'hotkey', keys: 'f1' }] }, dropped: true });
  assert.equal(multi.steps.length, 2, 'the original is not modified');
  assert.deepEqual(keepResolvableNavigation({ type: 'multi', steps: [{ type: 'page', to: 'gone' }] }, layout), { action: undefined, dropped: true });
  const fine = { type: 'multi', steps: [{ type: 'page', to: 'main' }] };
  assert.equal(keepResolvableNavigation(fine, layout).action, fine);
});

console.log('duplicate, clear, swap');

await check('duplicate puts the copy in the next empty key after the original', () => {
  const page: PageDef = { buttons: { '3': hotkey('ctrl+1', 'Jump'), '4': hotkey('ctrl+2') } };
  const dup = duplicateKeys(page, XL, [3]);
  assert.ok(dup.ok);
  assert.deepEqual(dup.created, [5]);
  assert.deepEqual(dup.writes, [{ index: 5, button: page.buttons['3'] }]);
  assert.notEqual(dup.writes[0].button, page.buttons['3'], 'a copy, not the same object');
});

await check('duplicate wraps to the top of the page, and several keys each take their own slot', () => {
  const full = Object.fromEntries(XL.keys.map((k) => [String(k.index), hotkey(`f${k.index}`)]));
  delete full['0'];
  delete full['2'];
  const dup = duplicateKeys({ buttons: full }, XL, [31, 30]);
  assert.ok(dup.ok);
  assert.deepEqual(dup.created, [0, 2], 'key 30 wraps to 0, then key 31 to the next free, 2');
});

await check('duplicate is all or nothing when the page is short of empty keys', () => {
  const full = Object.fromEntries(V2.keys.map((k) => [String(k.index), hotkey(`f${k.index}`)]));
  delete full['14'];
  const one = duplicateKeys({ buttons: full }, V2, [0]);
  assert.ok(one.ok, 'one free key is enough for one');
  const two = duplicateKeys({ buttons: full }, V2, [0, 1]);
  assert.equal(two.ok, false);
  assert.match(two.ok ? '' : two.error, /needs 2 empty keys; this page has 1/);
  assert.equal(duplicateKeys({ buttons: full }, V2, [14]).ok, false, 'an empty selection has nothing to duplicate');
});

await check('clear empties only occupied selected keys; swap moves whole buttons both ways', () => {
  const page: PageDef = { buttons: { '0': hotkey('a'), '1': hotkey('b') } };
  assert.deepEqual(clearKeys(page, [0, 5, 0]), [{ index: 0, button: null }]);
  assert.deepEqual(swapKeys(page, 0, 1), [
    { index: 1, button: page.buttons['0'] },
    { index: 0, button: page.buttons['1'] },
  ]);
  assert.deepEqual(swapKeys(page, 0, 7), [
    { index: 7, button: page.buttons['0'] },
    { index: 0, button: null },
  ], 'onto an empty key is a move');
  assert.deepEqual(swapKeys(page, 1, 1), []);
});

await check('keys are named by label and by the number the deck shows', () => {
  assert.equal(keyName({ label: 'Jump' }, 20), '“Jump” (key 21)');
  assert.equal(keyName(undefined, 0), 'key 1');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
