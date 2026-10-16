/**
 * Offline test for Twitch: linking by
 * device code, the link's tokens and their refresh, the hourly check, and
 * the keys' requests — against scripts/test/fake-twitch.mjs, never the real
 * Twitch (DECKHAND_TWITCH_ID_URL and DECKHAND_TWITCH_API_URL point at it).
 *
 * The fake does what the real Twitch did in the probe, so the landmines are
 * tested, not assumed: **sending a replaced refresh token ends the whole
 * link**, so one refresh at a time; a refused refresh keeps the link and
 * the hourly check recovers it; polling never sooner than Twitch's interval.
 *
 * Two halves, as smoke-vts.mjs has: services/twitch.ts in this process; then
 * the real `dist/index.js` in a child with a fake deck — a saved link
 * validated at start, `deckhand twitch link` and its Ctrl+C, the Chat
 * message key pressed on the deck, and what is marked and notified. It runs
 * itself on a private D-Bus session, for the fake notification service.
 *
 *   npm run build:ts && node scripts/smoke-twitch.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-twitch-bus-${process.pid}.conf`);
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

// The state directory is read when dist/backups.js is first imported, so it is set before any import of dist/.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
process.env.DECKHAND_STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');

const { REPO, check, failureCount, sleep, connect } = await import('./test/control-harness.mjs');
const { startFakeNotifications } = await import('./test/fake-notifications.mjs');
const { startFakeTwitch } = await import('./test/fake-twitch.mjs');
const twitch = await import(path.join(REPO, 'dist/services/twitch.js'));
const credentials = await import(path.join(REPO, 'dist/credentials.js'));
const { ActionNeeded, NotSetUp } = await import(path.join(REPO, 'dist/action-error.js'));

/** Wait until fn() is truthy, up to ms. */
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
/** What a promise rejects with, or null. */
const rejection = (promise) => promise.then(() => null, (err) => err);
const linking = () => twitch.cachedState().linking.state;
const CHAT = { scope: 'user:write:chat', what: 'chat messages' };
const say = (message) => twitch.request('POST', '/chat/messages', { broadcaster_id: '151766307', sender_id: '151766307', message }, CHAT);

const fake = await startFakeTwitch({ interval: 1 });
process.env.DECKHAND_TWITCH_ID_URL = `${fake.url}/oauth2`;
process.env.DECKHAND_TWITCH_API_URL = `${fake.url}/helix`;
const count = (pathName, grant) => fake.requests.filter((r) => r.path === pathName && (!grant || r.body.grant_type === grant)).length;
const refreshes = () => count('/oauth2/token', 'refresh_token');

// --- Not linked -------------------------------------------------------------------

check('not linked: not set up', twitch.status().setUp === false && twitch.status().link === 'not-set-up');
check('a request while not linked is NotSetUp, and nothing is sent', (await rejection(say('x'))) instanceof NotSetUp && fake.requests.length === 0);

// --- Linking ----------------------------------------------------------------------

const cancelFirst = twitch.startLinking();
check('Link starts', typeof cancelFirst === 'function');
check('a second Link while one is in progress does not start another', twitch.startLinking() === null);
check('the code is shown, with the page that has it filled in', await until(() => linking() === 'waiting'));
const shown = twitch.cachedState().linking;
check('the code and the activate page are in the status', /^[A-Z0-9]{8}$/.test(shown.userCode ?? '') && shown.verificationUri?.includes(shown.userCode));
await sleep(1500);
check('it polls while waiting', count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code') >= 1);
fake.approve();
check('approved: linked', await until(() => twitch.status().link === 'linked'));
check('as the account Twitch names, with the scopes it granted', twitch.status().login === 'fakestreamer' && twitch.status().scopes.includes('user:write:chat'));
check('the linking state says so', linking() === 'approved');
const saved = await credentials.twitchCredentials();
check('saved: client ID, user, tokens and when the access token lapses', saved?.clientId === fake.clientId && saved.userId === '151766307' && !!saved.accessToken && !!saved.refreshToken && saved.expiresAt > Date.now());
check('the status never carries a token', !JSON.stringify(twitch.status()).includes(saved.refreshToken) && !JSON.stringify(twitch.status()).includes(saved.accessToken));
const polls = count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code');
await sleep(1500);
check('approved: polling stopped', count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code') === polls);
cancelFirst();
check("a finished link's cancel does nothing", linking() === 'approved');

// --- Requests ---------------------------------------------------------------------

check('a chat message is sent as the linked account', (await say('hello')) && fake.chat.at(-1)?.message === 'hello' && fake.chat.at(-1)?.sender === '151766307');

fake.expireAccess();
const before = (await credentials.twitchCredentials()).refreshToken;
check('a 401: refreshed once, and the press retried and sent', (await say('after 401')) && fake.chat.at(-1)?.message === 'after 401' && refreshes() === 1);
const after = await credentials.twitchCredentials();
check('the new pair is saved, the refresh token replaced', after.refreshToken !== before && after.accessToken !== saved.accessToken);

fake.expireAccess();
const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => rejection(say(`burst ${n}`))));
check('five presses at once that all find the token lapsed share one refresh', refreshes() === 2);
check('…all five are sent', burst.every((e) => e === null) && fake.chat.filter((c) => c.message.startsWith('burst')).length === 5);
check('…and the link is still alive: no replaced token was sent', fake.linksAlive() === 1);

await credentials.setTwitchCredentials({ ...(await credentials.twitchCredentials()), expiresAt: Date.now() - 1000 });
const r = refreshes();
const sent401s = fake.requests.length;
await say('lapsed by the clock');
check('an access token past its time is refreshed before the request, not after a 401', refreshes() === r + 1 && fake.requests.slice(sent401s).filter((q) => q.path === '/helix/chat/messages').length === 1);

// --- The hourly check -------------------------------------------------------------

const v = count('/oauth2/validate');
const r2 = refreshes();
await twitch.checkNow();
check('the check validates the token, and leaves a good one alone', count('/oauth2/validate') === v + 1 && refreshes() === r2);
await credentials.setTwitchCredentials({ ...(await credentials.twitchCredentials()), expiresAt: Date.now() + 30 * 60 * 1000 });
await twitch.checkNow();
check('a token lapsing before the next check is refreshed by this one', refreshes() === r2 + 1);
fake.expireAccess();
await credentials.setTwitchCredentials({ ...(await credentials.twitchCredentials()), expiresAt: Date.now() + 3 * 3600 * 1000 });
await twitch.checkNow();
check('a token Twitch no longer accepts is refreshed by the check', refreshes() === r2 + 2 && (await say('after the check')) !== null);

// --- Refused, and recovering --------------------------------------------------

fake.refuseRefresh = true;
fake.expireAccess();
const refusedErr = await rejection(say('refused'));
check('a refused refresh: the press is ActionNeeded, saying to link again', refusedErr instanceof ActionNeeded && /link again/.test(refusedErr.message));
check('…the link is refused, and still set up', twitch.status().link === 'refused' && twitch.status().setUp === true);
check('…and its tokens are kept', (await credentials.twitchCredentials())?.refreshToken !== undefined);
const r3 = refreshes();
check('while refused, a press asks nothing of Twitch', (await rejection(say('refused again'))) instanceof ActionNeeded && refreshes() === r3);
await twitch.checkNow();
check('the hourly check tries the refresh again', refreshes() === r3 + 1 && twitch.status().link === 'refused');
fake.refuseRefresh = false;
await twitch.checkNow();
check('Twitch accepts it again: the next check recovers the link, with nothing for the person to do', twitch.status().link === 'linked');
check('…and presses work again', (await say('recovered')) !== null && fake.chat.at(-1)?.message === 'recovered');

// --- What the link allows ---------------------------------------------------------

const full = await credentials.twitchCredentials();
await credentials.setTwitchCredentials({ ...full, scopes: ['clips:edit'] });
const scopeErr = await rejection(say('no scope'));
check("a link that does not allow chat: ActionNeeded, saying to link again, and nothing sent", scopeErr instanceof ActionNeeded && /does not allow chat messages/.test(scopeErr.message) && fake.chat.at(-1)?.message === 'recovered');
await credentials.setTwitchCredentials(full);

// --- Twitch unreachable -----------------------------------------------------------

fake.down = true;
const downErr = await rejection(say('down'));
check('Twitch down: "could not be reached", and the link is not refused', /could not be reached/.test(downErr?.message ?? '') && twitch.status().link === 'linked');
fake.down = false;

// --- Cancel, expiry, and a link's own cancel --------------------------------------

const cancelOne = twitch.startLinking();
await until(() => linking() === 'waiting');
twitch.cancelLinking();
check('Cancel', linking() === 'cancelled');
const pollsAfterCancel = count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code');
await sleep(1500);
check('…stops the polling at once', count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code') === pollsAfterCancel);
check('…and leaves the link it had as it was', twitch.status().link === 'linked');
cancelOne();

twitch.startLinking();
await until(() => linking() === 'waiting');
fake.expire();
check('the code expiring: expired', await until(() => linking() === 'expired'));

const cancelOld = twitch.startLinking();
await until(() => linking() === 'waiting');
twitch.cancelLinking();
const cancelNew = twitch.startLinking();
await until(() => linking() === 'waiting');
cancelOld();
check("an earlier link's cancel cannot stop a later one", linking() === 'waiting');
cancelNew();
check("its own does", linking() === 'cancelled');

// --- Category search --------------------------------------------------------------

const found = await twitch.searchCategories('fort');
check("category search: Twitch's own, by ID with the name", found.ok && found.items.length === 1 && found.items[0].id === '33214' && found.items[0].name === 'Fortnite');
check('…the query sent as typed, encoded', fake.searches.at(-1) === 'fort');
const none = await twitch.searchCategories('nothing like this');
check('no match: an empty list, not an error', none.ok && none.items.length === 0);
fake.down = true;
const downList = await twitch.searchCategories('fort');
check('Twitch down: an answer saying so, not an error', downList.ok === false && downList.reason === 'unavailable');
fake.down = false;

// --- A new link, and Remove -------------------------------------------------------

const oldLink = await credentials.twitchCredentials();
twitch.startLinking();
await until(() => linking() === 'waiting');
fake.approve();
await until(() => linking() === 'approved');
const newLink = await credentials.twitchCredentials();
check('linking again replaces the saved link', newLink.refreshToken !== oldLink.refreshToken);
check('…and the old one is not revoked (unmeasured whether that would end the new one)', fake.linksAlive() === 2);

twitch.setClientId('someoneelsesclientid');
check("config.json's client ID does not change a saved link", (await say('own client ID')) !== null);
twitch.startLinking();
check("…but the next link is made with it", await until(() => linking() === 'failed') && fake.requests.at(-1).body.client_id === 'someoneelsesclientid');
twitch.setClientId(undefined);

const revokesBefore = count('/oauth2/revoke');
const revoked = await twitch.remove();
check('Remove says Twitch confirmed ending the link', revoked === true);
check('Remove: not set up, nothing saved', twitch.status().setUp === false && (await credentials.twitchCredentials()) === null);
check('…and the link is ended at Twitch, by its refresh token', count('/oauth2/revoke') === revokesBefore + 1 && fake.requests.at(-1).body.token === newLink.refreshToken && fake.linksAlive() === 1);
const notLinkedList = await twitch.searchCategories('fort');
check('category search while not linked: an answer saying to link, and nothing sent', notLinkedList.ok === false && notLinkedList.reason === 'not-set-up' && fake.searches.length === 2);
check('after Remove, a press is NotSetUp again', (await rejection(say('gone'))) instanceof NotSetUp);
check('Remove with nothing linked: null — nothing to end', (await twitch.remove()) === null);
// Twitch not answering: the link is still forgotten here, and Remove says Twitch did not confirm.
twitch.startLinking();
await until(() => linking() === 'waiting');
fake.approve();
await until(() => twitch.status().link === 'linked');
fake.down = true;
const unconfirmed = await twitch.remove();
check('Remove with Twitch down: forgotten here, and says Twitch did not confirm ending it', unconfirmed === false && twitch.status().setUp === false && (await credentials.twitchCredentials()) === null);
fake.down = false;

check('no poll in this run was sooner than Twitch asked: never answered slow_down', fake.slowDowns === 0);

twitch.stop();

// --- The daemon -------------------------------------------------------------------

const CONFIG_DIR = path.join(TMP, 'config2');
const STATE2 = path.join(TMP, 'state2');
const SOCKET = path.join(TMP, 'd.sock');
const DECKS_FILE = path.join(TMP, 'decks.json');
const PRESS_FILE = path.join(TMP, 'press.json');
const DECK_SERIAL = 'FAKE-XL-0001';
await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.mkdir(STATE2, { recursive: true });
const LONG = 'x'.repeat(501);
await fs.writeFile(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    decks: { [DECK_SERIAL]: { name: 'Deck' } },
    startProfile: 'default',
    profiles: {
      default: {
        name: 'Default',
        layouts: {
          [DECK_SERIAL]: {
            startPage: 'main',
            pages: {
              main: {
                name: 'Main',
                buttons: {
                  0: { label: 'Hello', action: { type: 'twitch.chat', message: 'hello chat' } },
                  1: { label: 'Long', action: { type: 'twitch.chat', message: LONG } },
                  2: { label: 'Empty', action: { type: 'twitch.chat', message: '' } },
                  3: { label: 'Mark', action: { type: 'twitch.marker', description: 'Boss fight' } },
                  4: { label: 'Clip', action: { type: 'twitch.clip', title: 'What a save', duration: 20 } },
                  5: { label: 'Clip plain', action: { type: 'twitch.clip' } },
                  6: { label: 'Info', action: { type: 'twitch.streamInfo', title: 'Ranked grind', category: '33214', categoryName: 'Fortnite' } },
                  7: { label: 'Title only', action: { type: 'twitch.streamInfo', title: 'Just a title' } },
                  8: { label: 'Gone category', action: { type: 'twitch.streamInfo', category: '999', categoryName: 'Deleted game' } },
                },
              },
            },
          },
        },
      },
    },
  }),
);
await fs.writeFile(DECKS_FILE, JSON.stringify([{ model: 'xl', path: '/fake/xl-0', serialNumber: DECK_SERIAL, productName: 'Fake XL' }]));
await fs.writeFile(PRESS_FILE, '{}');
let pressId = 0;
const press = async (index) => {
  await fs.writeFile(PRESS_FILE, JSON.stringify({ id: ++pressId, serial: DECK_SERIAL, index, holdMs: 30 }));
  await sleep(400);
};
const daemonEnv = {
  ...process.env,
  DECKHAND_CONFIG_DIR: CONFIG_DIR,
  DECKHAND_STATE_DIR: STATE2,
  DECKHAND_SOCKET: SOCKET,
  FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
  FAKE_DECKS_FILE: DECKS_FILE,
  FAKE_DECKS_LOG: path.join(TMP, 'opens.log'),
  FAKE_DECKS_PRESS: PRESS_FILE,
};
/** `deckhand <args>` against this daemon: its output and exit code. */
const cli = (args, { onStderr } = {}) => {
  const child = spawn(process.execPath, [path.join(REPO, 'dist/cli.js'), ...args], { env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', child };
  child.stdout.setEncoding('utf8').on('data', (c) => (out.stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => {
    out.stderr += c;
    onStderr?.(out.stderr);
  });
  out.done = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  return out;
};

// A link saved before the daemon starts: Twitch's rule is to validate it at start.
fake.requests.length = 0;
const code0 = await (await fetch(`${fake.url}/oauth2/device`, { method: 'POST', body: new URLSearchParams({ client_id: fake.clientId, scopes: 'user:write:chat' }) })).json();
fake.approve();
await sleep(1100);
const tokens0 = await (await fetch(`${fake.url}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ client_id: fake.clientId, device_code: code0.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })).json();
await fs.writeFile(
  path.join(STATE2, 'credentials.json'),
  JSON.stringify({ twitch: { clientId: fake.clientId, userId: '151766307', login: 'fakestreamer', scopes: tokens0.scope, refreshToken: tokens0.refresh_token, accessToken: tokens0.access_token, expiresAt: Date.now() + 3 * 3600_000 } }),
  { mode: 0o600 },
);
fake.requests.length = 0;

const notes = await startFakeNotifications();
const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')], { env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const output = [];
child.stdout.setEncoding('utf8').on('data', (c) => output.push(c));
child.stderr.setEncoding('utf8').on('data', (c) => output.push(c));
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const ready = await until(async () => {
  if (!(await fs.stat(SOCKET).catch(() => null))) return false;
  try {
    const c = await connect(SOCKET);
    const s = await c.request('status', {});
    c.socket.end();
    return s.ok && s.result.decks.some((d) => d.serial === DECK_SERIAL);
  } catch {
    return false;
  }
}, 10_000);
check('daemon: up on the fake deck', ready);
check('daemon: a saved link is validated at start, and nothing else is asked', await until(() => count('/oauth2/validate') === 1) && fake.requests.length === 1);
const ctl = await connect(SOCKET);
const failedOn = async (key) => (await ctl.request('status', {})).result.decks.find((d) => d.serial === DECK_SERIAL)?.failed?.find((f) => f.key === String(key))?.error ?? null;

const status0 = cli(['twitch']);
await status0.done;
check('cli: `deckhand twitch` says linked, as whom, and what it allows', /link: linked/.test(status0.stdout) && /account: fakestreamer/.test(status0.stdout) && /user:write:chat/.test(status0.stdout));

await press(0);
check('daemon: the Chat message key sends its message, as the linked account', await until(() => fake.chat.at(-1)?.message === 'hello chat'));
check('…and leaves no mark, and notifies nothing', (await failedOn(0)) === null && notes.calls.length === 0);

await press(1);
check('daemon: a message over 500 characters is marked and notified, and nothing is sent', await until(async () => /up to 500 characters/.test((await failedOn(1)) ?? '')) && notes.calls.length === 1 && !fake.chat.some((c) => c.message === LONG));
await press(2);
check('daemon: an empty message is marked, not notified', await until(async () => /no message/.test((await failedOn(2)) ?? '')) && notes.calls.length === 1);

fake.dropChat = { code: 'msg_duplicate', message: 'Your message is identical to the one you sent within the last 30 seconds.' };
await press(0);
check("daemon: a message Twitch did not send is marked with Twitch's reason", await until(async () => /identical/.test((await failedOn(0)) ?? '')));
check('…not notified (nothing for the person to do but wait)', notes.calls.length === 1);
fake.dropChat = null;
await press(0);
check('daemon: the next press that sends clears the mark', await until(async () => (await failedOn(0)) === null));

fake.refuseRefresh = true;
fake.expireAccess();
await press(0);
check('daemon: a refused link: marked and notified, saying to link again', await until(async () => /no longer accepts/.test((await failedOn(0)) ?? '')) && (await until(() => notes.calls.some((n) => /no longer accepts/.test(n.body)))));
check("…and still set up: the key's face is not the not-set-up one", (await ctl.request('twitch.status', {})).result.link === 'refused');
fake.refuseRefresh = false;

const removed = cli(['twitch', 'remove', '--json']);
await removed.done;
check('cli: `deckhand twitch remove`: not linked, and the link ended at Twitch — `revoked` true in its reply', /"link": "not-set-up"/.test(removed.stdout) && /"revoked": true/.test(removed.stdout) && fake.requests.some((q) => q.path === '/oauth2/revoke'));
const notesBefore = notes.calls.length;
const sentBefore = fake.requests.length;
await press(0);
await press(0);
check(
  // The key failed seconds ago (the refused link, above), so both presses count on its one notification: the rule is per key, whatever the message.
  'daemon: two presses while not linked: each notified — counted on the key\'s one notification — never marked, and nothing sent',
  (await until(() => notes.calls.length === notesBefore + 2)) && /Twitch is not linked/.test(notes.calls.at(-1).body) && notes.calls.at(-1).replacesId === notes.calls.at(-2).id && /\(failed \d+ times\)$/.test(notes.calls.at(-1).summary) && fake.requests.length === sentBefore,
);

// `deckhand twitch link`, approved.
const linking1 = cli(['twitch', 'link'], {});
check('cli: `deckhand twitch link` prints the code to approve', await until(() => /twitch\.tv\/activate/.test(linking1.stderr) && /\n    [A-Z0-9]{8}\n/.test(linking1.stderr)));
fake.approve();
check('cli: approved — it says so and exits 0', (await linking1.done) === 0 && /Linked as fakestreamer/.test(linking1.stderr));
await press(0);
check('daemon: linked again, the key sends', await until(() => fake.chat.filter((c) => c.message === 'hello chat').length >= 3));

// Marker, Clip, Stream info.
const notes0 = notes.calls.length;
await press(3);
check('Marker while offline: marked and notified, saying to go live', await until(async () => /need a live stream/.test((await failedOn(3)) ?? '')) && (await until(() => notes.calls.length === notes0 + 1)));
await press(4);
check('Clip while offline: marked and notified, saying to go live', await until(async () => /Clips need a live stream/.test((await failedOn(4)) ?? '')) && (await until(() => notes.calls.length === notes0 + 2)));
fake.live = true;
await press(3);
check('Marker while live: added with its description, and the mark cleared', await until(() => fake.markers.at(-1)?.description === 'Boss fight') && (await until(async () => (await failedOn(3)) === null)));
fake.vodsOff = true;
await press(3);
check('Marker with "Store past broadcasts" off: marked, saying to turn it on', await until(async () => /Store past broadcasts/.test((await failedOn(3)) ?? '')));
fake.vodsOff = false;
await press(4);
check('Clip while live: asked with its title and duration, as the linked account', await until(() => fake.clips.at(-1)?.title === 'What a save' && fake.clips.at(-1)?.duration === '20' && fake.clips.at(-1)?.broadcaster === '151766307'));
check('…202 counts as done: the mark cleared, nothing notified', await until(async () => (await failedOn(4)) === null) && notes.calls.length === notes0 + 3);
await press(5);
check("Clip with nothing set: no title or duration sent — Twitch's defaults", await until(() => fake.clips.length === 2) && fake.clips.at(-1).title === null && fake.clips.at(-1).duration === null);
fake.live = false;
await press(6);
check('Stream info: title and category set together, live or not', await until(() => fake.channel.title === 'Ranked grind' && fake.channel.gameId === '33214') && (await failedOn(6)) === null);
await press(7);
check('Stream info with only a title: the category left as it is', await until(() => fake.channel.title === 'Just a title') && fake.channel.gameId === '33214');
await press(8);
check("Stream info with a category Twitch no longer has: marked with Twitch's reason, nothing changed", await until(async () => /game_id is not valid/.test((await failedOn(8)) ?? '')) && fake.channel.gameId === '33214');
const socketSearch = await ctl.request('twitch.categories', { query: 'league' });
check('socket: twitch.categories answers from Twitch’s search', socketSearch.ok && socketSearch.result.ok && socketSearch.result.items[0]?.name === 'League of Legends');
const emptySearch = await ctl.request('twitch.categories', { query: '   ' });
check('socket: an empty search is refused, not sent', !emptySearch.ok && emptySearch.error?.code === 'bad_request');

// `deckhand twitch link`, stopped with Ctrl+C: the daemon stops asking.
const linking2 = cli(['twitch', 'link']);
await until(() => /Waiting for you/.test(linking2.stderr));
linking2.child.kill('SIGINT');
await linking2.done;
check('cli: Ctrl+C on a link: the daemon cancels it', await until(async () => (await ctl.request('twitch.status', {})).result.linking.state === 'cancelled'));
const pollsThen = count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code');
await sleep(1500);
check('…and stops polling Twitch', count('/oauth2/token', 'urn:ietf:params:oauth:grant-type:device_code') === pollsThen);
check('…and the link it had is untouched', (await ctl.request('twitch.status', {})).result.link === 'linked');
check('daemon: no poll was sooner than Twitch asked', fake.slowDowns === 0);

ctl.socket.end();
child.kill('SIGTERM');
const stopped = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
check('daemon: stops cleanly, the hourly check with it', stopped === 0 || stopped === null);
await notes.stop();
if (failureCount() > 0) console.log(output.join('').split('\n').slice(-40).join('\n'));

await fake.stop();
await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\ntwitch: all checks passed' : `\ntwitch: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
