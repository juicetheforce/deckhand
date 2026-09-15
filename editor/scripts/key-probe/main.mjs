// Proof 0b (docs/scope.md §7, M4 phase A): which key combos an Electron window
// can capture on KWin/Wayland. Injects each combo through the installed
// daemon (`deckhand run`, the same uinput path a deck key uses) while this
// window has focus, and records what reached the main process
// (before-input-event) and the page (keydown, with preventDefault — what the
// hotkey inspector's listening state will do).
//
// Run from editor/:
//   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/key-probe/main.mjs --batch 1
// Results are appended, one JSON line per combo, to $DECKHAND_PROBE_OUT
// (default: key-probe-results.jsonl in the current directory) as they happen,
// so a combo that quits the probe is still recorded.

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { BATCHES, expectationFor } from './batches.mjs';

const run = promisify(execFile);
const TITLE = 'Deckhand key probe';
const SETTLE_MS = 400;

// --manual: inject nothing; record whatever is pressed on the physical
// keyboard until Done is clicked (M4 phase A step 4, the Meta-flag check).
const MANUAL = process.argv.includes('--manual');
const batchNumber = MANUAL ? 'manual' : Number(process.argv[process.argv.indexOf('--batch') + 1]);
const batch = MANUAL ? null : BATCHES[batchNumber];
if (!MANUAL && !batch) {
  console.error('usage: electron scripts/key-probe/main.mjs --batch 1|2|3|4   or   --manual');
  process.exit(2);
}
const outFile = process.env.DECKHAND_PROBE_OUT ?? path.resolve('key-probe-results.jsonl');

// Keep the probe's Chromium state out of ~/.config, like the editor.
app.setPath('userData', path.join(app.getPath('temp'), 'deckhand-key-probe'));
// Same as the editor: no application menu, so none of its accelerators.
Menu.setApplicationMenu(null);

let window = null;
let events = [];
let reloads = 0;
let clickResolve = null;

function record(entry) {
  appendFileSync(outFile, JSON.stringify({ batch: batchNumber, at: new Date().toISOString(), ...entry }) + '\n');
}

function show(state) {
  if (window && !window.isDestroyed()) window.webContents.send('probe-state', state);
}

function waitForClick(message) {
  show({ message, button: true });
  return new Promise((resolve) => (clickResolve = resolve));
}

async function waitForFocus(message) {
  while (!window.isFocused()) {
    show({ message, button: false, warning: true });
    await new Promise((resolve) => window.once('focus', resolve));
  }
}

/** Whether the window is an X11 client (XWayland) rather than a native Wayland one. */
function displayServer() {
  try {
    const ids = execFileSync('xprop', ['-root', '_NET_CLIENT_LIST'], { encoding: 'utf8' }).match(/0x[0-9a-f]+/g) ?? [];
    for (const id of ids) {
      const name = execFileSync('xprop', ['-id', id, 'WM_NAME'], { encoding: 'utf8' });
      if (name.includes(TITLE)) return 'XWayland (X11 client)';
    }
    return `native Wayland (not among ${ids.length} X11 clients)`;
  } catch (err) {
    return `unknown: ${err.message}`;
  }
}

function verdict(expect, seen) {
  const downs = (layer) => seen.filter((e) => e.layer === layer && e.type === 'keyDown');
  const modsOf = (e) => ['ctrl', 'shift', 'alt', 'meta'].filter((m) => e[m]);
  const same = (a, b) => a.length === b.length && a.every((m) => b.includes(m));
  const describe = (e) => [...modsOf(e), e.code].join('+');

  const page = downs('page').filter((e) => e.code === expect.code);
  const main = downs('main').filter((e) => e.code === expect.code);
  if (page.some((e) => same(modsOf(e), expect.modifiers))) return { result: 'captured' };
  if (page.length > 0) return { result: 'wrong modifiers', arrived: page.map(describe) };
  if (main.length > 0) return { result: 'main process only', arrived: main.map(describe) };
  const other = downs('page').map(describe);
  return other.length > 0 ? { result: 'not received', otherKeys: other } : { result: 'not received' };
}

async function injectAll() {
  const decks = JSON.parse((await run('deckhand', ['decks', '--json'])).stdout);
  const serial = decks[0].serial; // hotkey is not deck-scoped; any connected deck will do

  let audioBefore = null;
  if (batch.restoreAudio) {
    audioBefore = {
      volume: (await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@'])).stdout.match(/(\d+)%/)[1],
      mute: (await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'])).stdout.includes('yes') ? '1' : '0',
    };
  }

  record({ kind: 'start', title: batch.title, displayServer: displayServer(), electron: process.versions.electron });
  await waitForClick(`${batch.title}\n\n${batch.combos.length} combos. Keep this window focused. Click Start when you are watching.`);

  for (const [i, combo] of batch.combos.entries()) {
    const progress = `${i + 1}/${batch.combos.length}: ${combo}`;
    await waitForFocus(`Focus left this window.\nClick here to continue with ${progress}`);
    show({ message: `Injecting ${progress}` });

    events = [];
    const reloadsBefore = reloads;
    let focusLost = false;
    const onBlur = () => (focusLost = true);
    window.once('blur', onBlur);

    let injectError;
    try {
      await run('deckhand', ['run', '--deck', serial, JSON.stringify({ type: 'hotkey', keys: combo })]);
    } catch (err) {
      injectError = (err.stderr || err.message).trim();
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    window.removeListener('blur', onBlur);

    const entry = { kind: 'combo', combo, ...verdict(expectationFor(combo), events), focusLost };
    if (reloads !== reloadsBefore) entry.pageReloaded = true;
    if (injectError) entry.injectError = injectError;
    record(entry);
    show({ message: `${progress} → ${entry.result}${focusLost ? ' (focus left the window)' : ''}`, last: entry });

    if (batch.confirmEach && i < batch.combos.length - 1) {
      await waitForFocus(`${progress} → ${entry.result}\n\nUndo whatever KDE did (Esc, or click back here).`);
      await waitForClick(`${progress} → ${entry.result}\n\nClick Next when KDE is back to normal.`);
    }
  }

  if (audioBefore) {
    await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${audioBefore.volume}%`]);
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', audioBefore.mute]);
    record({ kind: 'restored', audio: audioBefore });
  }
  record({ kind: 'end' });
  show({ message: `${batch.title}: done. Results in ${outFile}. This window closes in 3 s.` });
  setTimeout(() => app.quit(), 3000);
}

ipcMain.on('probe-key', (_event, e) => {
  events.push({ layer: 'page', ...e });
  if (MANUAL) record({ kind: 'key', layer: 'page', ...e });
});
ipcMain.on('probe-click', () => {
  const resolve = clickResolve;
  clickResolve = null;
  resolve?.();
});

app.whenReady().then(() => {
  window = new BrowserWindow({
    title: TITLE,
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.on('before-input-event', (_event, input) => {
    const entry = {
      layer: 'main', type: input.type, code: input.code, key: input.key,
      ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta,
    };
    events.push(entry);
    if (MANUAL) record({ kind: 'key', ...entry });
  });
  window.webContents.on('did-start-loading', () => reloads++);
  window.on('closed', () => {
    record({ kind: 'window-closed' });
    window = null;
  });
  window.loadFile(path.join(import.meta.dirname, 'probe.html'));
  window.webContents.once('did-finish-load', () => {
    reloads = 0;
    if (MANUAL) {
      record({ kind: 'start', title: 'manual', displayServer: displayServer(), electron: process.versions.electron });
      void (async () => {
        await waitForClick(
          'Manual check — nothing is injected.\n\nClick Start, then with this window focused press on your keyboard:\n  1. Meta+J\n  2. Meta+K\n  3. Meta+Shift+J\nThen click Done.',
        );
        show({ message: 'Recording. Press Meta+J, Meta+K, Meta+Shift+J, then click Done.', button: true, buttonLabel: 'Done' });
        await new Promise((resolve) => (clickResolve = resolve));
        record({ kind: 'end' });
        show({ message: `Done. Results in ${outFile}. Closing in 2 s.` });
        setTimeout(() => app.quit(), 2000);
      })();
      return;
    }
    injectAll().catch((err) => {
      record({ kind: 'error', error: err.stack });
      console.error(err);
      app.exit(1);
    });
  });
});

app.on('window-all-closed', () => app.quit());
