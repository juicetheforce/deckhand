// Run the built editor in real Electron in a check mode (src/main/main.ts,
// DECKHAND_EDITOR_CHECK) and return its report. Shared by the check-*.mjs
// scripts. Every path the editor could touch is pointed at scratch locations
// by the caller: config, state and the daemon socket.

import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const editorRoot = path.join(import.meta.dirname, '..', '..');

/**
 * @param {string} check  "shared" or "bridge"
 * @param {{ configDir: string, stateDir: string, socket: string }} paths
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, report: any }>}
 */
export async function runElectronCheck(check, { configDir, stateDir, socket }, timeoutMs = 30_000) {
  const env = {
    ...process.env,
    DECKHAND_EDITOR_CHECK: check,
    DECKHAND_CONFIG_DIR: configDir,
    DECKHAND_STATE_DIR: stateDir,
    DECKHAND_SOCKET: socket,
  };
  // VS Code sets ELECTRON_RUN_AS_NODE=1 for processes started from its
  // extension host; it turns the Electron binary into plain Node, with no
  // BrowserWindow. Found when the first run of the shared-import check failed.
  delete env.ELECTRON_RUN_AS_NODE;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [editorRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
