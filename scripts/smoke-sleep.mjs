/**
 * Deck sleep (src/sleep.ts): on a lock, as logind says it through a fake on a
 * private bus standing in for the system bus, and by the Sleep all decks action.
 * Fake decks; then the real daemon, for the wiring in src/index.ts.
 *
 *   npm run build:ts && node scripts/smoke-sleep.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-sleep-'));
process.env.FAKE_INPUT_LOG = path.join(TMP, 'input.log');
process.env.DECKHAND_INPUT_BIN = path.join(REPO, 'scripts/test/fake-input-helper.mjs');

await fs.writeFile(
  path.join(TMP, 'bus.conf'),
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${TMP}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
);
const [busAddress, busPid] = execFileSync('dbus-daemon', ['--config-file', path.join(TMP, 'bus.conf'), '--fork', '--print-address=1', '--print-pid=1']).toString().trim().split('\n');
process.env.DBUS_SYSTEM_BUS_ADDRESS = busAddress;

const { startDaemon, FakeDeck, connect, check, failureCount, sleep: wait } = await import('./test/control-harness.mjs');
const { startFakeLogind } = await import('./test/fake-logind.mjs');
const lock = await import(path.join(REPO, 'dist/services/session-lock.js'));
const { sleep } = await import(path.join(REPO, 'dist/sleep.js'));
const { registry } = await import(path.join(REPO, 'dist/actions/index.js'));

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(20);
  }
  return false;
};

let presses = 0;
let releases = 0;
registry['test.press'] = { async execute() { presses++; } };
registry['test.release'] = { async execute() { releases++; } };

const buttons = {
  0: { action: { type: 'test.press' }, onRelease: { type: 'test.release' } },
  1: { action: { type: 'sleep.all', mode: 'dim', level: 20 } },
  2: { action: { type: 'sleep.all', mode: 'off' } },
  3: { action: { type: 'brightness', value: 60 } },
  4: { action: { type: 'brightness', value: 33, deck: 'B' } },
  5: { action: { type: 'brightness', delta: -10, deck: 'B' } },
  6: { action: { type: 'brightness', value: 33, deck: 'GONE' } },
  7: { action: { type: 'brightness', delta: 10 } },
};
const CONFIG = {
  decks: { A: { brightness: 40 }, B: { brightness: 70 } },
  profiles: { home: { name: 'Home', layouts: { A: { pages: { main: { buttons } } }, B: { pages: { main: { buttons } } }, C: { pages: { main: { buttons } } } } } },
};

let logind = await startFakeLogind(busAddress);
lock.acquire();
await until(() => lock.lockState() === 'open');
const daemon = await startDaemon(TMP, CONFIG);
const a = new FakeDeck();
const b = new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Fake V2' });
await daemon.attach('A', a);
await daemon.attach('B', b);
const client = await connect(daemon.socket);
const status = async () => Object.fromEntries((await client.request('status')).result.decks.map((d) => [d.serial, d]));
const tap = async (deck, key) => {
  deck.press(key);
  await wait(40);
  deck.release(key);
  await wait(40);
};

console.log('awake');
check('each deck at its own brightness', a.brightness === 40 && b.brightness === 70);
check('status names no sleep', (await status()).A.sleep === undefined);

console.log('the screen locks');
logind.lock(true);
check('every deck at 0', await until(() => a.brightness === 0 && b.brightness === 0));
check('status says why, and keeps the brightness', (await status()).A.sleep === 'lock' && (await status()).A.brightness === 40);
await tap(a, 0);
check('the first press only wakes: its key does not run, its release does not either', presses === 0 && releases === 0);
check('…that deck wakes, the other stays dark', a.brightness === 40 && b.brightness === 0);
await tap(a, 0);
check('the next press runs its key', presses === 1 && releases === 1);
logind.lock(false);
check('unlocked: every deck back at its own brightness', await until(() => b.brightness === 70) && a.brightness === 40);
check('status names no sleep again', (await status()).B.sleep === undefined);

a.press(0);
await wait(40);
logind.lock(true);
await until(() => a.brightness === 0);
a.release(0);
await wait(40);
check('a key held down as the lock came: its release still runs, so nothing stays held', releases === 2);
logind.lock(false);
await until(() => a.brightness === 40);

console.log('not the active session');
logind.activate(false);
check('every deck at 0', await until(() => a.brightness === 0 && b.brightness === 0));
logind.activate(true);
check('active again: awake', await until(() => a.brightness === 40 && b.brightness === 70));

console.log('a press while asleep, on a key that sets the brightness');
logind.lock(true);
await until(() => a.brightness === 0);
await daemon.sessions.get('A').setBrightness(55);
check('a level set while asleep changes nothing on the deck', a.brightness === 0);
logind.lock(false);
check('…and is what it wakes to', await until(() => a.brightness === 55));
await daemon.sessions.get('A').setBrightness(0);
check("a person's own brightness still cannot go below 5", a.brightness === 5);
await daemon.sessions.get('A').setBrightness(40);

console.log('the lock state cannot be read');
logind.lock(true);
await until(() => a.brightness === 0);
await logind.stop();
check('logind gone: the decks wake and stay awake', await until(() => a.brightness === 40 && b.brightness === 70));
check('…as for virtual decks it stays unknown', lock.lockState() === 'unknown');
logind = await startFakeLogind(busAddress);
lock.retry();
await until(() => lock.lockState() === 'open');

console.log('the setting off');
sleep.setOnLock(false);
logind.lock(true);
await until(() => lock.lockState() === 'locked');
await wait(50);
check('locked: the decks stay lit', a.brightness === 40 && b.brightness === 70);
sleep.setOnLock(true);
check('turned on while locked: dark', await until(() => a.brightness === 0));
sleep.setOnLock(false);
check('turned off while locked: lit', await until(() => a.brightness === 40));
sleep.setOnLock(true);
logind.lock(false);
await until(() => a.brightness === 40 && lock.lockState() === 'open');

console.log('Sleep all decks: dim');
await tap(a, 1);
check('every deck dimmed to its level', a.brightness === 20 && b.brightness === 20);
check('status says why', (await status()).B.sleep === 'all');
const before = presses;
await tap(b, 0);
check('a press on any deck runs its key', presses === before + 1);
check('…and wakes them all', a.brightness === 40 && b.brightness === 70);
await tap(a, 1);
await tap(a, 1);
check("its own key, pressed while dimmed, wakes them and does not dim them again", a.brightness === 40 && b.brightness === 70 && !sleep.allActive());
await daemon.sessions.get('A').setBrightness(10);
await tap(b, 1);
check('a deck set lower than the level stays where it is', a.brightness === 10 && b.brightness === 20);
await tap(b, 1);
await daemon.sessions.get('A').setBrightness(40);

console.log('Sleep all decks: off');
await tap(a, 2);
check('every deck dark', a.brightness === 0 && b.brightness === 0);
const offBefore = [presses, releases];
b.press(0);
await wait(40);
check('a press wakes them all', a.brightness === 40 && b.brightness === 70);
b.release(0);
await wait(40);
check('…and is swallowed, its release too', presses === offBefore[0] && releases === offBefore[1]);
await tap(a, 2);
const late = new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'originalv2', productName: 'Late' });
await daemon.attach('C', late);
check('a deck plugged in while they sleep starts dark', late.brightness === 0);
await tap(a, 0);
check('and wakes with them', late.brightness !== 0 && a.brightness === 40);

console.log('Brightness, on another deck');
await tap(a, 4);
check('it sets the deck it names, not its own', b.brightness === 33 && a.brightness === 40);
await tap(a, 5);
check('it nudges from that deck\'s own level', b.brightness === 23 && a.brightness === 40);
await tap(a, 7);
check('with none named, it is this deck', a.brightness === 50 && b.brightness === 23);
await tap(a, 6);
const gone = (await status()).A.failed ?? [];
check('a deck not connected: the press fails, and says so', gone.some((f) => f.key === '6' && /not connected/.test(f.error)), JSON.stringify(gone));
await daemon.sessions.get('A').setBrightness(40);
await daemon.sessions.get('B').setBrightness(70);

console.log('a virtual deck, dimmed in software');
{
  const levels = [];
  const panel = { serial: 'PANEL', canDim: () => true, sleepsOnLock: () => false, setBrightness: async () => {}, currentBrightness: () => 100, applySleep(level) { levels.push(level); }, invalidateByType() {} };
  sleep.add(panel);
  logind.lock(true);
  await until(() => a.brightness === 0);
  check('a lock leaves it alone: its screen has the lock screen and power saving', sleep.reason(panel) === null && levels.every((l) => l === null));
  logind.lock(false);
  await until(() => a.brightness === 40);
  await tap(a, 1);
  check('Sleep all decks dims it to the level', levels.at(-1) === 20 && sleep.reason(panel) === 'all');
  check('a touch brings every deck back, and runs its key', sleep.press(panel) === 'woke' && a.brightness === 40 && levels.at(-1) === null);
  await tap(a, 2);
  check('Sleep all decks off: pure black', levels.at(-1) === 0);
  check('a touch only wakes', sleep.press(panel) === 'swallow' && levels.at(-1) === null);
  sleep.remove(panel);
}

console.log('a deck with no backlight');
const virtual = { serial: 'V', canDim: () => false, sleepsOnLock: () => true, setBrightness: async () => {}, currentBrightness: () => 100, applySleep(level) { if (level !== null) throw new Error('must not be dimmed'); }, invalidateByType() {} };
sleep.add(virtual);
logind.lock(true);
await until(() => a.brightness === 0);
check('it is never asleep', sleep.reason(virtual) === null && sleep.press(virtual) === 'none');
logind.lock(false);
await until(() => a.brightness === 40);
sleep.remove(virtual);

client.close();
lock.release();
await logind.stop();

console.log('the daemon');
logind = await startFakeLogind(busAddress);
const CONFIG_DIR = path.join(TMP, 'config');
const DECKS_FILE = path.join(TMP, 'decks.json');
const DECK_LOG = path.join(TMP, 'deck.log');
const SOCKET = path.join(TMP, 'real.sock');
await fs.mkdir(CONFIG_DIR);
const realConfig = { decks: { XL1: { brightness: 50 } }, profiles: { home: { name: 'Home', layouts: { XL1: { pages: { main: { buttons: {} } } } } } } };
await fs.writeFile(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(realConfig));
await fs.writeFile(DECKS_FILE, JSON.stringify([{ model: 'xl', path: '/fake/xl-0', serialNumber: 'XL1', productName: 'Fake XL' }]));
const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')], {
  env: {
    ...process.env,
    DECKHAND_CONFIG_DIR: CONFIG_DIR,
    DECKHAND_STATE_DIR: path.join(TMP, 'state'),
    DECKHAND_SOCKET: SOCKET,
    FAKE_DECKS_FILE: DECKS_FILE,
    FAKE_DECKS_LOG: DECK_LOG,
  },
  stdio: 'ignore',
});
const lastLevel = async () => (await fs.readFile(DECK_LOG, 'utf8').catch(() => '')).split('\n').filter((l) => l.startsWith('brightness')).at(-1);
check('it attaches at its brightness', await until(() => lastLevel().then((l) => l === 'brightness XL1 50'), 10_000));
logind.lock(true);
check('it follows logind with no virtual deck: a lock darkens the deck', await until(() => lastLevel().then((l) => l === 'brightness XL1 0'), 5000));
logind.lock(false);
check('unlocking wakes it', await until(() => lastLevel().then((l) => l === 'brightness XL1 50'), 5000));
realConfig.defaults = { sleep: { onLock: false } };
await fs.writeFile(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(realConfig));
await wait(800);
logind.lock(true);
await wait(600);
check('"defaults.sleep.onLock": false, by a reload: a lock leaves it lit', (await lastLevel()) === 'brightness XL1 50');
child.kill('SIGTERM');
await new Promise((resolve) => child.on('exit', resolve));
await logind.stop();

process.kill(Number(busPid));
await daemon.close?.();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\nsleep: all checks passed' : `\nsleep: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
