// The editor's and the settings window's own title bars, end to
// end in real Electron.
//
// Driven like check-settings.mjs (scripts/lib/drive-editor.mjs), on a private
// bus. Every button is clicked in the page, as a person would; what the window
// did is read from the main process, and what the bar draws from the page.
//
// What this cannot check: anything the compositor does — dragging, resizing
// from the edges, double-click to maximise, the right-click window menu, and
// focus. Check windows are never shown, so they are never focused; those need
// checking by hand on an installed editor.
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
/**
 * Wait for the editor's bar and the toolbar under it; throws on a timeout,
 * since until() only returns false. Both, because the bar is outside App and
 * so is there while App is still loading — reading the page then threw on the
 * missing toolbar (1 run in 6, right after check:settings).
 */
async function barReady(editor) {
  const started = Date.now();
  const ready = "document.querySelector('.titlebar') !== null && document.querySelector('.toolbar') !== null";
  if (!(await until(async () => (await inPage(editor, 'editor', ready)) === true, 20_000)))
    throw new Error(`the editor's title bar and toolbar did not both appear within ${Date.now() - started} ms`);
}

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
// Every step below, in one try: a step that finds its window gone throws, and
// the checks after it must still fail by name rather than the run stopping.
try {
  if (!(await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000))) throw new Error('the editor never reported ready');
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
  // Marked first, so the wait below cannot find the old page's bar before the
  // reload has happened (it did, 1 run in 4: the check then passed a bar that
  // never read its state).
  await inPage(editor, 'editor', '(window.beforeReload = true, setTimeout(() => location.reload(), 50), true)');
  r.reloaded = await until(async () => (await inPage(editor, 'editor', "window.beforeReload !== true && document.querySelector('.titlebar') !== null")) === true);
  await barReady(editor);
  await sleep(300);
  r.labelAfterReload = await middleLabel(editor);

  // Restore: the same button, now a toggle back. Clicked by position, not by its
  // label, so a bar still drawing Maximise here fails the check above by name
  // rather than stopping the run.
  await inPage(editor, 'editor', "document.querySelectorAll('.titlebar .titlebar-button')[1].click(), true");
  r.restored = await until(async () => (await stateOf(editor)).maximised === false, 5000);
  r.labelWhenRestored = await until(async () => (await middleLabel(editor)) === 'Maximise', 5000);

  // Minimise: that main was asked, and accepted it. Not whether the window
  // ended up minimised — a check window is never shown, and minimising a window
  // that was never mapped only sometimes takes (1 run in 6); that needs
  // checking by hand.
  await inPage(editor, 'editor', clickBar('Minimise'));
  r.minimiseObeyed = await until(() => editor.reports.some((x) => x.event === 'windowControl' && x.action === 'minimise' && x.from === 'editor' && x.obeyed), 5000);

  // The settings window: its own bar, close only. Opened from the editor's gear.
  await inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
  await until(async () => (await stateOf(editor)).settingsOpen);
  await until(async () => (await inPage(editor, 'settings', "document.querySelector('.titlebar') !== null")) === true);
  r.settingsBar = await inPage(
    editor,
    'settings',
    `({ buttons: ${BUTTONS}, text: document.querySelector('.titlebar').textContent.trim(), gear: document.querySelector('.titlebar svg') !== null })`,
  );
  // Its page can still call the bridge directly: main refuses anything but close from it.
  await inPage(editor, 'settings', "window.deckhand.windowControl('minimise'), window.deckhand.windowControl('maximise'), true");
  r.settingsRefused = await until(
    () =>
      ['minimise', 'maximise'].every((action) => editor.reports.some((x) => x.event === 'windowControl' && x.action === action && x.from === 'settings' && x.obeyed === false)),
    5000,
  );
  r.settingsNeverObeyed = !editor.reports.some((x) => x.event === 'windowControl' && x.from === 'settings' && x.obeyed);
  r.editorNotMaximised = (await stateOf(editor)).maximised === false;
  // Its Close closes it, and only it.
  await inPage(editor, 'settings', clickBar('Close'));
  r.settingsClosed = await until(async () => {
    const s = await stateOf(editor);
    return !s.settingsOpen && s.windowOpen && s.windows === 1;
  });

  // Clicking into the editor closes the settings window (it cannot stay above
  // the editor on Wayland). The focus event is emitted from main: a check
  // window is never focused by the compositor.
  const settingsOpens = async () => {
    await inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
    return until(async () => (await stateOf(editor)).settingsOpen);
  };
  r.openedForFocus = await settingsOpens();
  // The editor focused without Settings having lost focus first — a stray
  // focus, not a click away from Settings — leaves it open.
  editor.send('focus-editor');
  await sleep(500);
  r.strayFocusIgnored = (await stateOf(editor)).settingsOpen;
  editor.send('click-editor');
  r.focusCloses = await until(async () => {
    const s = await stateOf(editor);
    return !s.settingsOpen && s.windowOpen && s.windows === 1;
  });
  // The gear with Settings open: clicking it moves focus to the editor first,
  // then opens Settings. One settings window must be open at the end, not
  // none, even with a stray editor focus after it.
  r.openedForGear = await settingsOpens();
  editor.send('click-editor');
  editor.send('settings');
  await sleep(500);
  editor.send('focus-editor');
  await sleep(500);
  r.afterGear = await stateOf(editor);
  editor.send('click-editor');
  await until(async () => !(await stateOf(editor)).settingsOpen);

  // Close, with close-to-tray on (the default): to the tray, through the launcher.
  await inPage(editor, 'editor', clickBar('Close'));
  r.closedToTray = await until(async () => {
    const s = await stateOf(editor);
    return !s.windowOpen && !s.holding && s.windows === 0;
  });
  r.stillRunning = editor.exited === null;
  editor.send('click');
  r.reopened = await until(async () => (await stateOf(editor)).windowOpen);
} catch (err) {
  r.stoppedAt = err.message;
  console.log(`the run stopped early: ${err.message}`);
}
editor.child.kill();

check('the run reached the end', () => assert.equal(r.stoppedAt, undefined));
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
check('after a reload, a maximised window still draws Restore', () => {
  assert.equal(r.reloaded, true, 'the page reloaded');
  assert.equal(r.labelAfterReload, 'Restore');
});
check('Restore restores it and the button becomes Maximise again', () => {
  assert.equal(r.restored, true);
  assert.equal(r.labelWhenRestored, true);
});
check('Minimise reaches the main process, which accepts it from the editor window (not whether it minimised: see above)', () => assert.equal(r.minimiseObeyed, true));
check('the settings window has its own bar: the gear and "Settings", and a Close button only', () => {
  assert.deepEqual(r.settingsBar.buttons, ['Close']);
  assert.equal(r.settingsBar.text, 'Settings');
  assert.equal(r.settingsBar.gear, true);
});
check('main refuses minimise and maximise from the settings window, even through the bridge', () => {
  assert.equal(r.settingsRefused, true);
  assert.equal(r.settingsNeverObeyed, true);
  assert.equal(r.editorNotMaximised, true, 'nor does it act on the editor window instead');
});
check("the settings window's Close closes it and leaves the editor open", () => assert.equal(r.settingsClosed, true));
check('clicking into the editor closes the settings window and leaves the editor open', () => {
  assert.equal(r.openedForFocus, true);
  assert.equal(r.focusCloses, true);
});
check('the editor gaining focus without Settings losing it first leaves Settings open', () => assert.equal(r.strayFocusIgnored, true));
check('the gear, clicked with Settings open, leaves exactly one settings window open', () => {
  assert.equal(r.openedForGear, true);
  assert.equal(r.afterGear.settingsOpen, true);
  assert.equal(r.afterGear.windows, 2);
});
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
