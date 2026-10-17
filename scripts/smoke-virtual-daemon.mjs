/**
 * Offline test: a virtual deck through the real daemon (dist/index.js) —
 * the driver registry, scan() and reload() with a second driver beside the
 * Stream Decks:
 *
 * - a screen the config names a virtual deck, by its EDID's key, connected,
 *   is attached at start: its helper started on that output, the panel's
 *   canvas and keys drawn, the socket's `decks` and `status` listing it;
 * - its touchscreen given to the helper; a touch on a key runs its action;
 *   `status` gives the touch state, `locked` while a fake logind says so,
 *   when a touch does nothing;
 * - `screens` lists the screens by key and the touchscreens; `virtual.pair`
 *   closes the deck, shows the tap screen, replies with the touchscreen
 *   tapped, and the deck comes back; a client that goes away cancels it;
 * - a reload that changes the panel redraws it with the new controls;
 * - the screen going away (the helper exits 3) disconnects the deck;
 * - plugged in again, the next scan attaches it again;
 * - stopping the daemon quits the helper.
 *
 * The child gets scripts/test/fake-decks.mjs with no Stream Decks plugged in
 * (SIGUSR2 forces its scan), scripts/test/fake-panel.mjs as the helper, a
 * scratch /sys/class/drm, /sys/class/input and udev database, the fake input
 * helper, and a private D-Bus that is its session bus and its system bus,
 * where scripts/test/fake-logind.mjs answers. Every path it writes is inside
 * a scratch directory.
 *
 *   npm run build:ts && node scripts/smoke-virtual-daemon.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
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
const { edid, fakeSysfs, ILITEK, ILITEK_NODES } = await import('./test/fake-sysfs.mjs');
const { startFakeLogind } = await import('./test/fake-logind.mjs');
const sysfs = fakeSysfs(TMP);
const DRM = sysfs.drm;
const SOCKS = path.join(TMP, 'socks');
const DEVI = sysfs.dev;
const PANEL_LOG = path.join(TMP, 'panel.log');

const grid = (prefix, rows, columns, pitch) => {
  const controls = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) controls.push({ id: `${prefix}${r * columns + c + 1}`, x: c * pitch, y: r * pitch, w: pitch, h: pitch });
  return { size: { width: 1920, height: 720 }, controls };
};
const KEY = 'GRA-6e4e';
const configWith = (panel) => ({
  decks: { [KEY]: { name: 'Test panel', virtual: { output: 'DP-4', touch: ILITEK } } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [KEY]: { panel, startPage: 'main', pages: { main: { buttons: { k1: { label: 'One' }, k2: { action: { type: 'page', to: 'two' } } } }, two: { buttons: {} } } } },
    },
  },
  startProfile: 'default',
});
const writeConfig = async (config) => {
  const temp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n');
  await fs.rename(temp, CONFIG_PATH);
};
const screen = (status) => sysfs.plug('DP-4', status, edid({ maker: 'GRA', product: '6e4e', numeric: 1, name: 'HD Display', widthMm: 243, heightMm: 91 }));
/** Lines the fake helper on a connector says, as the real one reports touches. */
async function helperSays(connector, ...events) {
  const sock = path.join(SOCKS, `${connector}.sock`);
  const said = await until(
    () =>
      new Promise((resolve) => {
        const c = net.connect(sock, () => c.end(events.map((e) => JSON.stringify(e)).join('\n') + '\n', () => resolve(true)));
        c.on('error', () => resolve(false));
      }),
  );
  if (!said) throw new Error(`no fake helper listening on ${connector}`);
  await sleep(100);
}
const frames = async () => (await fs.readFile(PANEL_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

await fs.mkdir(CONFIG_DIR, { recursive: true });
await writeConfig(configWith(grid('k', 2, 3, 240)));
await fs.writeFile(DECKS_FILE, '[]');
await screen('connected');
await sysfs.plug('HDMI-A-1', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN', name: 'HP E243' }));
await sysfs.usbDevice('pci0/usb3/3-2.3', '222a');
for (const node of ILITEK_NODES) await sysfs.inputNode(node);
await fs.mkdir(SOCKS);
const logind = await startFakeLogind(process.env.DBUS_SESSION_BUS_ADDRESS);

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
    DECKHAND_INPUT_DIR: sysfs.input,
    DECKHAND_UDEV_DATA_DIR: sysfs.udev,
    DECKHAND_DEV_INPUT_DIR: DEVI,
    // The private bus is its system bus too: the fake logind is there.
    DBUS_SYSTEM_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    FAKE_PANEL_INPUT_DIR: SOCKS,
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
  check('the daemon attaches the virtual deck at start', await until(() => /attached Test panel \(GRA-6e4e\) — 6 keys/.test(log())), log().slice(-800));
  check('its helper was started on DP-4', (await frames()).some((f) => f.type === 'start' && f.output === 'DP-4'));
  check('the canvas, then six keys drawn', await until(async () => (await frames()).filter((f) => f.type === 'I').length >= 6) && (await frames()).find((f) => f.type === 'K')?.width === 1920);

  const client = await connect(SOCKET);
  const decks = (await client.request('decks')).result;
  const panel = decks.find((d) => d.serial === 'GRA-6e4e');
  check('the socket lists it, in pixels, with its keys by id', panel?.units === 'pixels' && panel.keyCount === 6 && panel.keys[0].id === 'k1' && panel.canvas.width === 1920, JSON.stringify(panel));
  const status = (await client.request('status')).result.decks.find((d) => d.serial === 'GRA-6e4e');
  check('status: connected, configured, on its page', status?.connected === true && status.configured === true && status.page === 'main');

  console.log('touch');
  check('its touchscreen given to the helper; the sibling it may not read is not', (await frames()).some((f) => f.type === 'T' && f.mode === 1 && f.entries.map((e) => e.join(':')).join() === `t:${DEVI}/event15`));
  const touchOf = async () => (await client.request('status')).result.decks.find((d) => d.serial === KEY)?.touch;
  check('status: touch ready', await until(async () => (await touchOf()) === 'ready'), String(await touchOf()));
  const cliStatus = () => spawnSync(process.execPath, [path.join(REPO, 'dist/cli.js'), 'status'], { env: { ...process.env, DECKHAND_SOCKET: SOCKET } }).stdout.toString();
  check('deckhand status says so in words', /GRA-6e4e .*\n    touch: ready\n/.test(cliStatus()), cliStatus());
  await helperSays('DP-4', { ev: 'touch', contact: 0, edge: 'down', x: 360, y: 120 }, { ev: 'touch', contact: 0, edge: 'up' });
  check('a touch on a key runs its action (k2: to page two)', await until(async () => (await client.request('status')).result.decks.find((d) => d.serial === KEY)?.page === 'two'));
  await client.request('action.run', { serial: KEY, action: { type: 'page', to: 'main' } });
  logind.lock(true);
  check('locked: status says so', await until(async () => (await touchOf()) === 'locked'), String(await touchOf()));
  check('…and deckhand status', /touch: off while the session is locked/.test(cliStatus()), cliStatus());
  const pageNow = (await client.request('status')).result.decks.find((d) => d.serial === KEY)?.page;
  await helperSays('DP-4', { ev: 'touch', contact: 1, edge: 'down', x: 360, y: 120 }, { ev: 'touch', contact: 1, edge: 'up' });
  check('locked: a touch does nothing', (await client.request('status')).result.decks.find((d) => d.serial === KEY)?.page === pageNow);
  logind.lock(false);
  check('unlocked: ready again', await until(async () => (await touchOf()) === 'ready'));

  console.log('screens and pairing');
  const screens = (await client.request('screens')).result;
  check('screens: each by its key, and which is a virtual deck', JSON.stringify(screens.screens.map((x) => [x.connector, x.key, x.deck])) === JSON.stringify([['DP-4', KEY, KEY], ['HDMI-A-1', 'HPN-3469-CNK8231CGN', null]]) && screens.screens[0].widthMm === 243 && screens.screens[0].name === 'HD Display', JSON.stringify(screens));
  check('…and the touchscreens, not their siblings', JSON.stringify(screens.touchscreens.map((x) => x.device)) === JSON.stringify([`${DEVI}/event15`]) && screens.touchscreens[0].path === ILITEK.path);
  const startsBefore = (await frames()).filter((f) => f.type === 'start' && f.output === 'DP-4').length;
  const pairing = client.request('virtual.pair', { output: 'DP-4' });
  check('pairing the deck\'s screen: the deck is closed for it', await until(() => /deck GRA-6e4e disconnected/.test(log())), log().slice(-500));
  await until(async () => (await frames()).filter((f) => f.type === 'start' && f.output === 'DP-4').length === startsBefore + 1);
  await helperSays('DP-4', { ev: 'tap', device: `${DEVI}/event15` });
  const paired = await pairing;
  check('the reply names the screen and its touchscreen, as the config keeps them', paired.ok && paired.result.screen === KEY && JSON.stringify(paired.result.touch) === JSON.stringify(ILITEK), JSON.stringify(paired));
  check('…and the deck comes back', await until(() => (log().match(/attached Test panel/g) ?? []).length === 2), log().slice(-500));

  const other = await connect(SOCKET);
  const abandoned = other.request('virtual.pair', { output: 'HDMI-A-1' }).catch(() => undefined);
  await until(async () => (await frames()).some((f) => f.type === 'start' && f.output === 'HDMI-A-1'));
  const quits = (await frames()).filter((f) => f.type === 'Q').length;
  other.close();
  void abandoned;
  check('a client that goes away cancels its pairing: the helper is quit', await until(async () => (await frames()).filter((f) => f.type === 'Q').length > quits));
  const refused = await client.request('virtual.pair', { output: 'DP-9' });
  check('pairing a connector with no screen: not found', refused.ok === false && refused.error.code === 'not_found', JSON.stringify(refused));

  const before = (await frames()).length;
  await writeConfig(configWith(grid('t', 1, 2, 360)));
  check('a reload with another panel redraws it with the new controls', await until(async () => (await frames()).slice(before).filter((f) => f.type === 'I' && f.w === 360).length >= 2));
  check('…and the socket says so', await until(async () => (await client.request('decks')).result.find((d) => d.serial === 'GRA-6e4e')?.keyCount === 2));

  const start = (await frames()).findLast((f) => f.type === 'start' && f.output === 'DP-4');
  const disconnects = () => (log().match(/deck GRA-6e4e disconnected/g) ?? []).length;
  const disconnectsBefore = disconnects();
  await screen('disconnected');
  process.kill(start.pid, 'SIGUSR2');
  check('the screen going away disconnects the deck', await until(() => disconnects() === disconnectsBefore + 1));
  check('…and status says it is not connected', await until(async () => (await client.request('status')).result.decks.find((d) => d.serial === 'GRA-6e4e')?.connected === false));

  await screen('connected');
  process.kill(child.pid, 'SIGUSR2');
  check('plugged in again, the next scan attaches it again', await until(() => (log().match(/attached Test panel/g) ?? []).length === 3), log().slice(-600));
  check('three attaches, and the unread sibling said once, never as "cannot open"', (log().match(/not grabbing event16/g) ?? []).length === 1 && !/cannot open .*event16/.test(log()));

  client.close();
  const quitsBefore = (await frames()).filter((f) => f.type === 'Q').length;
  child.kill('SIGTERM');
  const code = await exited;
  check('stopping the daemon quits the helper', code === 0 && (await until(async () => (await frames()).filter((f) => f.type === 'Q').length > quitsBefore)));
} finally {
  child.kill('SIGKILL');
  await logind.stop().catch(() => undefined);
  await fs.rm(TMP, { recursive: true, force: true });
}

const failed = failureCount();
console.log(failed === 0 ? '\nvirtual daemon: all checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
