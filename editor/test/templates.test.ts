// Templates (scope §7, round 2b): the list's arithmetic (src/shared/templates.ts),
// the template edits (src/main/config-document.ts), and the daemon's
// validation of config.json's "templates".

import assert from 'node:assert/strict';
import type { Config, PanelDef } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';
import { makePanel } from '../../src/panel-presets.js';
import { applyEdit } from '../src/main/config-document.js';
import type { Edit } from '../src/shared/edits.js';
import { fitScale, madeForAnother, newestFirst, positionedBox, pagePanelFromTemplate, renamedTemplate, templateLayout, withoutTemplate, withTemplate } from '../src/shared/templates.js';

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
const KEY = 'GRA-6e4e';
const mix: PanelDef = {
  size: { width: 1920, height: 720 },
  preset: 'free',
  controls: [
    { id: 'c1', x: 10, y: 10, w: 200, h: 200, shape: 'round', keepRatio: true },
    { id: 'c2', x: 300, y: 10, w: 400, h: 100, shape: 'rectangle', radius: 50 },
  ],
};

console.log('The list');
check('a template keeps the layout only: places, sizes, shapes, Lock proportions — nothing else', () => {
  const withExtras = { ...mix, controls: mix.controls.map((c) => ({ ...c, label: 'x', action: { type: 'noop' } })) } as unknown as PanelDef;
  assert.deepEqual(templateLayout(withExtras), mix);
});
check('saved newest last, listed newest first', () => {
  const list = withTemplate(withTemplate([], 'One', mix, false), 'Two', mix, false);
  assert.deepEqual(list.map((t) => t.name), ['One', 'Two']);
  assert.deepEqual(newestFirst(list).map((t) => t.name), ['Two', 'One']);
});
check('a name in use is refused unless replacing, ignoring case; replacing makes it the newest', () => {
  const list = withTemplate(withTemplate([], 'Mixer', mix, false), 'Pads', mix, false);
  assert.throws(() => withTemplate(list, ' mixer ', mix, false), /already a template called "Mixer"/);
  const replaced = withTemplate(list, 'mixer', { ...mix, controls: [mix.controls[0]] }, true);
  assert.deepEqual(replaced.map((t) => [t.name, t.panel.controls.length]), [['Pads', 2], ['mixer', 1]]);
});
check('no name, a name too long, or no controls: refused', () => {
  assert.throws(() => withTemplate([], '  ', mix, false), /needs a name/);
  assert.throws(() => withTemplate([], 'x'.repeat(65), mix, false), /at most 64/);
  assert.throws(() => withTemplate([], 'Empty', { ...mix, controls: [] }, false), /no controls/);
});
check('rename in place, refused onto another\'s name; delete', () => {
  const list = withTemplate(withTemplate([], 'Mixer', mix, false), 'Pads', mix, false);
  assert.deepEqual(renamedTemplate(list, 'mixer', 'Desk').map((t) => t.name), ['Desk', 'Pads']);
  assert.deepEqual(renamedTemplate(list, 'Mixer', 'MIXER').map((t) => t.name), ['MIXER', 'Pads']);
  assert.throws(() => renamedTemplate(list, 'Mixer', 'pads'), /already a template called "Pads"/);
  assert.deepEqual(withoutTemplate(list, 'MIXER').map((t) => t.name), ['Pads']);
  assert.throws(() => withoutTemplate(list, 'Nope'), /no template/);
});
check('a page from a template is a copy at its own canvas; scaled to fit another screen, centred', () => {
  const t = withTemplate([], 'Wide', { ...mix, size: { width: 2560, height: 720 } }, false)[0];
  const panel = pagePanelFromTemplate(t);
  assert.deepEqual(panel.size, { width: 2560, height: 720 });
  assert.notEqual(panel.controls, t.panel.controls);
  assert.equal(madeForAnother(panel.size, SCREEN), true);
  assert.equal(madeForAnother(mix.size, SCREEN), false);
  assert.equal(fitScale(panel.size, SCREEN), 0.75);
});
check('outside Edit layout too, a layout from another screen is fitted inside the screen first, never straight into a frame its header widened', () => {
  // A portrait screen, its frame widened by the header to 400 × 600; a landscape template on it.
  const portrait = { width: 720, height: 1920 };
  const room = { width: 400, height: 600 };
  // The screen fills 225 × 600 of that room; the template is the screen's full width, as the deck shows it.
  assert.deepEqual(positionedBox({ width: 2560, height: 720 }, room, portrait), { width: 225, height: 63 });
  // A layout made for this screen, or no screen known: fitted to the room, as before.
  assert.deepEqual(positionedBox(portrait, room, portrait), { width: 225, height: 600 });
  assert.deepEqual(positionedBox({ width: 2560, height: 720 }, room, null), { width: 400, height: 112 });
});

console.log('The edits and the daemon\'s validation');
let n = 0;
const env = { homeDir: '/home/test', randomHex: () => (n++).toString(16).padStart(4, '0') };
const base = (): Config =>
  validateConfig({
    decks: { [KEY]: { virtual: { output: 'DP-4', panel: makePanel(SCREEN, 'medium') } } },
    profiles: { p: { layouts: { [KEY]: { pages: { main: { panel: structuredClone(mix), buttons: { c1: { label: 'Mic' } } } } } } } },
  });
const apply = (config: Config, edit: Edit) => {
  applyEdit(config, edit, env);
  return validateConfig(config);
};
check('saveTemplate, renameTemplate and deleteTemplate pass the daemon\'s validation; the page is untouched', () => {
  let c = apply(base(), { kind: 'saveTemplate', name: 'Mixer', panel: mix, replace: false });
  assert.deepEqual(c.templates, [{ name: 'Mixer', panel: mix }]);
  assert.throws(() => apply(c, { kind: 'saveTemplate', name: 'MIXER', panel: mix, replace: false }), /already a template/);
  c = apply(c, { kind: 'renameTemplate', name: 'Mixer', to: 'Desk' });
  assert.deepEqual(c.templates!.map((t) => t.name), ['Desk']);
  c = apply(c, { kind: 'deleteTemplate', name: 'desk' });
  assert.deepEqual(c.templates, []);
  assert.deepEqual(c.profiles.p.layouts[KEY].pages.main.buttons, { c1: { label: 'Mic' } });
});
check('a page added from a template: custom, every control empty', () => {
  const c = apply(base(), { kind: 'addPage', profile: 'p', serial: KEY, name: 'From it', panel: pagePanelFromTemplate({ name: 'Mixer', panel: mix }) });
  const page = Object.values(c.profiles.p.layouts[KEY].pages).find((p) => p.name === 'From it')!;
  assert.equal(page.panel!.preset, 'free');
  assert.deepEqual(page.buttons, {});
});
check('the daemon refuses templates that are not a list, two with one name, or one with no controls', () => {
  const ok = { ...base() } as Config;
  assert.throws(() => validateConfig({ ...ok, templates: {} }), /must be a list/);
  assert.throws(() => validateConfig({ ...ok, templates: [{ name: 'A', panel: mix }, { name: ' a', panel: mix }] }), /two templates are called/);
  assert.throws(() => validateConfig({ ...ok, templates: [{ name: 'A', panel: { ...mix, controls: [] } }] }), /has no controls/);
  assert.throws(() => validateConfig({ ...ok, templates: [{ name: '', panel: mix }] }), /needs a "name"/);
  assert.throws(() => validateConfig({ ...ok, templates: [{ name: 'Off', panel: { ...mix, controls: [{ id: 'c1', x: 1900, y: 0, w: 100, h: 10 }] } }] }), /lie on the canvas/);
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ntemplates: all checks passed');
