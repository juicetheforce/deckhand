// Offline test of round 4's editor half: a config from before the icon scale
// converted when the store opens it (src/icon-fit.ts), the new edits —
// a key's icon scale and background, and Settings › General › Appearance —
// and the font list read from fontconfig's output (src/main/fonts.ts).
// Bundled by scripts/run-tests.mjs and run with plain Node — no Electron.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/main/config-store.js';
import { familiesFrom } from '../src/main/fonts.js';
import { keyBoxOf } from '../src/renderer/model.js';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-editor-appearance-'));
let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A PNG's first 24 bytes are enough for its size (src/image-size.ts). */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let n = 0;
async function storeWith(config: unknown): Promise<{ store: ConfigStore; file: string }> {
  const dir = path.join(TMP, `c${++n}`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
  const store = await ConfigStore.open({ configPath: file, debounceMs: 20, env: { homeDir: TMP, randomHex: () => 'beef' } });
  return { store, file };
}

await fs.writeFile(path.join(TMP, 'wide.png'), png(200, 100));
await fs.writeFile(path.join(TMP, 'square.png'), png(56, 56));

const OLD = {
  defaults: { iconFit: 'cover', labelSize: 16 },
  profiles: {
    p: {
      layouts: {
        SD: {
          pages: {
            m: {
              buttons: {
                0: { icon: '~/wide.png', label: 'Wide' },
                1: { icon: '~/square.png' },
                2: { icon: '~/wide.png', iconFit: 'contain' },
                3: { icon: '~/gone.png' },
              },
            },
          },
        },
      },
    },
  },
};

await check('opening a config from before the icon scale converts it and saves it: each image by its own size', async () => {
  const { store, file } = await storeWith(OLD);
  try {
    await sleep(150);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const b = saved.profiles.p.layouts.SD.pages.m.buttons;
    assert.equal(saved.version, 2);
    assert.deepEqual(b[0], { icon: '~/wide.png', label: 'Wide', iconScale: 200 }, 'a 2:1 image under the old crop keeps its look at 200%');
    assert.deepEqual(b[1], { icon: '~/square.png' }, 'a square image: nothing to write');
    assert.deepEqual(b[2], { icon: '~/wide.png' }, 'contain is 100%, written as nothing');
    assert.deepEqual(b[3], { icon: '~/gone.png' }, 'an image that cannot be read gets no number');
    assert.deepEqual(saved.defaults, { labelSize: 16 }, 'defaults.iconFit dropped, the rest kept');
    assert.equal(store.state().dirty, false);
  } finally {
    store.close();
  }
});

await check('a converted config is opened as it is, nothing written', async () => {
  const { store, file } = await storeWith({ version: 2, profiles: OLD.profiles });
  const before = await fs.readFile(file, 'utf8');
  try {
    await sleep(150);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(store.state().dirty, false);
  } finally {
    store.close();
  }
});

const at = { profile: 'p', serial: 'SD', page: 'm', key: '1' };
await check('setIconScale: 20–200, null removes it; a new icon starts afresh, so Clear icon returns a key to following', async () => {
  const { store } = await storeWith({ version: 2, profiles: OLD.profiles });
  try {
    const button = () => store.state().config.profiles.p.layouts.SD.pages.m.buttons['1'];
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: 150 }).ok, true);
    assert.equal(button().iconScale, 150);
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: 19 }).ok, false);
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: 205 }).ok, false);
    assert.equal(button().iconScale, 150, 'a refused one changes nothing');
    assert.equal(store.apply({ kind: 'setIcon', at, icon: { kind: 'default' } }).ok, true);
    assert.equal(button(), undefined, 'Clear icon: no icon, no scale, nothing left on the key');
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: 60 }).ok, true);
    assert.equal(store.apply({ kind: 'setIcon', at, icon: { kind: 'file', path: path.join(TMP, 'wide.png') } }).ok, true);
    assert.equal(button().iconScale, undefined, 'another icon starts at 100%');
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: 60 }).ok, true);
    assert.equal(store.apply({ kind: 'setIconScale', at, percent: null }).ok, true);
    assert.equal(button().iconScale, undefined);
  } finally {
    store.close();
  }
});

await check('setKeyBackground: a hex colour, lower-cased; null is Default; anything else refused', async () => {
  const { store } = await storeWith({ version: 2, profiles: OLD.profiles });
  try {
    const button = () => store.state().config.profiles.p.layouts.SD.pages.m.buttons['1'];
    assert.equal(store.apply({ kind: 'setKeyBackground', at, color: '#1D2A4A' }).ok, true);
    assert.equal(button().background, '#1d2a4a');
    assert.equal(store.apply({ kind: 'setKeyBackground', at, color: 'red' }).ok, false);
    assert.equal(store.apply({ kind: 'setKeyBackground', at, color: null }).ok, true);
    assert.deepEqual(button(), { icon: '~/square.png' });
  } finally {
    store.close();
  }
});

await check('setAppearance: label font, Touch feedback and Key colour in defaults; their defaults written as nothing', async () => {
  const { store } = await storeWith({ version: 2, profiles: OLD.profiles });
  try {
    const d = () => store.state().config.defaults;
    assert.equal(store.apply({ kind: 'setAppearance', patch: { labelFont: 'Fira Sans', touchFeedback: false, keyColor: '#2B2350' } }).ok, true);
    assert.deepEqual(d(), { labelFont: 'Fira Sans', touchFeedback: false, background: '#2b2350' });
    assert.equal(store.apply({ kind: 'setAppearance', patch: { labelFont: "Bad'Font" } }).ok, false, 'a name that could end its CSS string');
    assert.equal(store.apply({ kind: 'setAppearance', patch: { keyColor: 'blue' } }).ok, false);
    assert.equal(store.apply({ kind: 'setAppearance', patch: { labelFont: null, touchFeedback: true, keyColor: '#101014' } }).ok, true);
    assert.equal(d(), undefined, 'every default back: no defaults left at all');
  } finally {
    store.close();
  }
});

await check('the font list: one per family, the family\'s own name, A to Z, hidden and unusable names left out', async () => {
  const list = ['Cantarell,Cantarell Extra Bold', 'Cantarell', 'DejaVu Sans', 'noto sans', 'Noto Sans', '.Hidden', "Bad'Name", 'Fira Sans,Fira Sans Light', '', 'Ubuntu Mono'].join('\n');
  assert.deepEqual(familiesFrom(list), ['Cantarell', 'DejaVu Sans', 'Fira Sans', 'noto sans', 'Ubuntu Mono']);
});

await check('a key\'s box for its mark: a virtual control at its size and shape, a Stream Deck key square', async () => {
  const virtual = { units: 'pixels' as const, keys: [{ id: 'c1', w: 119, h: 135, shape: 'hexagon', radius: undefined }] };
  assert.deepEqual(keyBoxOf(virtual as never, 'c1'), { w: 119, h: 135, shape: 'hexagon', radius: undefined });
  assert.deepEqual(keyBoxOf({ units: 'cells', keys: [{ id: '3', w: 1, h: 1 }] } as never, '3'), { w: 1, h: 1 });
  assert.equal(keyBoxOf(null, '3'), null);
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? 'appearance: all checks passed' : `appearance: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
