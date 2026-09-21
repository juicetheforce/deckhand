// Run the built editor in real Electron in a check mode (src/main/main.ts,
// DECKHAND_EDITOR_CHECK) and return its report. Shared by the check-*.mjs
// scripts. Every path the editor could touch is pointed at scratch locations
// by the caller: config, state and the daemon socket.

import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

// DECKHAND_CHECK_INSTALLED_EDITOR=<dir> runs an installed editor instead of
// this checkout's: <dir> is an app directory's editor/, as scripts/install.sh
// lays it out, with its own Electron in electron/. Its built-in icons are then
// left to the editor's own lookup, since that lookup is what is being checked.
const installedEditor = process.env.DECKHAND_CHECK_INSTALLED_EDITOR;
const editorRoot = installedEditor ?? path.join(import.meta.dirname, '..', '..');
const electronBinary = installedEditor ? path.join(installedEditor, 'electron', 'electron') : electronPath;

/**
 * @param {string} check  the DECKHAND_EDITOR_CHECK mode, one per check script
 *   ("shared", "bridge", "icons", "empty", "empty-select", "screenshot", …)
 * @param {{ configDir: string, stateDir: string, socket: string }} paths
 * @param {number} [timeoutMs]
 * @param {Record<string, string>} [extraEnv]  more environment for Electron (check-icons sets HOME)
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, report: any }>}
 */
export async function runElectronCheck(check, { configDir, stateDir, socket }, timeoutMs = 30_000, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    DECKHAND_EDITOR_CHECK: check,
    DECKHAND_CONFIG_DIR: configDir,
    DECKHAND_STATE_DIR: stateDir,
    DECKHAND_SOCKET: socket,
  };
  // Built-in icons from this checkout, never from an installed daemon
  // (src/main/builtin-icons.ts): a check must not depend on what is installed.
  if (!installedEditor) env.DECKHAND_BUILTIN_ICONS ??= path.join(editorRoot, '..', 'assets', 'icons');
  // VS Code sets ELECTRON_RUN_AS_NODE=1 for processes started from its
  // extension host; it turns the Electron binary into plain Node, with no
  // BrowserWindow.
  delete env.ELECTRON_RUN_AS_NODE;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [editorRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`electron did not finish in ${timeoutMs / 1000} s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  const line = result.stdout.split('\n').find((l) => l.startsWith('DECKHAND_EDITOR_CHECK '));
  return { ...result, report: line ? JSON.parse(line.slice('DECKHAND_EDITOR_CHECK '.length)) : null };
}
