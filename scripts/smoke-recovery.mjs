/**
 * What Deckhand depends on going away must cost nothing at rest while it stays
 * gone (ARCHITECTURE.md, "Cost scales with what is on screen"). `pactl
 * subscribe`, the input helper, `udevadm monitor` and the config watch each get
 * one quick retry; after that they wait for the 60-second scan. Each runs here
 * against a stand-in that fails, for longer than the old retry delays add up to.
 *
 *   npm run build:ts && node scripts/smoke-recovery.mjs
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-recovery-'));
const BIN = path.join(TMP, 'bin');
const UP = path.join(TMP, 'up');
const CALLS = path.join(TMP, 'calls');
const CONFIG_DIR = path.join(TMP, 'config-not-yet');
await fs.mkdir(BIN);

const stub = async (name, body) => fs.writeFile(path.join(BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
await stub('pactl', `[ "$1" = subscribe ] || exit 1\necho pactl >> "${CALLS}"\n[ -f "${UP}" ] && exec sleep 1000\nexit 1`);
await stub('udevadm', `echo udevadm >> "${CALLS}"\n[ -f "${UP}" ] && exec sleep 1000\nexit 1`);
await stub('input-helper', `echo input >> "${CALLS}"\n[ -f "${UP}" ] && exec "${process.execPath}" "${path.join(REPO, 'scripts/test/fake-input-helper.mjs')}"\nexit 1`);

process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.DECKHAND_INPUT_BIN = path.join(BIN, 'input-helper');
process.env.DECKHAND_CONFIG_DIR = CONFIG_DIR;

const log = console.log;
const quiet = (...args) => {
  if (!/^\[(audio|input|hotplug|config)\]/.test(String(args[0]))) log(...args);
};
console.log = quiet;
console.error = quiet;
console.warn = quiet;

const { input } = await import(path.join(REPO, 'dist/input.js'));
const audio = await import(path.join(REPO, 'dist/services/audio.js'));
const hotplug = await import(path.join(REPO, 'dist/services/hotplug.js'));
const config = await import(path.join(REPO, 'dist/config.js'));
const { Recovery } = await import(path.join(REPO, 'dist/recovery.js'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = async (name) => (await fs.readFile(CALLS, 'utf8').catch(() => '')).split('\n').filter((l) => l === name).length;
let failed = 0;
const check = (name, ok) => {
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};

log('dependencies failing, and nothing happening');
let audioChanges = 0;
let configChanges = 0;
const stopAudio = audio.subscribe(() => audioChanges++);
const stopHotplug = hotplug.watchHotplug(() => undefined);
input.start();
const stopConfig = config.watchConfig(() => configChanges++);
await sleep(11_000);
check(`pactl subscribe: one start and one quick retry, no more (${await calls('pactl')})`, (await calls('pactl')) === 2);
check(`input helper: one start and one quick retry, no more (${await calls('input')})`, (await calls('input')) === 2);
check(`udevadm monitor: one start and one quick retry, no more (${await calls('udevadm')})`, (await calls('udevadm')) === 2);
await fs.mkdir(CONFIG_DIR);
await sleep(1500);
await fs.writeFile(path.join(CONFIG_DIR, 'config.json'), '{}');
await sleep(600);
check('config watch: not retrying by itself once its quick retry failed', configChanges === 0);

log('a press does not wait for the scan');
await input.tap('f24').catch(() => undefined);
check('a press while the helper is gone tries once to start it', (await calls('input')) === 3);

log('the 60-second scan brings each back');
await fs.writeFile(UP, '');
audio.retrySubscribe();
input.retry();
hotplug.retryMonitor();
config.retryConfigWatch();
await sleep(1000);
check('pactl subscribe started again', (await calls('pactl')) === 3);
check('input helper started again', (await calls('input')) === 4);
check('udevadm monitor started again', (await calls('udevadm')) === 3);
await fs.writeFile(path.join(CONFIG_DIR, 'config.json'), '{"a":1}');
await sleep(600);
check('config watch back: it sees a change', configChanges === 1);
audio.retrySubscribe();
input.retry();
hotplug.retryMonitor();
await sleep(500);
check('a scan with nothing to retry starts nothing', (await calls('pactl')) === 3 && (await calls('input')) === 4 && (await calls('udevadm')) === 3);
await input.tap('f24').then(
  () => check('the input helper works again', true),
  (err) => check(`the input helper works again: ${err.message}`, false),
);

log('staying up earns the quick retry back');
{
  let restarts = 0;
  const recovery = new Recovery(() => restarts++, 20, 100);
  const go = () => recovery.started();
  go();
  recovery.lost();
  await sleep(60);
  check('the first loss: a quick retry', restarts === 1);
  go();
  recovery.lost();
  await sleep(60);
  check('lost again at once: none', restarts === 1);
  recovery.retry();
  check('the scan restarts it', restarts === 2);
  go();
  await sleep(150);
  recovery.lost();
  await sleep(60);
  check('having stayed up: a quick retry again', restarts === 3);
}

stopAudio();
stopHotplug();
stopConfig();
input.stop();
await fs.rm(TMP, { recursive: true, force: true });
log(failed === 0 ? '\nrecovery: all checks passed' : `\nrecovery: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
