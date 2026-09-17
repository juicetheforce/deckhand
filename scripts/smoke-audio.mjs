/**
 * Offline test for audio keys that name a device (docs/scope.md §3, §7 C1):
 * audio.sink and audio.cycle by exact `node`, with substring `match` kept for
 * hand-edited config. Runs against scripts/test/fake-pactl.mjs with its state
 * file, so presses really change the fake server's default. No audio server.
 *
 *   npm run build:ts && node scripts/smoke-audio.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO, check, failureCount, scratchDir } from './test/control-harness.mjs';

// Fakes first: the audio service runs `pactl` from PATH when called.
const TMP = await scratchDir();
const PACTL_LOG = path.join(TMP, 'pactl.log');
const PACTL_STATE = path.join(TMP, 'pactl-state.json');
await fs.mkdir(path.join(TMP, 'bin'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-pactl.mjs'), path.join(TMP, 'bin', 'pactl'));
process.env.PATH = `${path.join(TMP, 'bin')}:${process.env.PATH}`;
process.env.FAKE_PACTL_LOG = PACTL_LOG;
process.env.FAKE_PACTL_STATE = PACTL_STATE;

const audio = await import(path.join(REPO, 'dist/services/audio.js'));
const { registry, runAction, runActionOrThrow } = await import(path.join(REPO, 'dist/actions/index.js'));

// Node names from fake-pactl.mjs.
const STEREO = 'alsa_output.usb-Example_Headset-00.analog-stereo';
const MONO = 'alsa_output.usb-Example_Headset-00.mono-chat';
const JACK = 'alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink'; // port "not available"
const ACCENTED = 'alsa_output.usb-Accented_Device-00.analog-stereo'; // description "(null)"
const GONE = 'alsa_output.usb-Unplugged_Thing-00.analog-stereo';

const stereoRef = { node: STEREO, label: 'Example Headset Analog Stereo' };
const monoRef = { node: MONO, label: 'Example Headset Mono' };
const accentedRef = { node: ACCENTED, label: 'Accented Device' };

/** Set the fake server's state and re-read the cache. */
async function serverState(state) {
  await fs.writeFile(PACTL_STATE, JSON.stringify(state));
  await audio.refreshCache();
}

const defaultSink = () => audio.cachedState().defaultSink;
const spawns = async () => (await fs.readFile(PACTL_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);

function context() {
  const logs = [];
  return {
    logs,
    deck: null,
    buttonIndex: 0,
    source: 'deck',
    switchProfile: async () => undefined,
    invalidateByType: () => undefined,
    log: (message) => logs.push(message),
  };
}

async function refusal(action) {
  try {
    await runActionOrThrow(context(), action);
    return null;
  } catch (err) {
    return err.message;
  }
}

/** Run fn, returning [result, console.error lines it printed]. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return [await fn(), lines];
  } finally {
    console.error = original;
  }
}

const describe = (action) => registry[action.type].describe(context(), action);

console.log('audio.sink by node');
{
  await serverState({ defaultSink: STEREO });
  await runActionOrThrow(context(), { type: 'audio.sink', ...accentedRef });
  check('a press makes that exact node the default', defaultSink() === ACCENTED);
  check('the pressed key shows active', (await describe({ type: 'audio.sink', ...accentedRef })).background === '#1d4d2b');
  check('another device\'s key shows inactive', (await describe({ type: 'audio.sink', ...stereoRef })).background === '#101014');

  await serverState({ defaultSink: STEREO });
  await runActionOrThrow(context(), { type: 'audio.sink', ...accentedRef, match: 'Example Headset' });
  check('node wins over a match naming another device', defaultSink() === ACCENTED);

  await serverState({ defaultSink: STEREO });
  const before = (await spawns()).length;
  const ctx = context();
  await runAction(ctx, { type: 'audio.sink', node: GONE, label: 'Unplugged Thing' });
  const after = await spawns();
  check('a node that is not present: the press logs it, naming the label and node',
    ctx.logs.some((l) => /failed/.test(l) && l.includes('"Unplugged Thing"') && l.includes(GONE) && /not present/.test(l)));
  check('...and does nothing: no set-default-sink was run', !after.slice(before).some((l) => l.startsWith('set-default-sink')));
  check('...and the default is unchanged', defaultSink() === STEREO);
  const gone = { type: 'audio.sink', node: GONE, label: 'Unplugged Thing' };
  check('...and the key shows inactive, without throwing', (await describe(gone)).background === '#101014');

  await serverState({ defaultSink: STEREO, absent: [MONO] });
  check('a device taken away is not present', /not present/.test(await refusal({ type: 'audio.sink', ...monoRef }) ?? ''));

  // The label names a device that IS present, so a fallback would find it.
  await serverState({ defaultSink: ACCENTED });
  check('no description fallback: a node that is gone is not found by a label matching a present device',
    /not present/.test(await refusal({ type: 'audio.sink', node: GONE, label: 'Example Headset Analog Stereo' }) ?? '')
    && defaultSink() === ACCENTED);

  await serverState({ defaultSink: STEREO });
  check('a switch the server refuses is a failure, not a success',
    /did not take effect/.test(await refusal({ type: 'audio.sink', node: JACK, label: 'Built-in Headphones' }) ?? ''));
  check('an action with neither node nor match asks for a node', /needs a "node"/.test(await refusal({ type: 'audio.sink' }) ?? ''));
}

console.log('audio.sink by match (hand-edited config)');
{
  await serverState({ defaultSink: ACCENTED });
  const [, lines] = await capturingErrors(async () => {
    for (let i = 0; i < 3; i++) await describe({ type: 'audio.sink', match: 'Example Headset' });
    await runActionOrThrow(context(), { type: 'audio.sink', match: 'Example Headset' });
  });
  check('a match hitting two outputs takes the first', defaultSink() === STEREO);
  check('...and says so exactly once across three refreshes and a press',
    lines.filter((l) => /matches 2 outputs/.test(l)).length === 1);
  const [, quiet] = await capturingErrors(() => runActionOrThrow(context(), { type: 'audio.sink', match: 'Accented' }));
  check('a match hitting one output (by node name) works and warns nothing', defaultSink() === ACCENTED && quiet.length === 0);
}

console.log('audio.cycle by devices');
{
  const cycle = { type: 'audio.cycle', devices: [stereoRef, monoRef, accentedRef] };
  await serverState({ defaultSink: STEREO });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await runActionOrThrow(context(), cycle);
    seen.push(defaultSink());
  }
  check('presses step through the list in order and wrap', JSON.stringify(seen) === JSON.stringify([MONO, ACCENTED, STEREO]));

  await serverState({ defaultSink: STEREO, absent: [MONO] });
  const ctx = context();
  await runActionOrThrow(ctx, cycle);
  check('an entry that is not present is skipped', defaultSink() === ACCENTED);
  check('...and the skip is logged with its label', ctx.logs.some((l) => /skipping/.test(l) && l.includes('"Example Headset Mono"')));

  await serverState({ defaultSink: ACCENTED });
  await runActionOrThrow(context(), { type: 'audio.cycle', devices: [stereoRef, monoRef] });
  check('a default not in the list goes to the first entry', defaultSink() === STEREO);

  await serverState({ defaultSink: STEREO, absent: [STEREO, MONO] });
  check('none present is a failure', /none of the listed outputs/.test(await refusal({ type: 'audio.cycle', devices: [stereoRef, monoRef] }) ?? ''));
  await serverState({ defaultSink: STEREO });
  check('one device is refused', /at least two/.test(await refusal({ type: 'audio.cycle', devices: [stereoRef] }) ?? ''));
  const [bad, badLines] = await capturingErrors(async () => {
    const { describeAction } = await import(path.join(REPO, 'dist/actions/index.js'));
    const ctx = context();
    const faces = [];
    for (let i = 0; i < 3; i++) faces.push(await describeAction(ctx, { type: 'audio.cycle', devices: [stereoRef, { label: 'x' }] }));
    return { faces, logs: ctx.logs };
  });
  check('...and its face shows nothing, logging nothing on refresh',
    bad.faces.every((f) => f === null) && bad.logs.length === 0 && badLines.length === 0);
  check('an entry with no node is refused', /entry 1 has no "node"/.test(await refusal({ type: 'audio.cycle', devices: [stereoRef, { label: 'x' }] }) ?? ''));

  await serverState({ defaultSink: MONO });
  check('the key shows the active entry\'s stored label', (await describe(cycle))?.label === 'Example Headset Mono');
  await serverState({ defaultSink: STEREO });
  check('...which tells the stereo and mono sinks apart', (await describe(cycle))?.label === 'Example Headset Analog Stereo');
  check('a stored label that is empty shows the node', (await describe({ type: 'audio.cycle', devices: [{ node: STEREO, label: '' }, monoRef] }))?.label === STEREO);
  check('a fixed label wins', (await describe({ ...cycle, label: 'OUT' }))?.label === 'OUT');
  check('showCurrent: false shows nothing', (await describe({ ...cycle, showCurrent: false })) === null);
  await serverState({ defaultSink: JACK });
  check('a default not in the list shows nothing', (await describe(cycle)) === null);
}

console.log('audio.cycle by matches (hand-edited config), unchanged');
{
  await serverState({ defaultSink: MONO });
  await runActionOrThrow(context(), { type: 'audio.cycle', matches: ['Mono', 'Accented'] });
  check('matches still cycle', defaultSink() === ACCENTED);
  await serverState({ defaultSink: MONO });
  check('matches still show the default\'s first word', (await describe({ type: 'audio.cycle', matches: ['Mono', 'Accented'] }))?.label === 'Example');
}

console.log('cost');
{
  const before = (await spawns()).length;
  for (let i = 0; i < 50; i++) {
    await describe({ type: 'audio.sink', ...stereoRef });
    await describe({ type: 'audio.cycle', devices: [stereoRef, monoRef] });
  }
  check('100 key-face refreshes by node spawn no pactl', (await spawns()).length === before);
}

await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\naudio: all checks passed' : `\naudio: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
