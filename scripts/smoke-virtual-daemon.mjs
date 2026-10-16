/**
 * Offline test: a virtual deck through the real daemon (dist/index.js) —
 * the driver registry, scan() and reload() with a second driver beside the
 * Stream Decks:
 *
 * - a screen the config names a virtual deck, connected, is attached at
 *   start: its helper started on that output, the panel's canvas and keys
 *   drawn, the socket's `decks` and `status` listing it;
 * - a reload that changes the panel redraws it with the new controls;
 * - the screen going away (the helper exits 3) disconnects the deck;
 * - plugged in again, the next scan attaches it again;
 * - stopping the daemon quits the helper.
 *
 * The child gets scripts/test/fake-decks.mjs with no Stream Decks plugged in
 * (SIGUSR2 forces its scan), scripts/test/fake-panel.mjs as the helper, a
 * scratch /sys/class/drm, the fake input helper and a private D-Bus. Every
 * path it writes is inside a scratch directory.
 *
 *   npm run build:ts && node scripts/smoke-virtual-daemon.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  // A private bus nothing can be activated on, as scripts/smoke-unattached.mjs.
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-virtual-bus-${process.pid}.conf`);
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
    env: { ...process.env, DECKHAND_SMOKE_PRIVATE_BUS: '1' },
  });
  await fs.rm(busConfig, { force: true });
  process.exit(rerun.status ?? 1);
}

const { REPO, check, failureCount, scratchDir, sleep, connect } = await import('./test/control-harness.mjs');

const TMP = await scratchDir();
process.env.TMPDIR = TMP;
const CONFIG_DIR = path.join(TMP, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SOCKET = path.join(TMP, 'c.sock');
const DECKS_FILE = path.join(TMP, 'decks.json');
const DRM = path.join(TMP, 'drm');
const PANEL_LOG = path.join(TMP, 'panel.log');

const grid = (prefix, rows, columns, pitch) => {
  const controls = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) controls.push({ id: `${prefix}${r * columns + c + 1}`, x: c * pitch, y: r * pitch, w: pitch, h: pitch });
  return { size: { width: 1920, height: 720 }, controls };
};
const configWith = (panel) => ({
  decks: { 'GRA-6e4e-01000000': { name: 'Test panel', virtual: { output: 'DP-4' } } },
  profiles: { default: { name: 'Default', layouts: { 'GRA-6e4e-01000000': { panel, pages: { main: { buttons: { k1: { label: 'One' } } } } } } } },
  startProfile: 'default',
});
const writeConfig = async (config) => {
  const temp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n');
  await fs.rename(temp, CONFIG_PATH);
};
const screen = async (status) => {
  await fs.mkdir(path.join(DRM, 'card1-DP-4'), { recursive: true });
  await fs.writeFile(path.join(DRM, 'card1-DP-4', 'status'), `${status}\n`);
};
const frames = async () => (await fs.readFile(PANEL_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

await fs.mkdir(CONFIG_DIR, { recursive: true });
await writeConfig(configWith(grid('k', 2, 3, 240)));
await fs.writeFile(DECKS_FILE, '[]');
await screen('connected');

const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')], {
  env: {
    ...process.env,
    DECKHAND_CONFIG_DIR: CONFIG_DIR,
    DECKHAND_STATE_DIR: path.join(TMP, 'state'),
    DECKHAND_SOCKET: SOCKET,
    DECKHAND_INPUT_BIN: path.join(REPO, 'scripts/test/fake-input-helper.mjs'),
    FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
    FAKE_DECKS_FILE: DECKS_FILE,
    FAKE_DECKS_LOG: path.join(TMP, 'opens.log'),
    DECKHAND_DRM_DIR: DRM,
    DECKHAND_PANEL_BIN: path.join(REPO, 'scripts/test/fake-panel.mjs'),
    FAKE_PANEL_LOG: PANEL_LOG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => output.push(c));
child.stderr.on('data', (c) => output.push(c));
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const log = () => output.join('');
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

try {
  check('the daemon attaches the virtual deck at start', await until(() => /attached Test panel \(GRA-6e4e-01000000\) — 6 keys/.test(log())), log().slice(-800));
  check('its helper was started on DP-4', (await frames()).some((f) => f.type === 'start' && f.output === 'DP-4'));
  check('the canvas, then six keys drawn', await until(async () => (await frames()).filter((f) => f.type === 'I').length >= 6) && (await frames()).find((f) => f.type === 'K')?.width === 1920);

  const client = await connect(SOCKET);
  const decks = (await client.request('decks')).result;
  const panel = decks.find((d) => d.serial === 'GRA-6e4e-01000000');
  check('the socket lists it, in pixels, with its keys by id', panel?.units === 'pixels' && panel.keyCount === 6 && panel.keys[0].id === 'k1' && panel.canvas.width === 1920, JSON.stringify(panel));
  const status = (await client.request('status')).result.decks.find((d) => d.serial === 'GRA-6e4e-01000000');
  check('status: connected, configured, on its page', status?.connected === true && status.configured === true && status.page === 'main');

  const before = (await frames()).length;
  await writeConfig(configWith(grid('t', 1, 2, 360)));
  check('a reload with another panel redraws it with the new controls', await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I' && f.w === 360).length >= 2));
  check('…and the socket says so', await until(async () => (await client.request('decks')).result.find((d) => d.serial === 'GRA-6e4e-01000000')?.keyCount === 2));

  const start = (await frames()).find((f) => f.type === 'start');
  await screen('disconnected');
  process.kill(start.pid, 'SIGUSR2');
  check('the screen going away disconnects the deck', await until(() => /deck GRA-6e4e-01000000 disconnected/.test(log())));
  check('…and status says it is not connected', await until(async () => (await client.request('status')).result.decks.find((d) => d.serial === 'GRA-6e4e-01000000')?.connected === false));

  await screen('connected');
  process.kill(child.pid, 'SIGUSR2');
  check('plugged in again, the next scan attaches it again', await until(() => (log().match(/attached Test panel/g) ?? []).length === 2), log().slice(-600));

  client.close();
  const quitsBefore = (await frames()).filter((f) => f.type === 'Q').length;
  child.kill('SIGTERM');
  const code = await exited;
  check('stopping the daemon quits the helper', code === 0 && (await until(async () => (await frames()).filter((f) => f.type === 'Q').length > quitsBefore)));
} finally {
  child.kill('SIGKILL');
  await fs.rm(TMP, { recursive: true, force: true });
}

const failed = failureCount();
console.log(failed === 0 ? '\nvirtual daemon: all checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
