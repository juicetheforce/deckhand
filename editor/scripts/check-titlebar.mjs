// Ship piece 4: the editor's own title bar, end to end in real Electron.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus. Every button is clicked in the page, as a person would; what the window
// did is read from the main process, and what the bar draws from the page.
//
// What this cannot check: anything the compositor does — dragging, resizing
// from the edges, double-click to maximise, the right-click window menu, and
// focus. Check windows are never shown, so they are never focused; that is
// the maintainer's to look at on the installed editor (docs/code-state.md).
//
// Usage: npm run check:titlebar   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_TITLEBAR_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-titlebar-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const XL = 'TITLEBAR-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: { default: { name: 'Default', layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } } } } },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

/** The editor bar's buttons, in order, by the label a screen reader would read. */
const BUTTONS = "[...document.querySelectorAll('.titlebar .titlebar-button')].map((b) => b.getAttribute('aria-label'))";
const clickBar = (label) =>
  `(() => { const b = document.querySelector('.titlebar [aria-label=${JSON.stringify(label)}]'); if (!b) throw new Error('no ${label} button'); b.click(); return true; })()`;
const middleLabel = (editor) => inPage(editor, 'editor', "document.querySelectorAll('.titlebar .titlebar-button')[1]?.getAttribute('aria-label') ?? null");
const barReady = (editor) => until(async () => (await inPage(editor, 'editor', "document.querySelector('.titlebar') !== null")) === true);

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await barReady(editor);

r.bar = await inPage(
  editor,
  'editor',
  `(() => {
    const bar = document.querySelector('.titlebar');
    const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion;
    return {
      buttons: ${BUTTONS},
      barRegion: region(bar),
      buttonRegions: [...bar.querySelectorAll('button')].map(region),
      logo: bar.querySelector('.titlebar-logo')?.getAttribute('src') ?? null,
      logoLoaded: bar.querySelector('.titlebar-logo')?.naturalWidth > 0,
      middleText: bar.textContent.trim(),
      aboveToolbar: bar.compareDocumentPosition(document.querySelector('.toolbar')) === Node.DOCUMENT_POSITION_FOLLOWING,
      focused: bar.dataset.focused,
    };
  })()`,
);

// Maximise: main maximises, and the button turns into Restore from the event.
await inPage(editor, 'editor', clickBar('Maximise'));
r.maximised = await until(async () => (await stateOf(editor)).maximised === true, 5000);
r.labelWhenMaximised = await until(async () => (await middleLabel(editor)) === 'Restore', 5000);

// A reload is not a maximise event: the bar must read the state when it mounts.
await inPage(editor, 'editor', 'setTimeout(() => location.reload(), 50), true');
await sleep(500);
await barReady(editor);
await sleep(300);
r.labelAfterReload = await middleLabel(editor);

// Restore: the same button, now a toggle back. Clicked by position, not by its
// label, so a bar still drawing Maximise here fails the check above by name
// rather than stopping the run.
await inPage(editor, 'editor', "document.querySelectorAll('.titlebar .titlebar-button')[1].click(), true");
r.restored = await until(async () => (await stateOf(editor)).maximised === false, 5000);
r.labelWhenRestored = await until(async () => (await middleLabel(editor)) === 'Maximise', 5000);

// Minimise: that main was asked, and accepted it. Not whether the window ended up
// minimised — a check window is never shown, and minimising a window that was
// never mapped only sometimes takes (1 run in 6); that is the maintainer's to see.
await inPage(editor, 'editor', clickBar('Minimise'));
r.minimiseObeyed = await until(() => editor.reports.some((x) => x.event === 'windowControl' && x.action === 'minimise' && x.from === 'editor' && x.obeyed), 5000);

// Close, with close-to-tray on (the default): to the tray, through the launcher.
await inPage(editor, 'editor', clickBar('Close'));
r.closedToTray = await until(async () => {
  const s = await stateOf(editor);
  return !s.windowOpen && !s.holding && s.windows === 0;
});
r.stillRunning = editor.exited === null;
editor.send('click');
r.reopened = await until(async () => (await stateOf(editor)).windowOpen);
editor.child.kill();

check('the editor bar sits above the toolbar: the logo on the left, Minimise, Maximise, Close on the right, nothing between', () => {
  assert.deepEqual(r.bar.buttons, ['Minimise', 'Maximise', 'Close']);
  assert.equal(r.bar.aboveToolbar, true);
  assert.match(r.bar.logo ?? '', /deckhand-small.*\.svg$/);
  assert.equal(r.bar.logoLoaded, true, 'the logo file loads (the page CSP allows it)');
  assert.equal(r.bar.middleText, '', 'no title text in the bar');
});
check('the bar moves the window and its buttons do not', () => {
  assert.equal(r.bar.barRegion, 'drag');
  assert.deepEqual(r.bar.buttonRegions, ['no-drag', 'no-drag', 'no-drag']);
});
check('an unfocused window draws the bar dimmed (a check window is never focused)', () => assert.equal(r.bar.focused, 'false'));
check('Maximise maximises the window and the button becomes Restore', () => {
  assert.equal(r.maximised, true);
  assert.equal(r.labelWhenMaximised, true);
});
check('after a reload, a maximised window still draws Restore', () => assert.equal(r.labelAfterReload, 'Restore'));
check('Restore restores it and the button becomes Maximise again', () => {
  assert.equal(r.restored, true);
  assert.equal(r.labelWhenRestored, true);
});
check('Minimise reaches the main process, which accepts it from the editor window (not whether it minimised: see above)', () => assert.equal(r.minimiseObeyed, true));
check('Close goes to the tray, as closing the window always has; the tray opens it again', () => {
  assert.equal(r.closedToTray, true);
  assert.equal(r.stillRunning, true);
  assert.equal(r.reopened, true);
});

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
