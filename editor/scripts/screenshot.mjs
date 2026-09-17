// Render the editor against the M3 test harness and save a PNG of the window,
// so the layout can be looked at without the real decks or the installed
// daemon (M4 phase A, step 3). Never touches the real config: it is copied.
//
// Usage (from editor/, after npm run build):
//   node scripts/screenshot.mjs --out shot.png [--config path/to/config.json] [--select <key index>[,<index>...]] [--deck <serial>] [--disconnected <serial>] [--tab icon] [--open newprofile|delete|keymenu] [--page <page name>] [--search <text>] [--collapse] [--recent <folder> ...]
//
// --tab icon opens the inspector's Icon tab, which lists real folders under
// your home directory (read-only) for any ~/ icon path in the config.
//
// Each deck the config has a layout for is attached as a fake deck. Its
// geometry is a test choice, not device knowledge: a serial whose layouts use
// a key index of 15 or more gets an XL grid (8×4 @ 96 px), any other a
// 15-key grid (5×3 @ 72 px). The real daemon reads geometry from the device.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

// Keep the harness's live key faces (now playing, media) off the real session
// bus, where they would read whatever players are running on the desktop: run
// under dbus-run-session, a private and empty bus. (Pointing the bus address at
// nothing instead crashed the daemon's mpris service — see docs/code-state.md.)
// The private bus has no service directories: Electron asks the bus for the
// desktop portal and accessibility at startup, and a normal session config
// starts xdg-desktop-portal-kde and ksecretd on it, which then outlive the run
// (seen 2026-09-15). With nothing to activate, those requests just fail.
if (!process.env.DECKHAND_SCREENSHOT_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-screenshot-bus-${process.pid}.conf`);
  await fs.writeFile(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${os.tmpdir()}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const rerun = spawnSync('dbus-run-session', [`--config-file=${busConfig}`, '--', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, DECKHAND_SCREENSHOT_PRIVATE_BUS: '1' },
  });
  await fs.rm(busConfig, { force: true });
  process.exit(rerun.status ?? 1);
}

const repoRoot = path.join(import.meta.dirname, '..', '..');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, scratchDir } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    config: { type: 'string', default: path.join(repoRoot, 'config.example.json') },
    select: { type: 'string' },
    deck: { type: 'string' },
    disconnected: { type: 'string' },
    tab: { type: 'string' },
    // 'newprofile' or 'delete': open one of B1's panels before capturing;
    // 'keymenu': B3's right-click menu on the last --select key.
    open: { type: 'string' },
    // Select a page tab by its label before anything else.
    page: { type: 'string' },
    // Type this into the library's search box before capturing.
    search: { type: 'string' },
    // Start with every library section collapsed, to show search reaching into them.
    collapse: { type: 'boolean' },
    recent: { type: 'string', multiple: true },
  },
});
if (!values.out) {
  console.error('usage: node scripts/screenshot.mjs --out shot.png [--config config.json] [--select <key index>] [--deck <serial>] [--tab icon]');
  process.exit(2);
}

const text = await fs.readFile(values.config, 'utf8');
const config = JSON.parse(text);
const scratch = await scratchDir();
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
await fs.writeFile(path.join(configDir, 'config.json'), text);

const daemon = await startDaemon(scratch, config);
const serials = new Set(Object.values(config.profiles).flatMap((p) => Object.keys(p.layouts)));
for (const serial of serials) {
  if (serial === values.disconnected) continue; // left unattached, to show a disconnected deck
  const highest = Math.max(
    -1,
    ...Object.values(config.profiles)
      .flatMap((p) => Object.values(p.layouts[serial]?.pages ?? {}))
      .flatMap((page) => Object.keys(page.buttons).map(Number)),
  );
  const fake = highest >= 15 ? new FakeDeck() : new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Stream Deck' });
  await daemon.attach(serial, fake);
}

if (values.select !== undefined) process.env.DECKHAND_EDITOR_SELECT_KEY = values.select;
if (values.deck !== undefined) process.env.DECKHAND_EDITOR_SELECT_DECK = values.deck;
if (values.tab !== undefined) process.env.DECKHAND_EDITOR_SELECT_TAB = values.tab;
if (values.open !== undefined) process.env.DECKHAND_EDITOR_OPEN = values.open;
if (values.page !== undefined) process.env.DECKHAND_EDITOR_PAGE = values.page;
if (values.search !== undefined) process.env.DECKHAND_EDITOR_SEARCH = values.search;
// Seed the collapse state the way the editor stores it, so search can be shown
// finding actions inside sections that are shut.
if (values.collapse) {
  const editorState = path.join(scratch, 'state', 'editor');
  await fs.mkdir(editorState, { recursive: true });
  const groups = ['Keyboard', 'Navigation', 'Media', 'Audio', 'System'];
  await fs.writeFile(path.join(editorState, 'preferences.json'), JSON.stringify({ collapsedLibrary: groups }, null, 2) + '\n');
}
// Seed the picker's recent folders, so a screenshot can show the chips.
if (values.recent?.length) {
  const editorState = path.join(scratch, 'state', 'editor');
  await fs.mkdir(editorState, { recursive: true });
  await fs.writeFile(path.join(editorState, 'icon-picker.json'), JSON.stringify({ recentFolders: values.recent.map((f) => path.resolve(f)) }, null, 2) + '\n');
}
process.env.DECKHAND_EDITOR_SCREENSHOT = path.resolve(values.out);
const output = await runElectronCheck('screenshot', {
  configDir,
  stateDir: path.join(scratch, 'state'),
  socket: daemon.socket,
});

await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
if (!output.report) {
  console.error(`no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  process.exit(1);
}
console.log(JSON.stringify(output.report.renderer, null, 2));
console.log(`screenshot: ${output.report.screenshot?.path} (${output.report.screenshot?.width}×${output.report.screenshot?.height})`);
// The harness's services (audio subscriber, D-Bus) keep Node alive otherwise.
process.exit(output.report.screenshot?.width ? 0 : 1);
