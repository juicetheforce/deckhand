// Drive a real editor from outside, for check-tray.mjs and check-settings.mjs:
// the editor runs in its "tray" check mode (src/main/main.ts), takes one
// command per line on stdin, and reports as `DECKHAND_TRAY {json}` on stdout.
// It runs on a private session bus, so a tray icon never lands in the desktop's
// panel.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Run the calling script again under dbus-run-session on a private bus with no
 * service directories — nothing the check starts can outlive it — and exit
 * with its status. Returns only in the re-run.
 */
export async function onPrivateBus(flag) {
  if (process.env[flag]) return;
  const busConfig = path.join(os.tmpdir(), `deckhand-${flag.toLowerCase()}-bus-${process.pid}.conf`);
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
    env: { ...process.env, [flag]: '1' },
  });
  await fs.rm(busConfig, { force: true });
  process.exit(rerun.status ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until fn() is truthy, up to ms. */
export async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

/** Start the editor at `editorRoot` with Electron at `electronPath`; its reports arrive in `reports`. */
export function startEditor(electronPath, editorRoot, env) {
  const child = spawn(electronPath, [editorRoot], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const editor = { child, reports: [], stderr: '', exited: null };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('DECKHAND_TRAY ')) editor.reports.push(JSON.parse(line.slice('DECKHAND_TRAY '.length)));
  });
  child.stderr.on('data', (d) => (editor.stderr += d));
  child.on('exit', (code) => (editor.exited = { code }));
  editor.send = (line) => child.stdin.write(`${line}\n`);
  return editor;
}

/** Send a command and wait for the report it answers with; null if none came. */
async function ask(editor, line, event) {
  const before = editor.reports.length;
  editor.send(line);
  const found = () => editor.reports.slice(before).find((r) => r.event === event);
  await until(() => found() !== undefined, 5000);
  return found() ?? null;
}

/** The editor's state now. */
export const stateOf = (editor) => ask(editor, 'state', 'state');

/**
 * Run an expression in the editor's page ("editor") or the settings window's
 * ("settings") and return its value. Throws if the window is not there or the
 * script failed, so a check cannot pass on nothing.
 */
export async function inPage(editor, which, expression) {
  const report = await ask(editor, `${which}-js ${expression.replace(/\n/g, ' ')}`, `${which}-js`);
  if (!report) throw new Error(`no answer from the ${which} window`);
  if (report.error) throw new Error(`${which} window: ${report.error}`);
  return report.result;
}
