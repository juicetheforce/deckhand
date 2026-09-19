// Ship piece 2: the editor as a launcher, end to end in real Electron.
//
// Runs itself under dbus-run-session on a private bus with no service
// directories, so the tray icon registers there and never in the maintainer's panel —
// and nothing the check starts outlives it. The editor runs in its "tray"
// check mode (src/main/main.ts): the renderer is the ordinary editor, and this
// script drives the lifecycle over stdin, one command per line, through the
// tray's real click and menu handlers and a real window close.
//
// What is checked from outside the editor, not only from its own report: the
// harness daemon sees the socket close and reopen; config.json holds an edit
// made just before closing; a real second launch exits and brings the first
// forward; the renderer process is gone while the editor sits in the tray.
//
// Usage: npm run check:tray   (builds first)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_TRAY_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-tray-'));
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

const SERIAL = 'TRAY-XL';
const CONFIG = { profiles: { default: { name: 'Default', layouts: { [SERIAL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } } } } } };
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(SERIAL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);
const connections = () => daemon.control['connections'].size;

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;

const startEditor = () => startEditorAt(electronPath, editorRoot, env);

/** Every process descended from pid, with its Chromium --type (or "main"). */
function processTree(pid) {
  const children = new Map();
  for (const entry of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch {
      // Gone already.
    }
  }
  const out = [];
  const walk = (p) => {
    try {
      // Chromium rewrites its children's command lines into one space-separated
      // string, so the flag is matched rather than read as an argument.
      const type = /--type=([^\s\0]+)/.exec(readFileSync(`/proc/${p}/cmdline`, 'utf8'))?.[1] ?? 'main';
      // PSS, not RSS: shared pages are divided between the processes sharing
      // them, so the sum is what the editor costs rather than an overcount.
      const pssKb = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
      out.push({ pid: p, type, pssKb });
    } catch {
      return;
    }
    for (const c of children.get(p) ?? []) walk(c);
  };
  walk(pid);
  return out;
}
const types = (tree) => tree.map((p) => p.type).sort();
const pssMb = (tree) => Math.round(tree.reduce((sum, p) => sum + p.pssKb, 0) / 1024);
/** "main 90, gpu-process 60, ..." in MB, largest first. */
const byType = (tree) => tree.map((p) => [p.type, Math.round(p.pssKb / 1024)]).sort((a, b) => b[1] - a[1]).map(([t, mb]) => `${t} ${mb}`).join(', ');

// --- The lifecycle ----------------------------------------------------------

const editor = startEditor();
const results = {};
results.ready = (await until(() => editor.reports.some((r) => r.event === 'ready'), 30_000)) ? editor.reports.find((r) => r.event === 'ready') : null;
results.connectedAtStart = await until(() => connections() === 1);
await sleep(1500); // let the renderer settle before measuring it
results.openTree = processTree(editor.child.pid);

// An edit, then the window closed at once — inside the 400 ms autosave delay.
const at = { profile: 'default', serial: SERIAL, page: 'main', index: 0 };
editor.send(`edit ${JSON.stringify({ kind: 'setLabel', at, label: 'written on close' })}`);
editor.send('close');
results.releasedToTray = await until(async () => {
  const s = await stateOf(editor);
  return s && !s.windowOpen && !s.storeOpen && !s.holding;
});
results.trayState = await stateOf(editor);
results.socketClosed = await until(() => connections() === 0);
results.aliveInTray = editor.exited === null;
await sleep(1500); // Chromium tears the renderer down after the window goes
results.trayTree = processTree(editor.child.pid);
results.labelWritten = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')).profiles.default.layouts[SERIAL].pages.main.buttons?.['0']?.label ?? null;

// A second launch: it exits, and the first comes forward.
const second = startEditor();
results.secondExited = await until(() => second.exited !== null);
results.secondExitCode = second.exited?.code ?? null;
results.reopenedBySecondLaunch = await until(() => editor.reports.some((r) => r.event === 'second-instance' && r.windowOpen && r.storeOpen));
results.reconnectedAfterSecondLaunch = await until(() => connections() === 1);

// A tray click while open: no second window, no second connection.
editor.send('click');
await sleep(500);
results.clickWhileOpen = await stateOf(editor);
results.connectionsAfterClickWhileOpen = connections();

// Close, then the tray click reopens.
editor.send('close');
results.closedAgain = await until(async () => !(await stateOf(editor)).holding);
editor.send('click');
results.clickReopens = await until(async () => {
  const s = await stateOf(editor);
  return s.windowOpen && s.storeOpen;
});
results.clickReconnects = await until(() => connections() === 1);

// Close, then the menu's Open reopens.
editor.send('close');
await until(async () => !(await stateOf(editor)).holding);
editor.send('menu Open Deckhand');
results.menuOpenReopens = await until(async () => {
  const s = await stateOf(editor);
  return s.windowOpen && s.storeOpen;
});

// The menu's Quit ends it.
editor.send('menu Quit Deckhand');
results.quitExited = await until(() => editor.exited !== null);
results.quitExitCode = editor.exited?.code ?? null;
results.socketClosedAfterQuit = await until(() => connections() === 0);

// --- With close-to-tray turned off, closing quits ---------------------------

await fs.mkdir(path.join(stateDir, 'editor'), { recursive: true });
await fs.writeFile(path.join(stateDir, 'editor', 'preferences.json'), JSON.stringify({ closeToTray: false }) + '\n');
const noTray = startEditor();
await until(() => noTray.reports.some((r) => r.event === 'ready'), 30_000);
await until(() => connections() === 1);
noTray.send('close');
results.closeQuitsWhenOff = await until(() => noTray.exited !== null);
results.closeQuitsExitCode = noTray.exited?.code ?? null;

for (const e of [editor, second, noTray]) if (e.exited === null) e.child.kill();

// --- An install while the editor is running (M5, 2026-09-19) ----------------
//
// scripts/install.sh update replaces the editor on disk; an editor in the tray
// would then open the new page against its old main process. The check stands
// in for the install by changing a stamp file the editor reads in place of its
// renderer's index.html, and counts the editors that start from a pid file:
// a restart is a new process this script never spawned.

await fs.rm(path.join(stateDir, 'editor', 'preferences.json'), { force: true }); // close to the tray again
const stamp = path.join(scratch, 'install-stamp');
const pidFile = path.join(scratch, 'editor-pids');
const pids = async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const installEnv = { ...env, DECKHAND_CHECK_INSTALL_STAMP: stamp, DECKHAND_CHECK_PID_FILE: pidFile };
const relaunched = [];

// 1. In the tray, then installed over, then clicked.
await fs.writeFile(stamp, 'build 1');
const stale = startEditorAt(electronPath, editorRoot, installEnv);
await until(() => stale.reports.some((r) => r.event === 'ready'), 30_000);
await until(() => connections() === 1);
stale.send('close');
results.staleInTray = await until(async () => !(await stateOf(stale))?.holding && connections() === 0);
// Nothing changed yet: a click just reopens.
stale.send('click');
results.unchangedReopens = await until(async () => (await stateOf(stale))?.windowOpen === true);
stale.send('close');
await until(async () => !(await stateOf(stale))?.holding && connections() === 0);
await fs.writeFile(stamp, 'build 2'); // the install
stale.send('click');
results.staleExited = await until(() => stale.exited !== null, 15_000);
results.staleExitCode = stale.exited?.code ?? null;
results.restartedAs = (await until(async () => (await pids()).length === 2, 30_000)) ? (await pids())[1] : null;
if (results.restartedAs) relaunched.push(results.restartedAs);
results.restartedConnects = await until(() => connections() === 1, 30_000);
await sleep(2000);
results.restartStaysUp = results.restartedAs !== null && alive(results.restartedAs) && (await pids()).length === 2;
for (const pid of relaunched) if (alive(pid)) process.kill(pid);
await until(() => connections() === 0);

// 2. Open across the install, then Settings — also a new page.
await fs.rm(pidFile, { force: true });
await fs.writeFile(stamp, 'build 3');
const openAcross = startEditorAt(electronPath, editorRoot, installEnv);
await until(() => openAcross.reports.some((r) => r.event === 'ready'), 30_000);
await until(() => connections() === 1);
await fs.writeFile(stamp, 'build 4'); // the install
openAcross.send('state');
results.openAcrossStillOpen = (await stateOf(openAcross))?.windowOpen === true;
openAcross.send('settings');
results.settingsRestarts = await until(() => openAcross.exited !== null, 15_000);
results.settingsRestartedAs = (await until(async () => (await pids()).length === 2, 30_000)) ? (await pids())[1] : null;
if (results.settingsRestartedAs) relaunched.push(results.settingsRestartedAs);
await until(() => connections() === 1, 30_000);
for (const pid of relaunched) if (alive(pid)) process.kill(pid);
for (const e of [stale, openAcross]) if (e.exited === null) e.child.kill();
await until(() => connections() === 0);

// --- Verdicts -----------------------------------------------------------------

check('the editor starts with a tray icon, a window, config.json open and the daemon connected', () => {
  assert.ok(results.ready, `no ready report\nstderr:\n${editor.stderr}`);
  assert.equal(results.ready.trayAlive, true);
  assert.deepEqual(results.ready.menu, ['Open Deckhand', 'Quit Deckhand']);
  assert.equal(results.ready.windowOpen, true);
  assert.equal(results.ready.storeOpen, true);
  assert.equal(results.connectedAtStart, true, 'the harness daemon never saw the editor connect');
});
check('closing the window goes to the tray: still running, config.json closed, the socket closed at the daemon', () => {
  assert.equal(results.releasedToTray, true, `state: ${JSON.stringify(results.trayState)}`);
  assert.equal(results.aliveInTray, true, 'the editor exited');
  assert.equal(results.trayState.daemonConnected, false);
  assert.equal(results.socketClosed, true, `the daemon still has ${connections()} connection(s)`);
});
check('in the tray, the renderer is gone: only processes with no page are left', () => {
  assert.ok(types(results.openTree).includes('renderer'), `no renderer while open, so its absence proves nothing: ${types(results.openTree)}`);
  assert.ok(!types(results.trayTree).includes('renderer'), `a renderer is still running in the tray: ${types(results.trayTree)}`);
});
check('an edit made just before closing was written to config.json', () => assert.equal(results.labelWritten, 'written on close'));
check('launching again exits the second copy and brings the first forward, reconnected', () => {
  assert.equal(results.secondExited, true, 'the second launch kept running');
  assert.equal(results.secondExitCode, 0);
  assert.equal(results.reopenedBySecondLaunch, true);
  assert.equal(results.reconnectedAfterSecondLaunch, true);
});
check('a tray click while open brings the window forward: no second window, no second connection', () => {
  assert.equal(results.clickWhileOpen.windowOpen, true);
  assert.equal(results.connectionsAfterClickWhileOpen, 1);
});
check('after closing, a tray click reopens the editor and reconnects', () => {
  assert.equal(results.closedAgain, true);
  assert.equal(results.clickReopens, true);
  assert.equal(results.clickReconnects, true);
});
check("after closing, the menu's Open reopens the editor", () => assert.equal(results.menuOpenReopens, true));
check("the menu's Quit exits cleanly and closes the socket", () => {
  assert.equal(results.quitExited, true);
  assert.equal(results.quitExitCode, 0);
  assert.equal(results.socketClosedAfterQuit, true);
});
check('with close-to-tray turned off in preferences.json, closing the window quits', () => {
  assert.equal(results.closeQuitsWhenOff, true);
  assert.equal(results.closeQuitsExitCode, 0);
});

check('in the tray with nothing installed, a click just reopens', () => {
  assert.equal(results.staleInTray, true);
  assert.equal(results.unchangedReopens, true);
});
check('installed over while in the tray, a click restarts it: the old process exits and a new one starts, connects and stays up', () => {
  assert.equal(results.staleExited, true, 'the stale editor did not exit');
  assert.equal(results.staleExitCode, 0);
  assert.ok(results.restartedAs, 'no new editor started');
  assert.equal(results.restartedConnects, true, 'the restarted editor never opened (no connection)');
  assert.equal(results.restartStaysUp, true, 'the restarted editor did not stay up, or restarted again');
});
check('open across an install, opening Settings restarts it rather than load the new page', () => {
  assert.equal(results.openAcrossStillOpen, true, 'the open window was disturbed by the install alone');
  assert.equal(results.settingsRestarts, true, 'Settings opened against the old main process');
  assert.ok(results.settingsRestartedAs, 'no new editor started');
});

console.log(`\nmemory (PSS, MB): open ${pssMb(results.openTree)} (${byType(results.openTree)}); in the tray ${pssMb(results.trayTree)} (${byType(results.trayTree)})`);

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
