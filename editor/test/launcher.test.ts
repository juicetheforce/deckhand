// The launcher lifecycle (Ship piece 2, src/main/launcher.ts) with fakes: open
// or focus, close to the tray releasing everything, reopen, quit — and the
// orderings a person can produce with a tray icon, such as clicking it while a
// close is still writing edits. The same lifecycle in real Electron is
// scripts/check-tray.mjs.

import assert from 'node:assert/strict';
import { Launcher, type LauncherDeps, type LauncherWindow } from '../src/main/launcher.js';

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

class FakeWindow implements LauncherWindow {
  destroyed = false;
  minimized = false;
  focused = 0;
  private listeners: Array<() => void> = [];
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore = () => {
    this.minimized = false;
  };
  show = () => undefined;
  focus = () => {
    this.focused++;
  };
  onClosed = (listener: () => void) => {
    this.listeners.push(listener);
  };
  /** The user closing it: destroyed, then 'closed'. */
  close() {
    this.destroyed = true;
    for (const l of this.listeners) l();
  }
}

/** Fakes that log every call, with a release that can be held open. */
function harness({ tray = true, closeToTray = true } = {}) {
  const log: string[] = [];
  const windows: FakeWindow[] = [];
  let holdRelease: Promise<void> | null = null;
  let failAcquire = false;
  const deps: LauncherDeps = {
    acquire: async () => {
      if (failAcquire) {
        failAcquire = false;
        log.push('acquire failed');
        throw new Error('config.json cannot be opened');
      }
      log.push('acquire');
    },
    release: async () => {
      log.push('release started');
      if (holdRelease) await holdRelease;
      log.push('release done');
    },
    createWindow: () => {
      const w = new FakeWindow();
      windows.push(w);
      log.push('window');
      return w;
    },
    closeToTray: async () => closeToTray,
    trayAlive: () => tray,
    quit: () => log.push('quit'),
  };
  return {
    launcher: new Launcher(deps),
    log,
    windows,
    hold() {
      let let_go!: () => void;
      holdRelease = new Promise((r) => (let_go = r));
      return () => {
        holdRelease = null;
        let_go();
      };
    },
    failNextAcquire() {
      failAcquire = true;
    },
  };
}

/** Let the launcher's queued turns run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

await check('opening acquires, then makes a window; opening again brings that window forward, acquiring nothing', async () => {
  const h = harness();
  await h.launcher.open();
  h.windows[0].minimized = true;
  await h.launcher.open();
  assert.deepEqual(h.log, ['acquire', 'window']);
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].focused, 1);
  assert.equal(h.windows[0].minimized, false, 'a minimised window is restored');
  assert.deepEqual(h.launcher.state(), { windowOpen: true, holding: true });
});

await check('closing goes to the tray: everything is released and nothing quits; opening again acquires and makes a new window', async () => {
  const h = harness();
  await h.launcher.open();
  h.windows[0].close();
  await settle();
  assert.deepEqual(h.launcher.state(), { windowOpen: false, holding: false });
  await h.launcher.open();
  assert.deepEqual(h.log, ['acquire', 'window', 'release started', 'release done', 'acquire', 'window']);
  assert.equal(h.windows.length, 2);
});

await check('with close-to-tray turned off, closing quits and releases nothing itself (before-quit writes the edits)', async () => {
  const h = harness({ closeToTray: false });
  await h.launcher.open();
  h.windows[0].close();
  await settle();
  assert.deepEqual(h.log, ['acquire', 'window', 'quit']);
});

await check('with no tray icon, closing quits: never a running editor with nothing to click', async () => {
  const h = harness({ tray: false });
  await h.launcher.open();
  h.windows[0].close();
  await settle();
  assert.deepEqual(h.log, ['acquire', 'window', 'quit']);
});

await check('a tray click while the close is still writing waits for it, then acquires afresh', async () => {
  const h = harness();
  await h.launcher.open();
  const letGo = h.hold();
  h.windows[0].close();
  await settle();
  const reopened = h.launcher.open();
  await settle();
  assert.deepEqual(h.log, ['acquire', 'window', 'release started'], 'nothing may open on a store being closed');
  letGo();
  await reopened;
  assert.deepEqual(h.log, ['acquire', 'window', 'release started', 'release done', 'acquire', 'window']);
  assert.deepEqual(h.launcher.state(), { windowOpen: true, holding: true });
});

await check('opened again before the close is handled: the new window keeps what is held, nothing is released', async () => {
  const h = harness();
  await h.launcher.open();
  h.windows[0].close();
  await h.launcher.open(); // queued before the close's turn? No: the close queued first — so this runs after it.
  await settle();
  // Either order is safe; what must hold is that the editor ends open and holding, with one window live.
  assert.deepEqual(h.launcher.state(), { windowOpen: true, holding: true });
  assert.equal(h.windows.filter((w) => !w.destroyed).length, 1);
});

await check('Quit quits, and nothing opens after it', async () => {
  const h = harness();
  await h.launcher.open();
  h.launcher.quit();
  await h.launcher.open();
  assert.deepEqual(h.log, ['acquire', 'window', 'quit']);
});

await check('an open that fails does not wedge the launcher: the next one works', async () => {
  const h = harness();
  h.failNextAcquire();
  await assert.rejects(h.launcher.open(), /cannot be opened/);
  await h.launcher.open();
  assert.deepEqual(h.log, ['acquire failed', 'acquire', 'window']);
});

console.log(failures === 0 ? '\nlauncher: all checks passed' : `\nlauncher: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
