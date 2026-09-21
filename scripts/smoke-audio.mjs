/**
 * Offline test for audio keys that name a device:
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

console.log('audio.source by node');
{
  const HEADSET_MIC = 'alsa_input.usb-Example_Headset-00.mono-fallback';
  const BUILTIN_MIC = 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source';
  const headsetMic = { type: 'audio.source', node: HEADSET_MIC, label: 'Example Headset Mono Mic' };
  const builtinMic = { type: 'audio.source', node: BUILTIN_MIC, label: 'Built-in Microphone' };
  const defaultSource = () => audio.cachedState().defaultSource;

  await serverState({ defaultSource: HEADSET_MIC });
  const ctx = context();
  const invalidated = [];
  ctx.invalidateByType = (types) => invalidated.push(...types);
  await runActionOrThrow(ctx, builtinMic);
  check('a press makes that exact input the default', defaultSource() === BUILTIN_MIC);
  check('...and repaints mic mute keys, which now show another device', invalidated.includes('audio.micMute'));
  check('the default input\'s key shows active', (await describe(builtinMic)).background === '#1d4d2b');
  check('another input\'s key shows inactive', (await describe(headsetMic)).background === '#101014');
  check('an explicit activeBackground is used', (await describe({ ...builtinMic, activeBackground: '#123456' })).background === '#123456');

  // Moving recording streams: the same rule as audio.sink and audio.cycleSource.
  // An application already recording follows the new default.
  const movedTo = async () => JSON.parse(await fs.readFile(PACTL_STATE, 'utf8')).movedSourceOutputs ?? {};
  await serverState({ defaultSource: HEADSET_MIC });
  await runActionOrThrow(context(), builtinMic);
  check('every recording stream moves to the chosen input',
    Object.keys(await movedTo()).length === 2 && Object.values(await movedTo()).every((to) => to === BUILTIN_MIC));
  await serverState({ defaultSource: HEADSET_MIC });
  await runActionOrThrow(context(), { ...builtinMic, moveStreams: false });
  check('moveStreams: false leaves them where they are', Object.keys(await movedTo()).length === 0);

  await serverState({ defaultSource: HEADSET_MIC, absent: [BUILTIN_MIC] });
  const before = (await spawns()).length;
  const gone = context();
  await runAction(gone, builtinMic);
  check('an input that is not present: logged, naming the label and node',
    gone.logs.some((l) => /failed/.test(l) && l.includes('"Built-in Microphone"') && l.includes(BUILTIN_MIC) && /not present/.test(l)));
  check('...and nothing run, default unchanged',
    !(await spawns()).slice(before).some((l) => l.startsWith('set-default-source')) && defaultSource() === HEADSET_MIC);

  await serverState({ defaultSource: HEADSET_MIC, refuse: [BUILTIN_MIC] });
  check('a switch the server declines is a failure', /did not take effect/.test(await refusal(builtinMic) ?? ''));
  check('an action with no node asks for one', /needs a "node"/.test(await refusal({ type: 'audio.source', label: 'x' }) ?? ''));
  check('match is not accepted (a new action, editor-written)', /needs a "node"/.test(await refusal({ type: 'audio.source', match: 'Microphone' }) ?? ''));
  check('a face with no node shows nothing', (await describe({ type: 'audio.source' })) === null);
}

console.log('audio.cycleSource by devices');
{
  const HEADSET_MIC = 'alsa_input.usb-Example_Headset-00.mono-fallback';
  const BUILTIN_MIC = 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source';
  const PORTLESS = 'alsa_input.virtual-portless';
  const headsetRef = { node: HEADSET_MIC, label: 'Headset Mic' };
  const builtinRef = { node: BUILTIN_MIC, label: 'Built-in Mic' };
  const portlessRef = { node: PORTLESS, label: 'Portless Input' };
  const cycleIn = { type: 'audio.cycleSource', devices: [headsetRef, builtinRef, portlessRef] };
  const defaultSource = () => audio.cachedState().defaultSource;
  const movedTo = async () => JSON.parse(await fs.readFile(PACTL_STATE, 'utf8')).movedSourceOutputs ?? {};

  await serverState({ defaultSource: HEADSET_MIC });
  await runActionOrThrow(context(), cycleIn);
  check('a press steps to the next input', defaultSource() === BUILTIN_MIC);
  await runActionOrThrow(context(), cycleIn);
  check('...and on to the third', defaultSource() === PORTLESS);
  await runActionOrThrow(context(), cycleIn);
  check('...and wraps round to the first', defaultSource() === HEADSET_MIC);

  await serverState({ defaultSource: BUILTIN_MIC });
  const ctx = context();
  const invalidated = [];
  ctx.invalidateByType = (types) => invalidated.push(...types);
  await runActionOrThrow(ctx, cycleIn);
  check('two entries make a toggle', defaultSource() === PORTLESS);
  check('...and mic mute keys repaint, now showing another device', invalidated.includes('audio.micMute'));

  // The point of the action: the recording application
  // follows, rather than the face changing while it stays on the old mic.
  await serverState({ defaultSource: HEADSET_MIC });
  await runActionOrThrow(context(), cycleIn);
  check('every recording stream moves to the new input',
    Object.values(await movedTo()).every((to) => to === BUILTIN_MIC) && Object.keys(await movedTo()).length === 2);

  await serverState({ defaultSource: HEADSET_MIC });
  await runActionOrThrow(context(), { ...cycleIn, moveStreams: false });
  check('moveStreams: false leaves them where they are', Object.keys(await movedTo()).length === 0);

  await serverState({ defaultSource: HEADSET_MIC, refuseMove: [300] });
  const [, errors] = await capturingErrors(() => runActionOrThrow(context(), cycleIn));
  check('a stream that refuses to move is logged', errors.some((l) => /could not move recording stream 300/.test(l)));
  check('...and the others still move', (await movedTo())['301'] === BUILTIN_MIC);
  check('...and the switch itself still counts', defaultSource() === BUILTIN_MIC);

  await serverState({ defaultSource: HEADSET_MIC, absent: [BUILTIN_MIC] });
  const skipped = context();
  await runActionOrThrow(skipped, cycleIn);
  check('an input that is not present is skipped, and said so',
    skipped.logs.some((l) => /skipping input/.test(l) && l.includes(BUILTIN_MIC)) && defaultSource() === PORTLESS);

  await serverState({ defaultSource: HEADSET_MIC, absent: [BUILTIN_MIC, PORTLESS] });
  check('none present is a failure', /none of the listed inputs/.test(await refusal({ type: 'audio.cycleSource', devices: [builtinRef, portlessRef] }) ?? ''));

  await serverState({ defaultSource: HEADSET_MIC });
  check('one device is refused', /at least two/.test(await refusal({ type: 'audio.cycleSource', devices: [headsetRef] }) ?? ''));
  check('no devices list is refused', /needs a "devices" list/.test(await refusal({ type: 'audio.cycleSource' }) ?? ''));
  check('an entry with no node is refused, naming this action',
    /audio\.cycleSource "devices" entry 1 has no "node"/.test(await refusal({ type: 'audio.cycleSource', devices: [headsetRef, { label: 'x' }] }) ?? ''));
  check('matches is not accepted (a new action, editor-written)',
    /needs a "devices" list/.test(await refusal({ type: 'audio.cycleSource', matches: ['Mic', 'Headset'] }) ?? ''));

  await serverState({ defaultSource: HEADSET_MIC, refuse: [BUILTIN_MIC] });
  check('a switch the server declines is a failure', /did not take effect/.test(await refusal(cycleIn) ?? ''));

  await serverState({ defaultSource: BUILTIN_MIC });
  check('the key shows the active entry\'s stored label', (await describe(cycleIn))?.label === 'Built-in Mic');
  check('a fixed label wins', (await describe({ ...cycleIn, label: 'IN' }))?.label === 'IN');
  check('showCurrent: false shows nothing', (await describe({ ...cycleIn, showCurrent: false })) === null);
  check('a stored label that is empty shows the node',
    (await describe({ type: 'audio.cycleSource', devices: [{ node: BUILTIN_MIC, label: '' }, headsetRef] }))?.label === BUILTIN_MIC);
  await serverState({ defaultSource: PORTLESS });
  check('a default not in the list shows nothing',
    (await describe({ type: 'audio.cycleSource', devices: [headsetRef, builtinRef] })) === null);

  const before = (await spawns()).length;
  for (let i = 0; i < 20; i++) await describe(cycleIn);
  check('20 key-face refreshes spawn no pactl', (await spawns()).length === before);
}

console.log('audio.mute face (output mute state)');
{
  const muteKey = { type: 'audio.mute', iconMuted: '/icons/speaker-off.png', iconUnmuted: '/icons/speaker.png', labelMuted: 'Muted', labelUnmuted: 'Sound' };
  await serverState({ defaultSink: STEREO });
  check('the cache knows the default output is not muted', audio.cachedState().defaultSinkMuted === false);
  const unmuted = await describe(muteKey);
  check('unmuted: the unmuted icon and label', unmuted.icon === '/icons/speaker.png' && unmuted.label === 'Sound');
  check('...and no background: state is shown by the icon pair only', !('background' in unmuted));

  const ctx = context();
  const invalidated = [];
  ctx.invalidateByType = (types) => invalidated.push(...types);
  await runActionOrThrow(ctx, { type: 'audio.mute' });
  check('a press mutes the default output, and the cache sees it at once', audio.cachedState().defaultSinkMuted === true);
  check('...and repaints mute keys', invalidated.includes('audio.mute'));
  const muted = await describe(muteKey);
  check('muted: the muted icon and label, still no background', muted.icon === '/icons/speaker-off.png' && muted.label === 'Muted' && !('background' in muted));
  await runActionOrThrow(context(), { type: 'audio.mute' });
  check('a second press unmutes', audio.cachedState().defaultSinkMuted === false && (await describe(muteKey)).icon === '/icons/speaker.png');

  await serverState({ defaultSink: STEREO, muted: { [MONO]: true } });
  check('the face follows the default output: another device muted changes nothing', (await describe(muteKey)).icon === '/icons/speaker.png');
  const switched = context();
  const repaint = [];
  switched.invalidateByType = (types) => repaint.push(...types);
  await runActionOrThrow(switched, { type: 'audio.sink', ...monoRef });
  check('...switching to a muted output shows muted', (await describe(muteKey)).icon === '/icons/speaker-off.png');
  check('...and the output switch repaints mute keys', repaint.includes('audio.mute'));

  check('with no icon or label parameters the face adds nothing (the built-in default is drawn elsewhere)', JSON.stringify(await describe({ type: 'audio.mute' })) === '{}');

  // The fake's default input starts muted (fake-pactl.mjs), so compare, not assume.
  await serverState({ defaultSink: STEREO, muted: { [STEREO]: false } });
  const micBefore = audio.cachedState().defaultSourceMuted;
  await serverState({ defaultSink: STEREO, muted: { [STEREO]: true } });
  check('mic mute is unaffected by output mute',
    audio.cachedState().defaultSinkMuted === true && audio.cachedState().defaultSourceMuted === micBefore);
}

console.log('cost');
{
  const before = (await spawns()).length;
  for (let i = 0; i < 50; i++) {
    await describe({ type: 'audio.sink', ...stereoRef });
    await describe({ type: 'audio.cycle', devices: [stereoRef, monoRef] });
    await describe({ type: 'audio.source', node: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source', label: 'x' });
    await describe({ type: 'audio.mute', iconMuted: '/a.png' });
  }
  check('200 audio key-face refreshes spawn no pactl', (await spawns()).length === before);
}

await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\naudio: all checks passed' : `\naudio: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
