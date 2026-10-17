/**
 * Offline test for virtual decks, stage 1 S3: what recognises a screen and its
 * touchscreen, touches pressing keys, the lock, and the pairing tap.
 *
 * - **screen keys** (src/screens.ts): maker-product plus the EDID's text
 *   serial, cleaned, never the numeric serial — **two identical monitors**
 *   with the same placeholder numeric serial and two text serials get two
 *   keys; two with no text serial share one, and the connector a deck was set
 *   up on tells them apart; neither on it is ambiguous, and shows nothing;
 * - **touchscreens** (src/touchscreens.ts) from a scratch /sys/class/input
 *   and udev database: which nodes are touchscreens, each one's identity (its
 *   USB serial, else IDs and ID_PATH), its siblings, and finding it again;
 * - **touch** through the driver and a session (fake helper): the paired
 *   touchscreen and its sibling sent to the helper; a touch presses the key
 *   it lands on, belongs to it until it lifts, two fingers on one key are one
 *   press, a touch off every key or a lift never seen down does nothing;
 * - **the lock**, with a fake logind on a private bus standing in for the
 *   system bus: locked → a touch does nothing; unlocked → it works; locked
 *   mid-hold → let go (its release runs, once); not the active session →
 *   nothing; logind gone → nothing (fails closed); back → works;
 * - the touchscreen unplugged and back; one that cannot be opened; none paired;
 * - **pairing**: "Tap this screen" on the whole screen, every touchscreen read
 *   without a grab, the one tapped named as the config keeps it; a deck on that
 *   screen closed meanwhile; cancelled; every touchscreen refused.
 *
 *   npm run build:ts && node scripts/smoke-virtual-touch.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-vtouch-'));
const { edid, fakeSysfs, ILITEK, ILITEK_NODES } = await import('./test/fake-sysfs.mjs');
const sysfs = fakeSysfs(TMP);
const { drm: DRM, input: INPUT, udev: UDEV } = sysfs;
const { plug, usbDevice, inputNode, unplugNode } = sysfs;
const DEVI = sysfs.dev;
const LOG = path.join(TMP, 'panel.log');
const SOCKS = path.join(TMP, 'socks');
await fs.mkdir(SOCKS);

// A bus nothing can be started on, standing in for the system bus.
await fs.writeFile(
  path.join(TMP, 'bus.conf'),
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${TMP}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
);
const [busAddress, busPid] = execFileSync('dbus-daemon', ['--config-file', path.join(TMP, 'bus.conf'), '--fork', '--print-address=1', '--print-pid=1']).toString().trim().split('\n');

Object.assign(process.env, {
  DECKHAND_DRM_DIR: DRM,
  DECKHAND_INPUT_DIR: INPUT,
  DECKHAND_UDEV_DATA_DIR: UDEV,
  DECKHAND_DEV_INPUT_DIR: DEVI,
  DECKHAND_PANEL_BIN: path.join(REPO, 'scripts/test/fake-panel.mjs'),
  FAKE_PANEL_LOG: LOG,
  FAKE_PANEL_INPUT_DIR: SOCKS,
  DBUS_SYSTEM_BUS_ADDRESS: busAddress,
});

const { parseEdid, screenKey, listScreens, findScreen } = await import(path.join(REPO, 'dist/screens.js'));
const { listInputNodes, touchIdentity, findTouch } = await import(path.join(REPO, 'dist/touchscreens.js'));
const { controlAt } = await import(path.join(REPO, 'dist/hit-test.js'));
const { createVirtualDriver } = await import(path.join(REPO, 'dist/drivers/virtual.js'));
const { validateConfig } = await import(path.join(REPO, 'dist/config.js'));
const { DeckSession } = await import(path.join(REPO, 'dist/deck.js'));
const { KeyFailures } = await import(path.join(REPO, 'dist/key-failures.js'));
const lock = await import(path.join(REPO, 'dist/services/session-lock.js'));
const { startFakeLogind } = await import('./test/fake-logind.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// What the daemon's code logs, to check what it says and at what level.
const said = [];
const errors = [];
const realLog = console.log.bind(console);
const realError = console.error.bind(console);
console.log = (...a) => (said.push(a.join(' ')), realLog(...a));
console.error = (...a) => (errors.push(a.join(' ')), realError(...a));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
const settle = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    check(`${name} (threw)`, false, err.stack ?? String(err));
  }
};
const frames = async () => (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

console.log('screen keys');
const panel = parseEdid(edid({ maker: 'GRA', product: '6e4e', numeric: 0x00000001, name: 'HD Display', widthMm: 243, heightMm: 91 }));
check('the 10.3" panel: GRA 6e4e, its name and size, no text serial', panel?.maker === 'GRA' && panel.product === '6e4e' && panel.name === 'HD Display' && panel.widthMm === 243 && panel.heightMm === 91 && panel.serial === undefined, JSON.stringify(panel));
check('…keyed GRA-6e4e: the numeric serial is never in the key', screenKey(panel, 'DP-4') === 'GRA-6e4e');
const xeneon = parseEdid(edid({ maker: 'CRX', product: 'ed00', serial: Buffer.from('062626215656\0', 'latin1'), name: 'XENEON EDGE', widthMm: 364, heightMm: 113 }));
check('the Xeneon Edge: its text serial cleaned of the NUL it carries', xeneon?.serial === '062626215656' && screenKey(xeneon, 'DP-2') === 'CRX-ed00-062626215656', JSON.stringify(xeneon));
const hpA = parseEdid(edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN', name: 'HP E243', widthMm: 527, heightMm: 296 }));
const hpB = parseEdid(edid({ maker: 'HPN', product: '3469', serial: 'CNK8222BRP', name: 'HP E243', widthMm: 527, heightMm: 296 }));
check('two identical monitors, the same placeholder numeric serial, two text serials: two keys', screenKey(hpA, 'HDMI-A-1') === 'HPN-3469-CNK8231CGN' && screenKey(hpB, 'HDMI-A-2') === 'HPN-3469-CNK8222BRP');
check('no EDID: keyed by its connector', screenKey(null, 'DP-9') === 'output-DP-9');
check('not an EDID: none', parseEdid(Buffer.alloc(128)) === null && parseEdid(Buffer.alloc(10)) === null);
check('a text serial with characters a key cannot hold keeps only letters, digits, - and _', screenKey(parseEdid(edid({ maker: 'ABC', product: '0001', serial: 'A1 B2/C3' })), 'X') === 'ABC-0001-A1B2C3');

await plug('HDMI-A-1', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8231CGN' }));
await plug('HDMI-A-2', 'connected', edid({ maker: 'HPN', product: '3469', serial: 'CNK8222BRP' }));
await plug('DP-5', 'connected', edid({ maker: 'GRA', product: '6e4e' }));
await plug('DP-6', 'connected', edid({ maker: 'GRA', product: '6e4e' }));
await plug('DP-7', 'disconnected', edid({ maker: 'SAM', product: '0f9c' }));
await plug('DP-8', 'connected');
const screens = listScreens();
check('connected screens only, each with its key', screens.map((s) => `${s.connector}=${s.key}`).join() === 'DP-5=GRA-6e4e,DP-6=GRA-6e4e,DP-8=output-DP-8,HDMI-A-1=HPN-3469-CNK8231CGN,HDMI-A-2=HPN-3469-CNK8222BRP', screens.map((s) => `${s.connector}=${s.key}`).join());
check('a screen with a key of its own is found on any connector (moved to another port, still that screen)', findScreen(screens, 'HPN-3469-CNK8222BRP', 'DP-1')?.connector === 'HDMI-A-2');
check('two identical panels with no text serial: the one on the connector it was set up on', findScreen(screens, 'GRA-6e4e', 'DP-6')?.connector === 'DP-6' && findScreen(screens, 'GRA-6e4e', 'DP-5')?.connector === 'DP-5');
check('…neither on that connector: ambiguous, never a guess', findScreen(screens, 'GRA-6e4e', 'DP-4') === 'ambiguous');
check('not connected: none', findScreen(screens, 'SAM-0f9c', 'DP-7') === null);
for (const c of ['HDMI-A-1', 'HDMI-A-2', 'DP-5', 'DP-6', 'DP-7', 'DP-8']) await sysfs.unplugConnector(c);

// The Xeneon Edge's controller: a USB serial, its nodes past 255, a mouse twin.
await usbDevice('pci0/usb1/1-11.4', '27c0', '9LQ0172005164');
await inputNode({ event: 'event256', minor: 312, physical: 'pci0/usb1/1-11.4', parent: '1-11.4:1.0/0003:27C0:0859.0001', input: 'input300', name: 'wch.cn TouchScreen', vendor: '27c0', product: '0859', uniq: '9LQ0172005164', direct: true, udev: { ID_INPUT: 1, ID_INPUT_TOUCHSCREEN: 1, ID_PATH: 'pci-0000:68:00.0-usb-0:11.4:1.0' } });
await inputNode({ event: 'event257', minor: 313, physical: 'pci0/usb1/1-11.4', parent: '1-11.4:1.1/0003:27C0:0859.0002', input: 'input301', name: 'wch.cn TouchScreen Mouse', vendor: '27c0', product: '0859', udev: { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_PATH: 'pci-0000:68:00.0-usb-0:11.4:1.1' } });
// The ILITEK on the 10.3" panel: no serial at any level; its mouse twin on another interface.
await usbDevice('pci0/usb3/3-2.3', '222a');
for (const node of ILITEK_NODES) await inputNode(node);
// A second, identical ILITEK panel on another port: told apart only by the port.
await usbDevice('pci0/usb3/3-4', '222a');
await inputNode({ event: 'event20', minor: 84, physical: 'pci0/usb3/3-4', parent: '3-4:1.0/0003:222A:0001.0020', input: 'input80', name: 'ILITEK Multi-Touch-V3000', vendor: '222a', product: '0001', direct: true, udev: { ID_INPUT: 1, ID_INPUT_TOUCHSCREEN: 1, ID_PATH: 'pci-0000:00:14.0-usb-0:4:1.0' } });
await inputNode({ event: 'event21', minor: 85, physical: 'pci0/usb3/3-4', parent: '3-4:1.1/0003:222A:0001.0021', input: 'input81', name: 'ILITEK Multi-Touch-V3000 Mouse', vendor: '222a', product: '0001', udev: { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_PATH: 'pci-0000:00:14.0-usb-0:4:1.1' } });
// The XPS's own, on I²C: no USB device; its sibling shares the HID device.
await inputNode({ event: 'event7', minor: 71, physical: 'pci0/i2c-0/i2c-ELAN2097:00', parent: '0018:04F3:2A15.0001', input: 'input13', name: 'ELAN2097:00 04F3:2A15', vendor: '04f3', product: '2a15', direct: true, udev: { ID_INPUT: 1, ID_INPUT_TOUCHSCREEN: 1, ID_PATH: 'pci-0000:00:15.0-platform-i2c_designware.0' } });
await inputNode({ event: 'event8', minor: 72, physical: 'pci0/i2c-0/i2c-ELAN2097:00', parent: '0018:04F3:2A15.0001', input: 'input14', name: 'ELAN2097:00 04F3:2A15 UNKNOWN', vendor: '04f3', product: '2a15', udev: { ID_INPUT: 1 } });
// A keyboard: never a touchscreen, never anyone's sibling.
await usbDevice('pci0/usb1/1-5', '046d', 'KB1');
await inputNode({ event: 'event3', minor: 67, physical: 'pci0/usb1/1-5', parent: '1-5:1.0/0003:046D:C31C.0003', input: 'input5', name: 'Logitech Keyboard', vendor: '046d', product: 'c31c', udev: { ID_INPUT: 1, ID_INPUT_KEYBOARD: 1 } });

console.log('touchscreens');
let nodes = listInputNodes();
const byNode = (n) => nodes.find((x) => x.node === n);
check('touchscreens are the nodes udev says are', nodes.filter((n) => n.touchscreen).map((n) => n.node).join() === 'event7,event15,event20,event256', nodes.filter((n) => n.touchscreen).map((n) => n.node).join());
check('the Xeneon\'s is remembered by its USB serial', JSON.stringify(touchIdentity(byNode('event256'))) === JSON.stringify({ vendor: '27c0', product: '0859', serial: '9LQ0172005164' }), JSON.stringify(touchIdentity(byNode('event256'))));
check('the ILITEK\'s, with no serial, by its IDs and the port it hangs from', JSON.stringify(touchIdentity(byNode('event15'))) === JSON.stringify({ vendor: '222a', product: '0001', path: 'pci-0000:00:14.0-usb-0:2.3:1.0' }));
const ilitek = findTouch(nodes, touchIdentity(byNode('event15')));
check('found again with its sibling, the mouse twin on another interface of the same USB device', ilitek?.touchscreen.node === 'event15' && ilitek.siblings.map((n) => n.node).join() === 'event16', JSON.stringify(ilitek?.siblings.map((n) => n.node)));
const second = findTouch(nodes, touchIdentity(byNode('event20')));
check('two identical panels with no serial: each found by its port, with its own twin only', second?.touchscreen.node === 'event20' && second.siblings.map((n) => n.node).join() === 'event21', JSON.stringify(second?.siblings.map((n) => n.node)));
check('the I²C one\'s sibling is its HID device\'s other node; the keyboard is nobody\'s', findTouch(nodes, touchIdentity(byNode('event7')))?.siblings.map((n) => n.node).join() === 'event8');
check('a serial finds it on any port', findTouch(nodes, { vendor: '27c0', product: '0859', serial: '9LQ0172005164', path: 'somewhere-else' })?.touchscreen.node === 'event256');
check('no serial and another port: not found — it needs a tap again', findTouch(nodes, { vendor: '222a', product: '0001', path: 'pci-0000:00:14.0-usb-0:9:1.0' }) === null);
check('another serial: not found', findTouch(nodes, { vendor: '27c0', product: '0859', serial: 'OTHER' }) === null);
await fs.rename(UDEV, `${UDEV}.away`);
check('no udev database: the kernel\'s "direct" property says which are touchscreens', listInputNodes().filter((n) => n.touchscreen).map((n) => n.node).join() === 'event7,event15,event20,event256');
await fs.rename(`${UDEV}.away`, UDEV);

console.log('hit testing');
const squares = [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 20, y: 0, w: 10, h: 10 }, { id: 'top', x: 5, y: 5, w: 10, h: 10 }];
check('inside, on the left and top edges: hit; the right and bottom edges: not', controlAt(squares, 0, 0) === 'a' && controlAt(squares, 29.9, 9.9) === 'b' && controlAt(squares, 30, 0) === null && controlAt(squares, 25, 10) === null);
check('between controls: none; overlapping: the last is on top', controlAt(squares, 17, 2) === null && controlAt(squares, 7, 7) === 'top');

// ---- the driver, touch and the lock ----

/** A 2 × 3 grid of 240 px keys on a 1920 × 720 canvas. */
function grid(rows, columns, pitch) {
  const controls = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) controls.push({ id: `k${r * columns + c + 1}`, x: c * pitch + 12, y: r * pitch + 12, w: pitch - 24, h: pitch - 24 });
  return { size: { width: 1920, height: 720 }, controls, preset: 'test' };
}
const centre = (id) => {
  const c = grid(2, 3, 240).controls.find((k) => k.id === id);
  return { x: c.x + c.w / 2, y: c.y + c.h / 2 };
};
let config = validateConfig({
  decks: { 'GRA-6e4e': { name: 'Panel', virtual: { output: 'DP-4', touch: ILITEK } } },
  profiles: {
    p: {
      layouts: {
        'GRA-6e4e': {
          panel: grid(2, 3, 240),
          startPage: 'main',
          pages: {
            main: { buttons: { k1: { action: { type: 'page', to: 'two' } }, k5: { action: { type: 'noop' }, onRelease: { type: 'page', to: 'two' } } } },
            two: { buttons: { k1: { action: { type: 'page', to: 'main' } } } },
          },
        },
      },
    },
  },
});
await plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e', name: 'HD Display', widthMm: 243, heightMm: 91 }));

const logind = { current: await startFakeLogind(busAddress) };
const asked = [];
const driver = createVirtualDriver(() => config);
let session = null;
driver.watch(async (why) => {
  asked.push(why);
  // As the daemon's scan does: a deck no longer listed is closed.
  if (session && !(await driver.list()).some((f) => f.id === 'GRA-6e4e')) {
    await session.close();
    session = null;
  }
});

/** Lines to the fake helper on a connector, said by it as the real one reports touches. */
async function helperSays(connector, ...events) {
  const sock = path.join(SOCKS, `${connector}.sock`);
  // A helper just started may not be listening yet, and the socket file
  // left by the one before refuses: try until one answers.
  const said = await until(
    () =>
      new Promise((resolve) => {
        const c = net.connect(sock, () => c.end(events.map((e) => JSON.stringify(e)).join('\n') + '\n', () => resolve(true)));
        c.on('error', () => resolve(false));
      }),
  );
  if (!said) throw new Error(`no fake helper listening on ${connector}`);
  await sleep(60);
}
const down = (contact, id, at = centre(id)) => ({ ev: 'touch', contact, edge: 'down', x: at.x, y: at.y });
const up = (contact) => ({ ev: 'touch', contact, edge: 'up' });

let device;
const inputs = [];
const startDeck = async () => {
  const found = (await driver.list()).find((f) => f.id === 'GRA-6e4e');
  device = await found.open();
  device.onInput((e) => inputs.push(`${e.control} ${e.edge}`));
  session = new DeckSession(device, {
    serial: 'GRA-6e4e',
    hardware: config.decks['GRA-6e4e'],
    layout: config.profiles.p.layouts['GRA-6e4e'],
    defaults: {},
    switchProfile: async () => {},
    failures: new KeyFailures(),
    profileOf: () => 'p',
  });
  await session.start();
};

console.log('touch');
await settle('touch', async () => {
  check('a screen keyed by its EDID is listed as that deck', (await driver.list()).map((f) => f.id).join() === 'GRA-6e4e');
  await startDeck();
  const t = (await frames()).find((f) => f.type === 'T');
  check('the helper is given the paired touchscreen to grab, and not the sibling it may not read', t?.mode === 1 && JSON.stringify(t.entries) === JSON.stringify([['t', `${DEVI}/event15`]]), JSON.stringify(t));
  check('…which is said once, not as an error, saying it can report positions', said.filter((l) => /not grabbing event16 .*can report positions/.test(l)).length === 1 && !errors.some((l) => /event16/.test(l)), JSON.stringify([said, errors]));
  check('touch ready once the helper has it open and logind says unlocked', await until(() => device.touchState() === 'ready'), device.touchState());
  await helperSays('DP-4', down(0, 'k1'));
  check('a touch on a key presses it, and runs its action', inputs.join() === 'k1 down' && session.currentPage() === 'two', `${inputs} / ${session.currentPage()}`);
  await helperSays('DP-4', up(0));
  check('…and lifting lets it go', inputs.join() === 'k1 down,k1 up');
  await session.goToPage('main');
  inputs.length = 0;
  await helperSays('DP-4', down(3, 'k2'), down(104, 'k2'), up(3));
  check('two fingers on one key are one press, still down while either is', inputs.join() === 'k2 down');
  await helperSays('DP-4', up(104));
  check('…let go when the last lifts', inputs.join() === 'k2 down,k2 up');
  inputs.length = 0;
  await helperSays('DP-4', down(5, 'k3', { x: 240, y: 5 }), up(5), up(77));
  check('a touch between keys, and a lift never seen down, do nothing', inputs.length === 0, inputs.join());
  await helperSays('DP-4', down(6, 'k4'), down(7, 'k6'), up(6), up(7));
  check('a touch belongs to the key it started on; two keys at once are two presses', inputs.join() === 'k4 down,k6 down,k4 up,k6 up', inputs.join());
});

console.log('the lock');
await settle('lock', async () => {
  inputs.length = 0;
  logind.current.lock(true);
  check('locked: the touch state says so', await until(() => device.touchState() === 'locked'), device.touchState());
  await helperSays('DP-4', down(0, 'k1'), up(0));
  check('locked: a touch does nothing', inputs.length === 0 && session.currentPage() === 'main', `${inputs} / ${session.currentPage()}`);
  logind.current.lock(false);
  check('unlocked: ready again', await until(() => device.touchState() === 'ready'));
  await helperSays('DP-4', down(0, 'k1'), up(0));
  check('unlocked: a touch works', session.currentPage() === 'two');
  await session.goToPage('main');

  inputs.length = 0;
  await helperSays('DP-4', down(1, 'k5'));
  check('a key held (its release waiting)', inputs.join() === 'k5 down' && session.currentPage() === 'main');
  logind.current.lock(true);
  check('locked mid-hold: the key is let go — its release runs', await until(() => session.currentPage() === 'two'), session.currentPage());
  await session.goToPage('main');
  await helperSays('DP-4', up(1));
  check('…once: the finger lifting afterwards does nothing more', session.currentPage() === 'main' && inputs.join() === 'k5 down', `${inputs} / ${session.currentPage()}`);
  logind.current.lock(false);
  await until(() => device.touchState() === 'ready');

  inputs.length = 0;
  logind.current.activate(false);
  check('another user\'s session active: the touch state says inactive', await until(() => device.touchState() === 'inactive'), device.touchState());
  await helperSays('DP-4', down(0, 'k1'), up(0));
  check('…and a touch does nothing', inputs.length === 0);
  logind.current.activate(true);
  check('active again: ready', await until(() => device.touchState() === 'ready'));

  await logind.current.stop();
  check('logind gone: unknown — fails closed', await until(() => device.touchState() === 'unknown'), device.touchState());
  await helperSays('DP-4', down(0, 'k1'), up(0));
  check('…and a touch does nothing', inputs.length === 0 && session.currentPage() === 'main');
  logind.current = await startFakeLogind(busAddress);
  check('logind back: read again, and ready', await until(() => device.touchState() === 'ready', 4000), device.touchState());
  await helperSays('DP-4', down(0, 'k1'), up(0));
  check('…and a touch works', session.currentPage() === 'two');
  await session.goToPage('main');
});

console.log('the touchscreen coming and going');
await settle('touchscreen', async () => {
  await helperSays('DP-4', { ev: 'touch-gone', device: `${DEVI}/event15` });
  check('unplugged: the panel stays, touch missing', device.touchState() === 'missing');
  const before = (await frames()).filter((f) => f.type === 'T').length;
  await driver.list();
  check('a scan while it is still listed sends it again', await until(async () => (await frames()).filter((f) => f.type === 'T').length === before + 1));
  await unplugNode('event15');
  await driver.list();
  check('gone from sysfs: none sent, touch missing', await until(async () => (await frames()).filter((f) => f.type === 'T').at(-1)?.mode === 0) && device.touchState() === 'missing');
  await inputNode(ILITEK_NODES[0]);
  await driver.list();
  check('plugged back in: given to the helper again, and ready', await until(() => device.touchState() === 'ready') && (await frames()).filter((f) => f.type === 'T').at(-1)?.mode === 1);
  const sent = (await frames()).filter((f) => f.type === 'T').length;
  await driver.list();
  await sleep(50);
  check('a scan with nothing changed sends nothing', (await frames()).filter((f) => f.type === 'T').length === sent);
  check('…and says nothing again about the sibling', said.filter((l) => /not grabbing event16/.test(l)).length === 1);
  await fs.chmod(path.join(DEVI, 'event16'), 0o600);
  await driver.list();
  check('a sibling it may read (another rule granted it) is grabbed with the touchscreen', await until(async () => JSON.stringify((await frames()).filter((f) => f.type === 'T').at(-1)?.entries) === JSON.stringify([['t', `${DEVI}/event15`], ['s', `${DEVI}/event16`]])));
  await fs.chmod(path.join(DEVI, 'event16'), 0o000);
  await driver.list();
});

console.log('pairing');
await settle('pairing', async () => {
  await plug('DP-6', 'connected', edid({ maker: 'MSI', product: '3ba7', serial: 'BA7T162501350' }));
  const pairing = driver.pair('DP-6');
  await helperSays('DP-6', { ev: 'tap', device: `${DEVI}/event256` });
  const result = await pairing;
  check('the screen tapped is named with its key, its touchscreen as the config keeps it', result.screen === 'MSI-3ba7-BA7T162501350' && JSON.stringify(result.touch) === JSON.stringify({ vendor: '27c0', product: '0859', serial: '9LQ0172005164' }) && result.touchName === 'wch.cn TouchScreen', JSON.stringify(result));
  const all = await frames();
  const start = all.findLastIndex((f) => f.type === 'start' && f.output === 'DP-6');
  const shown = all.slice(start);
  const t = shown.find((f) => f.type === 'T');
  check('"Tap this screen" on the whole screen', shown.some((f) => f.type === 'I' && f.x === 0 && f.y === 0 && f.w === 1920 && f.h === 720));
  check('every touchscreen read without a grab (pairing mode), nothing else', t?.mode === 2 && t.entries.map((e) => e.join(':')).join() === `t:${DEVI}/event7,t:${DEVI}/event15,t:${DEVI}/event20,t:${DEVI}/event256`, JSON.stringify(t));
  check('the helper is quit after', shown.some((f) => f.type === 'Q'));

  const abort = new AbortController();
  const cancelled = driver.pair('DP-6', abort.signal).then(() => 'paired', (err) => err.message);
  await until(async () => (await frames()).filter((f) => f.type === 'start' && f.output === 'DP-6').length === 2);
  abort.abort();
  check('cancelled (the client went away): rejected, helper quit', /cancelled/.test(await cancelled));

  process.env.FAKE_PANEL_TOUCH = 'fail';
  const refused = await driver.pair('DP-6').then(() => 'paired', (err) => err.message);
  delete process.env.FAKE_PANEL_TOUCH;
  check('every touchscreen refused: says why, at once', /Permission denied/.test(refused), refused);
  check('a connector with no screen: not found', (await driver.pair('DP-9').catch((err) => err.code)) === 'not_found');

  // The deck's own screen: its session closes for the tap and comes back.
  const pairDeck = driver.pair('DP-4');
  check('pairing the deck\'s own screen closes the deck first (its grab would hide the tap)', await until(() => session === null), String(session));
  await helperSays('DP-4', { ev: 'tap', device: `${DEVI}/event15` });
  check('…and pairs', JSON.stringify((await pairDeck).touch) === JSON.stringify(ILITEK));
  check('…and asks for a scan after, which lists the deck again', asked.at(-1)?.includes('finished') && (await driver.list()).some((f) => f.id === 'GRA-6e4e'));
});

console.log('not paired, or not readable');
await settle('states', async () => {
  config = validateConfig({ decks: { 'GRA-6e4e': { virtual: { output: 'DP-4' } } }, profiles: config.profiles });
  await startDeck();
  check('no touchscreen in the config: not paired, nothing sent to read', device.touchState() === 'not-paired' && (await until(async () => (await frames()).filter((f) => f.type === 'T').at(-1)?.mode === 0)));
  await session.close();
  config = validateConfig({ decks: { 'GRA-6e4e': { virtual: { output: 'DP-4', touch: ILITEK } } }, profiles: config.profiles });
  const saidBefore = said.length;
  const errorsBefore = errors.length;
  process.env.FAKE_PANEL_TOUCH = 'fail';
  await startDeck();
  delete process.env.FAKE_PANEL_TOUCH;
  check('one that cannot be opened: failed', await until(() => device.touchState() === 'failed'), device.touchState());
  check('…said as touch not available, with the way back (Tap again)',
    await until(() => errors.slice(errorsBefore).some((l) => /GRA-6e4e: touch is not available: cannot open .*Permission denied\. Tap again in Settings › Decks/.test(l))), JSON.stringify(errors.slice(errorsBefore)));
  // The order seen on the laptop after a reboot: the open fails, then logind
  // says the session is unlocked.
  logind.current.lock(true);
  await until(() => said.slice(saidBefore).some((l) => /GRA-6e4e: the session is locked/.test(l)));
  logind.current.lock(false);
  check('…and an unlock after it says touch is not available, with the way back',
    await until(() => said.slice(saidBefore).some((l) => /GRA-6e4e: the session is unlocked; touch is not available: its touchscreen could not be opened\. Tap again/.test(l))), JSON.stringify(said.slice(saidBefore)));
  check('…never "touches work"', !said.slice(saidBefore).some((l) => /touches work/.test(l)), JSON.stringify(said.slice(saidBefore)));
  await session.close();
  session = null;
});

check('a touch config needs vendor and product, four hex digits each', (() => {
  try {
    validateConfig({ decks: { X: { virtual: { output: 'DP-4', touch: { vendor: '222', product: '0001' } } } }, profiles: { p: { layouts: {} } } });
    return false;
  } catch {
    return true;
  }
})());

await logind.current.stop().catch(() => undefined);
lock.release();
try {
  process.kill(Number(busPid), 'SIGTERM');
} catch {}
await fs.rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\nvirtual touch: all checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
