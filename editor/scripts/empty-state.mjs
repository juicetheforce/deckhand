// Open a real editor window in one of the empty states, to look at. Not a
// check — check-empty.mjs is the check; this is for eyes.
//
// The point of it: the states this piece exists for cannot be seen on the
// working machine without unplugging both decks, and the maintainer would rather not.
// Everything here is scratch — its own config, its own state directory and
// its own socket — so the installed daemon keeps driving the real decks and
// the installed editor is untouched. Because Electron's single-instance lock
// is per userData, and userData comes from DECKHAND_STATE_DIR, this window is
// a separate instance: it will not raise the installed editor or be raised by
// it.
//
// Usage, from editor/ after npm run build:
//
//   node scripts/empty-state.mjs --state never-configured
//
// States:
//   daemon-down       the socket is not answering
//   never-configured  the empty configuration, nothing plugged in
//   all-unplugged     two decks configured, neither plugged in
//   no-layout         a fresh install with one deck plugged into it
//   deck-unplugged    two decks configured, one of them missing — which is
//                     now shown by that deck simply not being in the list
//   normal            a configured deck, connected — the control case
//
// Press Ctrl-C in this terminal to finish. Closing the window is not enough:
// the editor closes to the tray like the installed one does,
// so it is still running, with its own tray icon beside the real one.
//
// The scratch directory is one fixed path, wiped at the start of every run
// rather than only at the end. Electron's helper processes outlive the one
// that is killed by a moment and write to userData on their way out, which
// recreated the directory just after it was deleted; reusing one path makes
// that harmless instead of leaving a new empty directory behind each time.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const STATES = ['daemon-down', 'never-configured', 'all-unplugged', 'no-layout', 'deck-unplugged', 'normal'];

const { values } = parseArgs({ options: { state: { type: 'string', default: 'never-configured' } } });
if (!STATES.includes(values.state)) {
  console.error(`--state must be one of: ${STATES.join(', ')}`);
  process.exit(2);
}

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');

const XL = 'DEMO-XL-0001';
const V2 = 'DEMO-V2-0002';
const page = { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { label: 'Hello' } } } } };
const withLayouts = (...serials) => ({
  decks: { [XL]: { name: 'Stream Deck XL' }, [V2]: { name: 'Original V2' } },
  profiles: { default: { name: 'Default', layouts: Object.fromEntries(serials.map((s) => [s, page])) } },
  startProfile: 'default',
});
const EMPTY = { profiles: { default: { name: 'Default', layouts: {} } }, startProfile: 'default' };

/** What each state needs: a config, whether a daemon runs, and which decks are where. */
const SETUP = {
  'daemon-down': { config: EMPTY, daemon: false, attach: [], connectedNoLayout: [] },
  'never-configured': { config: EMPTY, daemon: true, attach: [], connectedNoLayout: [] },
  'all-unplugged': { config: withLayouts(XL, V2), daemon: true, attach: [], connectedNoLayout: [] },
  'no-layout': { config: EMPTY, daemon: true, attach: [], connectedNoLayout: [V2] },
  'deck-unplugged': { config: withLayouts(XL, V2), daemon: true, attach: [XL], connectedNoLayout: [] },
  normal: { config: withLayouts(XL), daemon: true, attach: [XL], connectedNoLayout: [] },
};

const WHAT_TO_LOOK_FOR = {
  'daemon-down': 'The pill reads "Daemon not running". One message, not two: the banner that normally says the same thing stands down.',
  'never-configured': 'Pill: "No decks connected". The dropdown says "No decks" and is greyed. Nothing offers to add a layout.',
  'all-unplugged': 'Pill: "No decks connected" — not "Not connected", although a configured deck is selected. The text names both decks.',
  'no-layout': 'The one state that offers a button, and it names the deck: "Add a layout for Original V2".',
  'deck-unplugged': 'The Original V2 is configured and not plugged in, so it is NOT in the Device list at all — only the XL is. Its absence is the indicator.',
  normal: 'The control case: a grid, and a green "Connected" pill.',
};

const setup = SETUP[values.state];
const scratch = path.join(os.tmpdir(), `deckhand-empty-state-${process.getuid?.() ?? 0}`);
await fs.rm(scratch, { recursive: true, force: true });
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(setup.config, null, 2) + '\n');

// After the config directory exists: dist/config.js reads DECKHAND_CONFIG_DIR
// when it is first imported, and control-harness.mjs imports it.
process.env.DECKHAND_CONFIG_DIR = configDir;
const harness = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { geometryOf } = await import(pathToFileURL(path.join(repoRoot, 'dist/geometry.js')).href);

let daemon = null;
let socket = path.join(scratch, 'no-daemon.sock');
if (setup.daemon) {
  daemon = await harness.startDaemon(scratch, setup.config);
  socket = daemon.socket;
  for (const serial of setup.attach) {
    await daemon.attach(serial, new harness.FakeDeck(serial === V2 ? { columns: 5, rows: 3, pixels: 72, model: 'originalv2' } : {}));
  }
  // A connected deck no profile has a layout for lives in `unattached`, which
  // is what the real daemon does with it (src/index.ts attach()).
  for (const serial of setup.connectedNoLayout) {
    daemon.unattached.set(serial, geometryOf(new harness.FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2' })));
  }
  daemon.events.state();
}

console.log(`\n  state:  ${values.state}`);
console.log(`  look:   ${WHAT_TO_LOOK_FOR[values.state]}`);
console.log(`  scratch: ${scratch}`);
console.log('\n  Nothing here touches the installed daemon, the installed editor or your decks.');
console.log('  Ctrl-C here to finish — closing the window only sends it to the tray.\n');

const env = {
  ...process.env,
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: path.join(scratch, 'state'),
  DECKHAND_SOCKET: socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
// VS Code sets this for processes started from its extension host, and it
// turns the Electron binary into plain Node with no BrowserWindow.
// Every way of launching Electron has to clear it. Deleted rather than set to
// undefined, which some Node versions pass through as the string "undefined".
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [editorRoot], { env, stdio: 'inherit' });

// Ctrl-C is at least as likely a way out as closing the window, and without
// this it leaves the scratch directory and a live Electron behind.
let cleaned = false;
const cleanUp = async () => {
  if (cleaned) return;
  cleaned = true;
  // Bounded, deliberately. control.stop() waits on its open connections, and
  // the editor is one of them — on Ctrl-C the editor is still connected, so
  // this waited for ever and the scratch directory was never removed. The
  // directory matters more than a tidy socket shutdown in a scratch daemon.
  await Promise.race([daemon?.stop().catch(() => undefined) ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2000))]);
  await fs.rm(scratch, { recursive: true, force: true });
};
const exited = new Promise((resolve) => child.on('exit', resolve));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // SIGKILL, not SIGTERM: Electron does not always go on the first ask, and
    // leaving a window behind pointed at a directory just deleted is worse
    // than an abrupt exit for a scratch process.
    child.kill('SIGKILL');
    // Wait for it to be gone before deleting. Electron's helper processes
    // outlive the one that is killed by a moment and write to userData on
    // their way out, which recreated the directory after it was removed and
    // left an empty one behind every time.
    void Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
      .then(() => cleanUp())
      .then(() => process.exit(0));
  });
}

await exited;
await cleanUp();
