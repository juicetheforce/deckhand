// Sliders and dials in the editor (round 5): new controls' physical sizes
// (shared/layout-edit.ts addControl), a template keeping a slider
// (shared/templates.ts), keys landing only on their own family
// (shared/bulk.ts, DeckGrid's keyDropRefused), and the setLayer, setAngles
// and button-only refusal edits (main/config-document.ts).

import assert from 'node:assert/strict';
import type { Config, PanelDef } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';
import { mmToPx } from '../../src/panel-presets.js';
import { DIAL_MM, NEEDS_VALUE, SLIDER_MM } from '../../src/value-controls.js';
import { applyEdit } from '../src/main/config-document.js';
import type { Edit } from '../src/shared/edits.js';
import { addControl, duplicateControl, layoutChanges, setShape } from '../src/shared/layout-edit.js';
import { templateLayout } from '../src/shared/templates.js';
import { copyKeys, keyDropRefused, placeClipboard, placeOnControls } from '../src/shared/bulk.js';

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

const SCREEN = { width: 1920, height: 720, widthMm: 243, heightMm: 91 };
const free = (controls: PanelDef['controls'], size = { width: 1920, height: 720 }): PanelDef => ({ size, controls, preset: 'free' });

console.log('new controls');
check('a slider is about 14 × 60 mm, upright, centred where it was dropped', () => {
  const { panel, id } = addControl(free([]), 'slider', { x: 400, y: 360 }, SCREEN);
  const c = panel.controls.find((k) => k.id === id)!;
  assert.equal(c.kind, 'slider');
  assert.ok(Math.abs(c.w - mmToPx(SCREEN, SLIDER_MM.across)) <= 1, `width ${c.w}`);
  assert.ok(Math.abs(c.h - mmToPx(SCREEN, SLIDER_MM.along)) <= 1, `height ${c.h}`);
  assert.ok(Math.abs(c.x + c.w / 2 - 400) <= 1 && Math.abs(c.y + c.h / 2 - 360) <= 1);
});
check('…never longer than three-quarters of the panel\'s shorter side (an 800 × 480, 5" panel)', () => {
  const small = { width: 800, height: 480, widthMm: 108, heightMm: 65 };
  const { panel, id } = addControl(free([], { width: 800, height: 480 }), 'slider', { x: 400, y: 240 }, small);
  const c = panel.controls.find((k) => k.id === id)!;
  assert.ok(c.h <= 480 * 0.75 + 0.5, `height ${c.h}`);
});
check('a dial is about 25 mm across, a square rectangle, keeping its proportions', () => {
  const { panel, id } = addControl(free([]), 'dial', { x: 900, y: 360 }, SCREEN);
  const c = panel.controls.find((k) => k.id === id)!;
  assert.equal(c.kind, 'dial');
  assert.equal(c.shape, undefined, 'a rectangle (Ryan, 2026-11-22): no round dial');
  assert.equal(c.keepRatio, true);
  assert.ok(Math.abs(c.w - mmToPx(SCREEN, DIAL_MM)) <= 1 && c.w === c.h, `${c.w} × ${c.h}`);
});
check('a slider is never made round or hexagon; it keeps its kind through a duplicate; turning it is a change Discard counts', () => {
  const { panel, id } = addControl(free([]), 'slider', { x: 400, y: 360 }, SCREEN);
  assert.equal(setShape(panel, id, 'round'), panel, 'round refused: the same panel');
  assert.equal(setShape(panel, id, 'hexagon'), panel, 'hexagon refused');
  assert.equal(setShape(free([{ id: 'b', x: 0, y: 0, w: 50, h: 50 }]), 'b', 'round').controls[0].shape, 'round', 'a button still can');
  assert.equal(duplicateControl(panel, { buttons: {} }, id)!.panel.controls[1].kind, 'slider');
  const turned = { ...panel, controls: panel.controls.map((c) => ({ ...c, direction: 'horizontal' as const })) };
  assert.equal(layoutChanges(panel, turned).moved, 1);
});
check('a template keeps a slider, its direction and touch, and a dial', () => {
  const t = templateLayout(free([{ id: 's', x: 0, y: 0, w: 60, h: 240, kind: 'slider', direction: 'horizontal', touch: 'jump' }, { id: 'd', x: 100, y: 0, w: 100, h: 100, kind: 'dial', radius: 12 }]));
  assert.deepEqual(t.controls[0], { id: 's', x: 0, y: 0, w: 60, h: 240, kind: 'slider', direction: 'horizontal', touch: 'jump' });
  assert.deepEqual(t.controls[1], { id: 'd', x: 100, y: 0, w: 100, h: 100, radius: 12, kind: 'dial' });
});

console.log('keys land only on their own family');
const grid = { keys: [{ id: 'b', row: 0, column: 0 }, { id: 's', row: 0, column: 1, kind: 'slider' as const }, { id: 'd', row: 0, column: 2, kind: 'dial' as const }] };
const layout = { pages: { main: { buttons: {} } } };
const page = { buttons: { b: { label: 'B', action: { type: 'hotkey', keys: 'a' } }, s: { label: 'S', action: { type: 'audio.volume' } } } };
check('a slider\'s key pasted onto a dial lands; onto a button it is skipped and named', () => {
  const clip = copyKeys(page, grid, ['s'])!;
  assert.equal(clip.keys[0].kind, 'slider');
  assert.deepEqual(placeOnControls(clip, ['d'], layout, grid).writes.map((w) => w.key), ['d']);
  const onButton = placeOnControls(clip, ['b'], layout, grid);
  assert.equal(onButton.writes.length, 0);
  assert.equal(onButton.wrongKind.length, 1);
});
check('a button\'s key pasted by row and column onto a slider is skipped, not written', () => {
  const clip = copyKeys(page, grid, ['b'])!;
  const placed = placeClipboard(clip, { row: 0, column: 1 }, grid, layout);
  assert.equal(placed.writes.length, 0);
  assert.equal(placed.wrongKind.length, 1);
});
check('a drag: refused across families, with the board\'s words for a button-only action', () => {
  assert.equal(keyDropRefused('slider', 'audio.volume', 'dial'), null);
  assert.equal(keyDropRefused(undefined, 'hotkey', undefined), null);
  assert.equal(keyDropRefused(undefined, 'hotkey', 'slider'), NEEDS_VALUE);
  assert.match(keyDropRefused(undefined, 'audio.volume', 'dial') ?? '', /goes only on a button/);
  assert.match(keyDropRefused('dial', 'brightness', undefined) ?? '', /only on a slider or dial/);
});

console.log('the edits');
const KEY = 'GRA-6e4e';
function config(): Config {
  return validateConfig({
    decks: { [KEY]: { virtual: { output: 'DP-4' } } },
    profiles: {
      p: {
        layouts: {
          [KEY]: {
            pages: {
              main: {
                panel: free([{ id: 's', x: 0, y: 0, w: 60, h: 240, kind: 'slider' }, { id: 'd', x: 100, y: 0, w: 100, h: 100, kind: 'dial' }, { id: 'b', x: 300, y: 0, w: 100, h: 100 }]),
                buttons: {},
              },
            },
          },
        },
      },
    },
  });
}
const env = { homeDir: '/home/test', randomHex: () => '0000' };
const apply = (c: Config, edit: Edit) => {
  applyEdit(c, edit, env);
  return validateConfig(c);
};
const at = (key: string) => ({ profile: 'p', serial: KEY, page: 'main', key });
const buttons = (c: Config) => c.profiles.p.layouts[KEY].pages.main.buttons;
check('a layer set to a file, to None, and back to built-in', () => {
  const c = config();
  apply(c, { kind: 'setLayer', at: at('s'), layer: 'thumb', icon: { kind: 'file', path: '/home/test/cap.png' } });
  assert.equal(buttons(c).s.layers?.thumb, '~/cap.png');
  apply(c, { kind: 'setLayer', at: at('s'), layer: 'background', icon: { kind: 'file', path: '/home/test/scale.png' } });
  assert.equal(buttons(c).s.layers?.background, '~/scale.png');
  apply(c, { kind: 'setLayer', at: at('s'), layer: 'thumb', icon: { kind: 'default' } });
  apply(c, { kind: 'setLayer', at: at('s'), layer: 'background', icon: { kind: 'default' } });
  assert.equal(buttons(c).s, undefined, 'nothing left: no key at all');
  apply(c, { kind: 'setLayer', at: at('d'), layer: 'base', icon: { kind: 'none' } });
  assert.equal(buttons(c).d.layers?.base, null, "a dial's base may be None");
});
check('the level: off, a colour, back to shown in the action\'s colour stores nothing; never on a button', () => {
  const c = config();
  apply(c, { kind: 'setLevel', at: at('s'), show: false, color: null });
  assert.deepEqual(buttons(c).s.level, { show: false });
  apply(c, { kind: 'setLevel', at: at('s'), show: true, color: '#FF8800' });
  assert.deepEqual(buttons(c).s.level, { color: '#ff8800' });
  apply(c, { kind: 'setLevel', at: at('s'), show: true, color: null });
  assert.equal(buttons(c).s, undefined, 'the default level is no field, and no key');
  assert.throws(() => apply(c, { kind: 'setLevel', at: at('b'), show: false, color: null }), /only a slider or dial/);
  assert.throws(() => apply(c, { kind: 'setLevel', at: at('s'), show: true, color: 'red' }), /#rrggbb/);
});
check('None only where the board allows it; no layer a button or the other kind lacks', () => {
  const c = config();
  assert.throws(() => apply(c, { kind: 'setLayer', at: at('s'), layer: 'thumb', icon: { kind: 'none' } }), /cannot be none/);
  assert.throws(() => apply(c, { kind: 'setLayer', at: at('s'), layer: 'background', icon: { kind: 'none' } }), /cannot be none/, 'no image is the default, not None');
  assert.throws(() => apply(c, { kind: 'setLayer', at: at('s'), layer: 'knob', icon: { kind: 'default' } }), /no knob layer/);
  assert.throws(() => apply(c, { kind: 'setLayer', at: at('b'), layer: 'thumb', icon: { kind: 'default' } }), /no thumb layer/);
});
check('angles: set, back to the defaults with null; the knob back to built-in takes them with it', () => {
  const c = config();
  apply(c, { kind: 'setAngles', at: at('d'), angles: { start: -90, end: 90 } });
  assert.deepEqual(buttons(c).d.angles, { start: -90, end: 90 });
  apply(c, { kind: 'setLayer', at: at('d'), layer: 'knob', icon: { kind: 'file', path: '/home/test/k.png' } });
  apply(c, { kind: 'setLayer', at: at('d'), layer: 'knob', icon: { kind: 'default' } });
  assert.equal(buttons(c).d, undefined);
  assert.throws(() => apply(c, { kind: 'setAngles', at: at('d'), angles: { start: 0, end: 5 } }), /at least 10/);
  assert.throws(() => apply(c, { kind: 'setAngles', at: at('s'), angles: { start: -90, end: 90 } }), /only a dial/);
});
check('a button-only action is refused on a slider or dial, here as in the drop; a value action is taken', () => {
  const c = config();
  assert.throws(() => apply(c, { kind: 'assignAction', at: at('s'), action: { type: 'hotkey', keys: 'a' } }), new RegExp(NEEDS_VALUE));
  assert.throws(() => apply(c, { kind: 'setAction', at: at('d'), action: { type: 'media.control' } }), new RegExp(NEEDS_VALUE));
  apply(c, { kind: 'setAction', at: at('s'), action: { type: 'audio.volume' } });
  apply(c, { kind: 'assignAction', at: at('b'), action: { type: 'hotkey', keys: 'a' } });
  assert.equal(buttons(c).s.action?.type, 'audio.volume');
  assert.equal(buttons(c).b.action?.type, 'hotkey');
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nvalue controls: all checks passed');
