/**
 * Offline test for desktop notifications (src/services/notifications.ts),
 * against scripts/test/fake-notifications.mjs on a private session bus:
 *
 * - **one notification per key, and every one shown**: a key's next
 *   notification closes the one before and shows a new one — never
 *   replaces_id, which Plasma updates silently once the old one has timed
 *   out (VTS session 1, `[confirmed]` on KDE Plasma), for every integration;
 * - a key's old notification already gone: the close fails quietly and the
 *   new one is still shown;
 * - keys are independent;
 * - every notification shown is logged, and a failure to show one too.
 *
 *   npm run build:ts && node scripts/smoke-notifications.mjs
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-notify-bus-${process.pid}.conf`);
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

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { startFakeNotifications } = await import('./test/fake-notifications.mjs');
const { notify } = await import(path.join(REPO, 'dist/services/notifications.js'));

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const logged = [];
const realLog = console.log;
const realError = console.error;
const capture = () => {
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(`ERR ${a.join(' ')}`);
};
const release = () => {
  console.log = realLog;
  console.error = realError;
};

const notes = await startFakeNotifications();
const KEY_A = 'SERIAL:default:main:7';
const KEY_B = 'SERIAL:default:main:8';

capture();
await notify(KEY_A, 'Deck: key 8', 'first failure');
release();
check('a key’s first notification is a new one (replaces nothing)', notes.calls.length === 1 && notes.calls[0].replacesId === 0);
check('as Deckhand, with its icon', notes.calls[0].appName === 'Deckhand' && notes.calls[0].appIcon === 'io.github.juicetheforce.Deckhand');
check('and the journal says it was shown', logged.some((l) => l === `[notify] shown (${notes.calls[0].id}): Deck: key 8 — first failure`));

const firstId = notes.calls[0].id;
capture();
await notify(KEY_A, 'Deck: key 8', 'second failure');
release();
check('the same key again: its old notification is closed first, then a new one shown', notes.order.join() === `notify ${firstId},close ${firstId},notify ${notes.calls[1].id}`);
check('never replaces_id — Plasma updates a timed-out one without showing it', notes.calls.every((c) => c.replacesId === 0));
check('one notification per key: only the new one is showing', notes.open.size === 1 && notes.open.has(notes.calls[1].id));

await notify(KEY_B, 'Deck: key 9', 'another key');
check('another key’s notification closes nothing of the first key’s', notes.open.size === 2 && notes.closed.length === 1);

// Dismissed by the person, or timed out and removed: closing it fails, and the new one is shown anyway.
notes.dismiss(notes.calls[1].id);
logged.length = 0;
capture();
await notify(KEY_A, 'Deck: key 8', 'third failure');
release();
check('a key’s old notification already gone: the new one is still shown', notes.calls.at(-1).body === 'third failure' && notes.open.has(notes.calls.at(-1).id));
check('and the failed close is not reported as a failure to notify', !logged.some((l) => l.startsWith('ERR')));

await notes.vanish();
logged.length = 0;
capture();
await notify(KEY_A, 'Deck: key 8', 'no server');
release();
check('no notification service: logged as not shown, and nothing thrown', logged.some((l) => l.startsWith('ERR [notify] could not show a notification')));
await notes.stop();

console.log(failures === 0 ? '\nnotifications: all checks passed' : `\nnotifications: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
