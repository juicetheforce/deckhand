/**
 * Offline test for Twitch (scope §7, "Streaming integrations"): linking by
 * device code, the link's tokens and their refresh, the hourly check, and
 * the keys' requests — against scripts/test/fake-twitch.mjs, never the real
 * Twitch (DECKHAND_TWITCH_ID_URL and DECKHAND_TWITCH_API_URL point at it).
 *
 * The fake does what the real Twitch did in the probe, so the landmines are
 * tested, not assumed: **sending a replaced refresh token ends the whole
 * link**, so one refresh at a time; a refused refresh keeps the link and
 * the hourly check recovers it; polling never sooner than Twitch's interval.
 *
 *   npm run build:ts && node scripts/smoke-twitch.mjs
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The state directory is read when dist/backups.js is first imported, so it is set before any import of dist/.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
process.env.DECKHAND_STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');

const { REPO, check, failureCount, sleep } = await import('./test/control-harness.mjs');
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

// --- Refused, and recovering (Ryan, scope §7) ------------------------------------

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
await twitch.remove();
check('Remove: not set up, nothing saved', twitch.status().setUp === false && (await credentials.twitchCredentials()) === null);
check('…and the link is ended at Twitch, by its refresh token', count('/oauth2/revoke') === revokesBefore + 1 && fake.requests.at(-1).body.token === newLink.refreshToken && fake.linksAlive() === 1);
check('after Remove, a press is NotSetUp again', (await rejection(say('gone'))) instanceof NotSetUp);

check('no poll in this run was sooner than Twitch asked: never answered slow_down', fake.slowDowns === 0);

twitch.stop();
await fake.stop();
await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\ntwitch: all checks passed' : `\ntwitch: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
