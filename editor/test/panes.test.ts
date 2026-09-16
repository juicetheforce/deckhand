// The resizable panes (M4 phase A refinements; scope §10): the width maths.
// Widths are deliberately not persisted, so there is no state file here.

import assert from 'node:assert/strict';
import { clampPane, DIVIDER_WIDTH, PANE_LIMITS, paneColumns, widthWhileDragging } from '../src/renderer/panes.js';

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

await check('widths are held within each pane\'s limits, and rounded to whole pixels', () => {
  assert.equal(clampPane('library', 10), PANE_LIMITS.library.min);
  assert.equal(clampPane('library', 9999), PANE_LIMITS.library.max);
  assert.equal(clampPane('inspector', 400.4), 400);
  assert.equal(clampPane('inspector', Number.NaN), PANE_LIMITS.inspector.default);
  assert.ok(PANE_LIMITS.inspector.default > PANE_LIMITS.library.default, 'the inspector holds the icon grid, so it starts wider');
});

await check('dragging: the library follows the pointer, the inspector opposes it, both stop at their limits', () => {
  assert.equal(widthWhileDragging('library', 230, 40), 270);
  assert.equal(widthWhileDragging('library', 230, -40), 190);
  assert.equal(widthWhileDragging('inspector', 340, -40), 380, 'dragging left widens the inspector');
  assert.equal(widthWhileDragging('inspector', 340, 40), 300);
  assert.equal(widthWhileDragging('library', 230, -9999), PANE_LIMITS.library.min);
  assert.equal(widthWhileDragging('inspector', 340, -9999), PANE_LIMITS.inspector.max);
});

await check('the grid template has a track for each pane and each divider', () => {
  assert.equal(paneColumns({ library: 230, inspector: 340 }), `230px ${DIVIDER_WIDTH}px minmax(0, 1fr) ${DIVIDER_WIDTH}px 340px`);
});

console.log(failures === 0 ? '\npanes: all checks passed' : `\npanes: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
