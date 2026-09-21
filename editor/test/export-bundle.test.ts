// Export (M5 piece 1, src/main/export-bundle.ts): which icon paths a config
// names, what goes in the zip, and what is refused. Runs against a scratch
// HOME, so `~/` and the manifest's `home` are the scratch directory.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-export-'));
const home = path.join(scratch, 'home');
await fs.mkdir(path.join(home, 'Pictures', 'ffxiv job'), { recursive: true });
await fs.mkdir(path.join(home, 'a folder'), { recursive: true });
process.env.HOME = home; // os.homedir() reads it on every call

const { buildExport, iconReferences, suggestedExportName, writeExport } = await import('../src/main/export-bundle.js');
const { CONFIG_ENTRY, MANIFEST_ENTRY } = await import('../src/shared/backup.js');

let failures = 0;
// Awaits the check body: an async body passed to a check that does not await
// can never fail (CLAUDE.md, "Known landmines").
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const png = Buffer.from('not really a png, but bytes are bytes');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
await fs.writeFile(path.join(home, 'Pictures', 'ffxiv job', 'Dove (new).png'), png);
await fs.writeFile(path.join(home, 'mic.svg'), svg);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function configWith(buttons: Record<string, unknown>) {
  return { profiles: { default: { name: 'Default', layouts: { SERIAL: { startPage: 'main', pages: { main: { name: 'Main', buttons } } } } } } };
}
const BUTTONS = {
  0: { icon: '~/Pictures/ffxiv job/Dove (new).png', label: 'icon.png', action: { type: 'hotkey', keys: 'ctrl+1' } },
  // The same file by its absolute path: one entry in the zip, two manifest rows.
  1: { icon: `${home}/Pictures/ffxiv job/Dove (new).png` },
  2: { action: { type: 'audio.micMute', iconMuted: '~/mic.svg', iconUnmuted: 'builtin:mic' } },
  3: { icon: 'builtin:play', action: { type: 'media.control', method: 'next', iconPlaying: '~/gone.png', iconPaused: '' } },
  4: { action: { type: 'multi', steps: [{ type: 'audio.mute', iconMuted: 'relative.png' }] }, onRelease: { type: 'audio.mute', iconUnmuted: '~/a folder' } },
  5: { icon: null, label: 'label only' },
};
const CONFIG = configWith(BUTTONS);
const CONFIG_TEXT = JSON.stringify(CONFIG, null, 2) + '\n';

await check('every icon field is found wherever it is: keys, action pairs, onRelease, multi steps; each once; labels and empty strings are not icons', () => {
  assert.deepEqual(iconReferences(CONFIG), [
    '~/Pictures/ffxiv job/Dove (new).png',
    `${home}/Pictures/ffxiv job/Dove (new).png`,
    '~/mic.svg',
    'builtin:mic',
    'builtin:play',
    '~/gone.png',
    'relative.png',
    '~/a folder',
  ]);
  assert.deepEqual(iconReferences(configWith({ 0: { icon: '~/x.png' }, 1: { icon: '~/x.png' } })), ['~/x.png']);
});

await check("a latching toggle's two icons are found and bundled", async () => {
  const toggle = configWith({ 0: { action: { type: 'toggle', keys: 'shift', iconOn: '~/mic.svg', iconOff: 'builtin:toggle-off' } } });
  assert.deepEqual(iconReferences(toggle), ['~/mic.svg', 'builtin:toggle-off']);
  const { zip } = await buildExport(JSON.stringify(toggle, null, 2) + '\n', true);
  const manifest = JSON.parse(strFromU8(unzipSync(zip)[MANIFEST_ENTRY]));
  const bundled = manifest.icons.find((i: { path: string }) => i.path === '~/mic.svg');
  assert.ok(bundled?.entry, `iconOn not bundled: ${JSON.stringify(manifest.icons)}`);
  assert.deepEqual(Buffer.from(unzipSync(zip)[bundled.entry]), svg);
});

await check('with icons: config.json byte for byte, the manifest, and each file once, byte for byte', async () => {
  const { zip, manifest, iconFiles } = await buildExport(CONFIG_TEXT, true);
  const files = unzipSync(zip);
  assert.equal(strFromU8(files[CONFIG_ENTRY]), CONFIG_TEXT);
  assert.deepEqual(JSON.parse(strFromU8(files[MANIFEST_ENTRY])), manifest);
  const icons = Object.keys(files).filter((n) => n.startsWith('icons/')).sort();
  assert.deepEqual(icons, ['icons/001-Dove__new_.png', 'icons/002-mic.svg']);
  assert.equal(iconFiles, 2);
  assert.deepEqual(Buffer.from(files['icons/001-Dove__new_.png']), png);
  assert.deepEqual(Buffer.from(files['icons/002-mic.svg']), svg);
  assert.equal(Object.keys(files).length, 4);
});

await check('the manifest: format, home, every path as the config writes it, missing ones with why, built-ins by name', async () => {
  const { manifest } = await buildExport(CONFIG_TEXT, true);
  assert.equal(manifest.format, 'deckhand-export');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.home, home);
  assert.equal(manifest.includesIcons, true);
  assert.ok(!Number.isNaN(Date.parse(manifest.exportedAt)));
  assert.deepEqual(manifest.icons, [
    { path: '~/Pictures/ffxiv job/Dove (new).png', entry: 'icons/001-Dove__new_.png', sha256: sha(png), size: png.length },
    { path: `${home}/Pictures/ffxiv job/Dove (new).png`, entry: 'icons/001-Dove__new_.png', sha256: sha(png), size: png.length },
    { path: '~/mic.svg', entry: 'icons/002-mic.svg', sha256: sha(svg), size: svg.length },
  ]);
  assert.deepEqual(manifest.missing, [
    { path: '~/gone.png', reason: 'not found' },
    { path: 'relative.png', reason: 'not an absolute path' },
    { path: '~/a folder', reason: 'not a file' },
  ]);
  assert.deepEqual(manifest.builtins, ['mic', 'play']);
});

await check('config only: no icon files, but each icon still recorded with its hash and size', async () => {
  const { zip, manifest, iconFiles } = await buildExport(CONFIG_TEXT, false);
  const files = unzipSync(zip);
  assert.deepEqual(Object.keys(files).sort(), [CONFIG_ENTRY, MANIFEST_ENTRY].sort());
  assert.equal(iconFiles, 0);
  assert.equal(manifest.includesIcons, false);
  assert.deepEqual(manifest.icons.map((i) => i.entry), [null, null, null]);
  assert.equal(manifest.icons[2].sha256, sha(svg));
});

await check('a config with no icons exports: just config.json and the manifest', async () => {
  const text = JSON.stringify(configWith({}), null, 2) + '\n';
  const files = unzipSync((await buildExport(text, true)).zip);
  assert.deepEqual(Object.keys(files).sort(), [CONFIG_ENTRY, MANIFEST_ENTRY].sort());
});

await check('refused: text that is not JSON, and a config the daemon would refuse', async () => {
  await assert.rejects(buildExport('{ nope', true), /not valid JSON/);
  await assert.rejects(buildExport(JSON.stringify({ profiles: 5 }), true));
  await assert.rejects(buildExport(JSON.stringify({ decks: { X: { pages: {} } } }), true), /./);
});

await check('written whole or not at all: the file appears by rename, and nothing is left beside it', async () => {
  const out = path.join(scratch, 'out');
  await fs.mkdir(out);
  const { zip } = await buildExport(CONFIG_TEXT, true);
  await writeExport(path.join(out, 'backup.zip'), zip);
  assert.deepEqual(await fs.readdir(out), ['backup.zip']);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(out, 'backup.zip'))), zip);
  await assert.rejects(writeExport(path.join(scratch, 'no-such-folder', 'backup.zip'), zip));
  assert.deepEqual(await fs.readdir(out), ['backup.zip']);
});

await check('the suggested name: dated, and marked when it has no icons', () => {
  const day = new Date(2026, 8, 19, 23, 59);
  assert.equal(suggestedExportName(true, day), 'deckhand-2026-09-19.zip');
  assert.equal(suggestedExportName(false, day), 'deckhand-2026-09-19-config.zip');
});

await fs.rm(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
