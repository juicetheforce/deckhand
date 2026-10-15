// What the settings window says about each integration (src/renderer/integration-status.ts):
// the sidebar's dot and the page's status line, from the daemon's state, as
// Claude Design's section 14 draws them — and the lines around them.

import assert from 'node:assert/strict';
import type { ObsStatus, TwitchStatus, VtsStatus } from '../../src/control/protocol.js';
import { importedLine, obsView, twitchChips, twitchView, vtsView } from '../src/renderer/integration-status.js';

let failures = 0;
async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const obs = (setUp: boolean, connection: ObsStatus['connection']): ObsStatus => ({
  connection,
  stream: 'stopped',
  record: 'stopped',
  recordPaused: false,
  setUp,
  host: null,
  port: null,
  passwordSet: false,
});
const vts = (setUp: boolean, connection: VtsStatus['connection'], approval: VtsStatus['approval']['state'] = 'none'): VtsStatus => ({
  connection,
  modelId: null,
  setUp,
  port: null,
  approval: { state: approval },
});
const twitch = (link: TwitchStatus['link'], linking: TwitchStatus['linking']['state'] = 'none', scopes: string[] = []): TwitchStatus => ({
  link,
  setUp: link !== 'not-set-up',
  login: link === 'not-set-up' ? null : 'riccochet',
  scopes,
  linking: { state: linking },
});

await check('OBS: not set up (hollow), waiting (grey), connected (green), couldn’t connect (red) — 14c–14f', () => {
  assert.deepEqual(obsView(obs(false, 'not-set-up')), { dot: 'unset', text: 'Not set up' });
  assert.deepEqual(obsView(obs(true, 'unavailable')), { dot: 'waiting', text: 'Waiting for OBS' });
  assert.deepEqual(obsView(obs(true, 'connected')), { dot: 'ok', text: 'Connected' });
  assert.deepEqual(obsView(obs(true, 'auth-failed')), { dot: 'failed', text: 'Couldn’t connect' });
});
await check('OBS set up but nothing shown needs it (idle), or mid-connect: waiting, not connected', () => {
  assert.equal(obsView(obs(true, 'idle')).dot, 'waiting');
  assert.equal(obsView(obs(true, 'connecting')).dot, 'waiting');
});

await check('VTube Studio: the same four states — 14g–14j', () => {
  assert.deepEqual(vtsView(vts(false, 'not-set-up')), { dot: 'unset', text: 'Not set up' });
  assert.deepEqual(vtsView(vts(true, 'unavailable')), { dot: 'waiting', text: 'Waiting for VTube Studio' });
  assert.deepEqual(vtsView(vts(true, 'connected')), { dot: 'ok', text: 'Connected' });
  assert.deepEqual(vtsView(vts(true, 'refused')), { dot: 'failed', text: 'Couldn’t connect' });
});
await check('VTube Studio not set up after a Connect that did not get access: couldn’t connect; while asking, still not set up', () => {
  for (const outcome of ['denied', 'busy', 'not-running', 'api-off', 'unreachable', 'failed'] as const) assert.equal(vtsView(vts(false, 'idle', outcome)).dot, 'failed', outcome);
  assert.equal(vtsView(vts(false, 'idle', 'waiting')).dot, 'unset');
});
await check('VTube Studio set up, and a Connect again denied: the saved token still works, so not red', () => {
  assert.equal(vtsView(vts(true, 'idle', 'denied')).dot, 'waiting');
  assert.equal(vtsView(vts(true, 'connected', 'denied')).dot, 'ok');
});

await check('Twitch: not linked (hollow), linking (grey), linked as the account (green) — 14k–14m', () => {
  assert.deepEqual(twitchView(twitch('not-set-up')), { dot: 'unset', text: 'Not linked' });
  assert.deepEqual(twitchView(twitch('not-set-up', 'waiting')), { dot: 'waiting', text: 'Linking…' });
  assert.deepEqual(twitchView(twitch('linked')), { dot: 'ok', text: 'Linked as riccochet' });
});
await check('Twitch: Link again on a linked account is linking until it ends; a refused link is couldn’t connect', () => {
  assert.equal(twitchView(twitch('linked', 'starting')).dot, 'waiting');
  assert.equal(twitchView(twitch('linked', 'cancelled')).dot, 'ok');
  assert.deepEqual(twitchView(twitch('refused')), { dot: 'failed', text: 'Couldn’t connect' });
});
await check("Twitch's chips: all four before linking; once linked, the ones its permissions allow", () => {
  assert.deepEqual(twitchChips(twitch('not-set-up')), ['Title & category', 'Markers', 'Clips', 'Chat']);
  assert.deepEqual(twitchChips(twitch('linked', 'none', ['channel:manage:broadcast', 'clips:edit', 'user:write:chat'])), ['Title & category', 'Markers', 'Clips', 'Chat']);
  assert.deepEqual(twitchChips(twitch('linked', 'none', ['user:write:chat'])), ['Chat']);
});

await check('after an import: the icon count only when some were written (Ryan’s correction to 14o)', () => {
  assert.equal(importedLine(0, true), 'Imported. Previous setup kept below.');
  assert.equal(importedLine(1, true), 'Imported · 1 icon written. Previous setup kept below.');
  assert.equal(importedLine(3, true), 'Imported · 3 icons written. Previous setup kept below.');
  assert.equal(importedLine(2, false), 'Imported · 2 icons written.');
});

console.log(failures === 0 ? 'settings status: all checks passed' : `settings status: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
