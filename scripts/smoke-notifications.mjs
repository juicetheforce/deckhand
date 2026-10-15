/**
 * Offline test for desktop notifications (src/services/notifications.ts),
 * against scripts/test/fake-notifications.mjs on a private session bus:
 *
 * - **every failure notifies; a key keeps one notification.** The same key
 *   again within REPEAT_WINDOW_MS (10 s): its notification says how many
 *   times — **updated in place (replaces_id) while its popup is up**, and
 *   **closed and shown anew once its popup has gone** (NotificationClosed),
 *   since Plasma updates a timed-out one without showing it (VTS session 1,
 *   `[confirmed]` on KDE Plasma);
 * - later than the window, or after the key's failure was cleared (forget),
 *   the count starts again, and the old notification is still closed;
 * - a key's old notification already gone: the close fails quietly and the
 *   new one is still shown;
 * - keys are independent;
 * - every notification shown or updated is logged, and a failure to show one;
 * - each names Deckhand's desktop entry (the desktop-entry hint).
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
const { notify, forget, REPEAT_WINDOW_MS } = await import(path.join(REPO, 'dist/services/notifications.js'));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The fake clock the service is given: failures are this far apart, not really waited for. */
const T0 = 1_000_000;

capture();
await notify(KEY_A, 'Deck: key 8', 'first failure', T0);
release();
check('a key’s first notification is a new one (replaces nothing)', notes.calls.length === 1 && notes.calls[0].replacesId === 0);
check('as Deckhand, with its icon', notes.calls[0].appName === 'Deckhand' && notes.calls[0].appIcon === 'io.github.juicetheforce.Deckhand');
// scripts/install.sh names the desktop file from the editor's desktopName: the hint must be the same, or KDE files them under nothing.
const desktopName = JSON.parse(await fs.readFile(path.join(REPO, 'editor/package.json'), 'utf8')).desktopName;
check(`naming its desktop entry (the desktop-entry hint) — the installer's ${desktopName}, without ".desktop"`, notes.calls[0].hints['desktop-entry'] === desktopName.replace(/\.desktop$/, ''));
check('and the journal says it was shown', logged.some((l) => l === `[notify] shown (${notes.calls[0].id}): Deck: key 8 — first failure`));

const firstId = notes.calls[0].id;
check(`the window is about 10 s (${REPEAT_WINDOW_MS} ms)`, REPEAT_WINDOW_MS === 10_000);

// Again within the window, its popup still up: updated in place, with a count.
logged.length = 0;
capture();
await notify(KEY_A, 'Deck: key 8', 'second failure', T0 + 3_000);
release();
const second = notes.calls[1];
check('the same key again within 10 s, its popup up: the same notification updated in place (replaces_id)', second.replacesId === firstId && second.id === firstId);
check('saying how many times', second.summary === 'Deck: key 8 (failed 2 times)' && second.body === 'second failure');
check('nothing closed, nothing added: one showing', notes.closed.length === 0 && notes.open.size === 1);
check('and the journal says it was updated', logged.some((l) => l === `[notify] updated (${firstId}): Deck: key 8 (failed 2 times) — second failure`));

// Its popup timed out (Plasma says so): an update now would not be seen, so the old one is closed and a new one shown, still counting.
notes.expire(firstId);
await sleep(200);
await notify(KEY_A, 'Deck: key 8', 'third failure', T0 + 6_000);
const third = notes.calls[2];
check('its popup gone: the old one closed first, then a new one shown — never an update nobody sees', notes.order.slice(-2).join() === `close ${firstId},notify ${third.id}` && third.replacesId === 0 && third.id !== firstId);
check('still counting', third.summary === 'Deck: key 8 (failed 3 times)');
check('one per key: only the new one is showing', notes.open.size === 1 && notes.open.has(third.id));

// Later than the window: a first failure again.
await notify(KEY_A, 'Deck: key 8', 'much later', T0 + 6_000 + REPEAT_WINDOW_MS + 1);
const later = notes.calls[3];
check('later than 10 s: the old one closed and a new one shown, with no count', notes.order.slice(-2).join() === `close ${third.id},notify ${later.id}` && later.replacesId === 0 && later.summary === 'Deck: key 8');

// Cleared (the editor's Clear, or a press that worked): the next failure is a first one, even within the window.
forget(KEY_A);
await notify(KEY_A, 'Deck: key 8', 'after a clear', T0 + 6_000 + REPEAT_WINDOW_MS + 1_000);
const afterClear = notes.calls[4];
check('after a clear, within 10 s: a new notification with no count, the old one still closed', notes.order.slice(-2).join() === `close ${later.id},notify ${afterClear.id}` && afterClear.replacesId === 0 && afterClear.summary === 'Deck: key 8');

await notify(KEY_B, 'Deck: key 9', 'another key', T0 + 6_000 + REPEAT_WINDOW_MS + 1_500);
check('another key’s notification is its own, and closes nothing of the first key’s', notes.calls[5].replacesId === 0 && notes.open.size === 2 && notes.open.has(afterClear.id));

// Dismissed by the person: closing it fails, and the new one is shown anyway.
notes.dismiss(afterClear.id);
await sleep(200);
logged.length = 0;
capture();
await notify(KEY_A, 'Deck: key 8', 'dismissed before', T0 + 6_000 + REPEAT_WINDOW_MS + 2_000);
release();
const afterDismiss = notes.calls.at(-1);
check('a key’s old notification dismissed: a new one is shown, counting', afterDismiss.replacesId === 0 && afterDismiss.body === 'dismissed before' && notes.open.has(afterDismiss.id) && afterDismiss.summary === 'Deck: key 8 (failed 2 times)');
check('and the failed close is not reported as a failure to notify', !logged.some((l) => l.startsWith('ERR')));

await notes.vanish();
logged.length = 0;
capture();
await notify(KEY_A, 'Deck: key 8', 'no server', T0 + 60_000);
release();
check('no notification service: logged as not shown, and nothing thrown', logged.some((l) => l.startsWith('ERR [notify] could not show a notification')));
await notes.stop();

console.log(failures === 0 ? '\nnotifications: all checks passed' : `\nnotifications: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
