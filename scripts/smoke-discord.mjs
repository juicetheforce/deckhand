/**
 * Offline test for Discord: the IPC client, the connection's lifecycle,
 * authorizing with no secret, refreshing, revoking, and what keys show and
 * do — against scripts/test/fake-discord.mjs, never a real Discord.
 *
 * **Never the real Discord's socket.** XDG_RUNTIME_DIR is a scratch
 * directory here, so a Discord running on this machine is never found, and
 * the token endpoint is the fake's (DECKHAND_DISCORD_API_URL).
 *
 * Two halves, as smoke-vts.mjs has: the client and services/discord.ts in
 * this process; then the real `dist/index.js` in a child with a fake deck —
 * **Discord is connected while the profile has a Discord key on any page**,
 * not only a shown one, and let go when the profile has none; a press while
 * the handshake runs is refused at once, never marked — wiring that lives
 * in src/index.ts. It runs itself on a private D-Bus session, for the fake
 * notification service.
 *
 *   npm run build:ts && node scripts/smoke-discord.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DECKHAND_SMOKE_PRIVATE_BUS) {
  const busConfig = path.join(os.tmpdir(), `deckhand-smoke-discord-bus-${process.pid}.conf`);
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

// Set before any import of dist/: the state directory is read when dist/backups.js is first imported.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
process.env.TMPDIR = TMP;
const STATE_DIR = path.join(TMP, 'state');
process.env.DECKHAND_STATE_DIR = STATE_DIR;
const RUN = path.join(TMP, 'run');
await fs.mkdir(RUN, { recursive: true });
process.env.XDG_RUNTIME_DIR = RUN;
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');

const { REPO, check, failureCount, sleep, connect } = await import('./test/control-harness.mjs');
const { startFakeDiscord } = await import('./test/fake-discord.mjs');
const { startFakeNotifications } = await import('./test/fake-notifications.mjs');
const { iconStateOf, describeAction, runActionOrThrow } = await import(path.join(REPO, 'dist/actions/index.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));
const discord = await import(path.join(REPO, 'dist/services/discord.js'));
const { socketCandidates, findSocket, DiscordClient } = await import(path.join(REPO, 'dist/services/discord-client.js'));
const { NotSetUp, StillConnecting, ActionNeeded } = await import(path.join(REPO, 'dist/action-error.js'));

const until = async (condition, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(25);
  }
  return false;
};
const credentials = async () => JSON.parse(await fs.readFile(path.join(STATE_DIR, 'credentials.json'), 'utf8').catch(() => '{}'));
const thrown = async (run) => {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
};

console.log('\nwhere Discord is looked for');
const candidates = socketCandidates('/run/user/1000');
check('the standard place first: $XDG_RUNTIME_DIR/discord-ipc-0', candidates[0] === '/run/user/1000/discord-ipc-0');
check("then the Flathub Flatpak's relay", candidates[10] === '/run/user/1000/app/com.discordapp.Discord/discord-ipc-0');
check("then the Flatpak's own runtime directory", candidates[20] === '/run/user/1000/.flatpak/com.discordapp.Discord/xdg-run/discord-ipc-0');
check('nothing running: no socket found', (await findSocket()) === null);
// The fake listens where the Flatpak's relay is: the standard place stays empty.
await fs.mkdir(path.join(RUN, 'app', 'com.discordapp.Discord'), { recursive: true });
const SOCKET = path.join(RUN, 'app', 'com.discordapp.Discord', 'discord-ipc-0');
const fake = await startFakeDiscord({ socketPath: SOCKET });
process.env.DECKHAND_DISCORD_API_URL = fake.apiUrl;
check("found at the Flatpak's path when it is the only one", (await findSocket()) === SOCKET);
const plainFile = path.join(RUN, 'discord-ipc-0');
await fs.writeFile(plainFile, '');
check('a file that is not a socket is passed over', (await findSocket()) === SOCKET);
await fs.rm(plainFile);
// What the Flatpak leaves in its own runtime directory when Discord quits: a socket file nobody listens on.
const stalePath = path.join(RUN, 'discord-ipc-1');
spawnSync('python3', ['-I', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', stalePath]);
check('a socket file left behind (nothing listening) is passed over', (await fs.stat(stalePath)).isSocket() && (await findSocket()) === SOCKET);
await fake.quit();
check('…and with Discord gone, only it left: not running', (await findSocket()) === null);
await fake.start();

console.log('\nthe client');
const refusedClient = await thrown(() => DiscordClient.connect({ path: SOCKET, clientId: '1111', onEvent() {}, onClose() {} }));
check('an application ID Discord does not know: invalid-client (CLOSE 4000)', refusedClient?.kind === 'invalid-client');
fake.readyDelayMs = 300;
const slow = await thrown(() => DiscordClient.connect({ path: SOCKET, clientId: fake.clientId, handshakeMs: 100, onEvent() {}, onClose() {} }));
check('no READY before the deadline: slow', slow?.kind === 'slow');
const t0 = Date.now();
const c = await DiscordClient.connect({ path: SOCKET, clientId: fake.clientId, onEvent() {}, onClose() {} });
check('a slow READY is waited for (the deadline is long)', c.isOpen && Date.now() - t0 >= 280);
const unauth = await thrown(() => c.command('GET_VOICE_SETTINGS'));
check("an ERROR answer rejects with Discord's code", unauth?.kind === 'answer' && unauth.code === 4006);
c.close();
fake.readyDelayMs = 0;
check('nothing at the path: unavailable', (await thrown(() => DiscordClient.connect({ path: path.join(RUN, 'nothing'), clientId: fake.clientId, onEvent() {}, onClose() {} })))?.kind === 'unavailable');

console.log('\nnot set up');
const MUTE = { type: 'discord.mute' };
const DEAF = { type: 'discord.deafen' };
const MODE = { type: 'discord.inputMode' };
const VOL = { type: 'discord.userVolume', user: '692523192819908688', userName: 'Theo', delta: 10, showLevel: true };
const JOIN = { type: 'discord.join', guild: 'g-1', channel: 'c-general', guildName: 'Test server', channelName: 'General' };
const LEAVE = { type: 'discord.leave' };
const ctx = { deck: {}, key: '0', source: 'deck', invalidateByType() {}, log() {}, switchProfile: async () => undefined };
discord.setWanted(true, true);
check('wanted with nothing saved: not set up, and nothing connects', await until(() => discord.cachedState().connection === 'not-set-up') && fake.handshakes === 2);
check('every Discord key is drawn not set up', (await describeAction(ctx, MUTE))?.unset === true && (await describeAction(ctx, JOIN))?.unset === true);
const notSetUpPress = await thrown(() => runActionOrThrow(ctx, MUTE));
check('a press says where to set it up, and is never marked (NotSetUp)', notSetUpPress instanceof NotSetUp && /Settings › Integrations › Discord/.test(notSetUpPress.message));

console.log('\nConnect: authorizing');
fake.authorize = 'missing-redirect';
check('Connect starts', (await discord.requestAccess(fake.clientId)) === true);
check('no redirect registered: says to add http://127.0.0.1', await until(() => discord.cachedState().approval.state === 'failed' && /http:\/\/127\.0\.0\.1/.test(discord.cachedState().approval.message)));
fake.authorize = 'deny';
await discord.requestAccess(fake.clientId);
check('Cancel in Discord’s window: denied', await until(() => discord.cachedState().approval.state === 'denied'));
await discord.requestAccess('1111');
check('an unknown Application ID: says to copy it again', await until(() => discord.cachedState().approval.state === 'failed' && /does not know that Application ID/.test(discord.cachedState().approval.message)));
fake.authorize = 'hang';
await discord.requestAccess(fake.clientId);
check('waiting: the copy sheet’s banner', await until(() => discord.cachedState().approval.state === 'waiting' && discord.cachedState().approval.message === 'Approve Deckhand in Discord’s Authorize window.'));
check('a second Connect while one waits is not started', (await discord.requestAccess(fake.clientId)) === false);
const openBeforeCancel = fake.open;
discord.cancelAccess();
check('Cancel: cancelled, and the connection let go', await until(() => discord.cachedState().approval.state === 'cancelled' && fake.open === openBeforeCancel - 1));
check('nothing saved by any of those', (await credentials()).discord === undefined && (await discord.status()).setUp === false);

fake.authorize = 'approve';
const handshakesBefore = fake.handshakes;
await discord.requestAccess(fake.clientId);
check('Authorize: approved', await until(() => discord.cachedState().approval.state === 'approved'));
const saved = (await credentials()).discord;
check('saved: the application ID, both tokens, seven days, the scopes, the account’s name', saved?.clientId === fake.clientId && saved.accessToken === 'access-1' && saved.refreshToken === 'refresh-1' && saved.expiresAt > Date.now() + 6.9 * 864e5 && saved.scopes.includes('rpc.voice.write') && saved.userName === 'riccochet');
const exchange = fake.tokenRequests.find((r) => r.grant === 'authorization_code');
check('the code exchanged with PKCE and the redirect, and no secret anywhere', exchange?.redirect === 'http://127.0.0.1' && fake.secretsSeen === 0);
check('the credentials file is owner-only', ((await fs.stat(path.join(STATE_DIR, 'credentials.json'))).mode & 0o777) === 0o600);
check('wanted: the authorizing connection is the one kept — no second handshake', await until(() => discord.cachedState().connection === 'connected') && fake.handshakes === handshakesBefore + 1);
const status = await discord.status();
check('status: set up, the application, the name — and no token', status.setUp && status.clientId === fake.clientId && status.userName === 'riccochet' && !JSON.stringify(status).includes('access-') && !JSON.stringify(status).includes('refresh-'));

console.log('\nkeys');
const s0 = discord.cachedState();
check('connected: mute, deafen and the mode read at once', s0.mute === false && s0.deaf === false && s0.mode === 'VOICE_ACTIVITY');
check('faces: live mic, hearing, voice activity', defaultIconFor(MUTE, iconStateOf(MUTE)) === 'discord-mute' && defaultIconFor(DEAF, iconStateOf(DEAF)) === 'discord-deafen' && defaultIconFor(MODE, iconStateOf(MODE)) === 'discord-voice-activity');
check('no badge once connected', (await describeAction(ctx, MUTE)) === null);
await runActionOrThrow(ctx, MUTE);
check('Mute: muted in Discord, and the face follows', fake.voice.mute === true && (await until(() => defaultIconFor(MUTE, iconStateOf(MUTE)) === 'discord-muted')));
// Own icons for each state (src/actions/state-icon.ts).
check('muted, a Mute key with its own active icon draws it', (await describeAction(ctx, { ...MUTE, iconActive: '~/m.png' }))?.icon === '~/m.png');
check('…and one with none adds nothing: the built-in muted face, or its Default icon unchanged', (await describeAction(ctx, MUTE)) === null);
fake.setVoice({ mute: false });
check('unmuted in Discord itself: the face follows its event', await until(() => defaultIconFor(MUTE, iconStateOf(MUTE)) === 'discord-mute'));
await runActionOrThrow(ctx, DEAF);
check('Deafen: deafened (Discord mutes with it)', fake.voice.deaf === true && (await until(() => defaultIconFor(DEAF, iconStateOf(DEAF)) === 'discord-deafened' && discord.cachedState().mute === true)));
check('deafened, a Deafen key\'s own active icon', (await describeAction(ctx, { ...DEAF, iconActive: '~/d.png' }))?.icon === '~/d.png');
await runActionOrThrow(ctx, DEAF);
await runActionOrThrow(ctx, MODE);
const modeSet = fake.commands.filter((x) => x.cmd === 'SET_VOICE_SETTINGS' && x.args.mode).at(-1);
check('Input mode: push-to-talk, the type alone sent, the rest of the mode kept', fake.voice.mode.type === 'PUSH_TO_TALK' && JSON.stringify(modeSet.args) === '{"mode":{"type":"PUSH_TO_TALK"}}' && fake.voice.mode.threshold === -60);
check('the face: push-to-talk', await until(() => defaultIconFor(MODE, iconStateOf(MODE)) === 'discord-push-to-talk'));
check('on push-to-talk — its active state; voice activity is its default — an Input mode key\'s own active icon', (await describeAction(ctx, { ...MODE, iconActive: '~/ptt.png' }))?.icon === '~/ptt.png');
await runActionOrThrow(ctx, MODE);
check('and back to voice activity', fake.voice.mode.type === 'VOICE_ACTIVITY');

const volNoChannel = await thrown(() => runActionOrThrow(ctx, VOL));
check('User volume in no channel: says to join one, nothing sent', volNoChannel instanceof ActionNeeded && /not in a voice channel/.test(volNoChannel.message) && !fake.commands.some((x) => x.cmd === 'SET_USER_VOICE_SETTINGS'));
await runActionOrThrow(ctx, JOIN);
const joinCmd = fake.commands.find((x) => x.cmd === 'SELECT_VOICE_CHANNEL');
check('Join: the channel, with force', fake.channelId === 'c-general' && joinCmd.args.force === true);
check('the join brought no event, yet the channel is known from the reply', discord.cachedState().channelId === 'c-general');
check('…and its people, from subscribing to it (not you)', await until(() => discord.cachedState().users['692523192819908688']?.volume === 100) && !discord.cachedState().users[fake.selfId]);
const joins = fake.commands.filter((x) => x.cmd === 'SELECT_VOICE_CHANNEL').length;
await runActionOrThrow(ctx, JOIN);
check('Join again while in it: nothing sent', fake.commands.filter((x) => x.cmd === 'SELECT_VOICE_CHANNEL').length === joins);
check('User volume face: no level until shown… then 100%, as the level, never the label', (await describeAction(ctx, { ...VOL, showLevel: false })) === null && (await describeAction(ctx, VOL))?.level === '100%' && (await describeAction(ctx, VOL))?.label === undefined);
await runActionOrThrow(ctx, VOL);
check('User volume +10: 110, only what you hear', fake.channels['c-general'].people[0].volume === 110);
check('the level from the event: 110%', await until(async () => (await describeAction(ctx, VOL))?.level === '110%'));
for (let i = 0; i < 12; i++) await runActionOrThrow(ctx, VOL);
check('never past 200', fake.channels['c-general'].people[0].volume === 200);
await runActionOrThrow(ctx, { ...VOL, delta: -250 });
check('never below 0', fake.channels['c-general'].people[0].volume === 0);
fake.channels['c-general'].people[0].volume = 100;
const notThere = await thrown(() => runActionOrThrow(ctx, { ...VOL, user: '999', userName: 'Sam' }));
check('someone not in your channel: marked, saying so — not notified', notThere instanceof Error && !(notThere instanceof ActionNeeded) && /Sam is not in your voice channel/.test(notThere.message));
await runActionOrThrow(ctx, LEAVE);
check('Leave: out of the channel, from its event', fake.channelId === null && (await until(() => discord.cachedState().channelId === null)));
const leaves = fake.commands.filter((x) => x.cmd === 'SELECT_VOICE_CHANNEL').length;
await runActionOrThrow(ctx, LEAVE);
check('Leave in no channel: nothing sent', fake.commands.filter((x) => x.cmd === 'SELECT_VOICE_CHANNEL').length === leaves);
const gone = await thrown(() => runActionOrThrow(ctx, { ...JOIN, channel: 'c-deleted', channelName: 'Old room' }));
check('a channel Discord no longer has: says to choose it again', gone instanceof ActionNeeded && /Old room is not in Discord any more/.test(gone.message));

console.log('\npickers');
const guilds = await discord.list('guilds');
check('servers', guilds.ok && guilds.items.map((g) => g.name).join() === 'Test server,Other');
const channels = await discord.list('channels', 'g-1');
check('a server’s voice channels only', channels.ok && channels.items.map((g) => g.id).join() === 'c-general,c-empty');
const noOne = await discord.list('users');
check('people: in no channel, says to join one', noOne.ok === false && noOne.reason === 'no-channel');
fake.channelId = 'c-general';
const people = await discord.list('users');
check('people: the others in your channel, by their name there', people.ok && people.items.length === 1 && people.items[0].name === 'Theo');
fake.channelId = null;

console.log('\nDiscord quits, and comes back');
await fake.quit();
check('the connection goes: unavailable', await until(() => discord.cachedState().connection === 'unavailable'));
check('faces: nothing live known, no badge', discord.cachedState().mute === null && (await describeAction(ctx, MUTE)) === null);
const notRunning = await thrown(() => runActionOrThrow(ctx, MUTE));
// The stale file from above is still there: a press must not take it for Discord.
check('a press: Discord is not running, notified', notRunning instanceof ActionNeeded && !(notRunning instanceof NotSetUp) && /not running/.test(notRunning.message));
// A picker during a handshake slower than the editor waits for any reply (10 s): it answers first.
fake.readyDelayMs = 9000;
await fake.start();
const listAt = Date.now();
const slowList = await discord.list('guilds');
const listMs = Date.now() - listAt;
check('a picker during a very slow handshake answers within 8 s, saying to ask again', slowList.ok === false && slowList.reason === 'connecting' && listMs > 7500 && listMs < 9500);
check('…and the connection carries on, wanted, and arrives', await until(() => discord.cachedState().connection === 'connected', 4000));
await fake.quit();
await until(() => discord.cachedState().connection === 'unavailable');
await fake.start();
fake.readyDelayMs = 600;
discord.retry();
check('the 60-second scan’s retry: connecting while the handshake runs', await until(() => discord.cachedState().connection === 'connecting'));
check('every key shows it is connecting, not dimmed', (await describeAction(ctx, MUTE))?.connecting === true && (await describeAction(ctx, MUTE))?.unset === undefined);
const pressedAt = Date.now();
const early = await thrown(() => runActionOrThrow(ctx, MUTE));
check('a press then is refused at once, never waiting on the handshake', early instanceof StillConnecting && Date.now() - pressedAt < 300 && /still connecting/.test(early.message));
check('…and is never marked (it is a NotSetUp)', early instanceof NotSetUp);
check('connected once Discord answers', await until(() => discord.cachedState().connection === 'connected', 3000));
fake.readyDelayMs = 0;

console.log('\ntokens');
const before = await credentials();
await fs.writeFile(path.join(STATE_DIR, 'credentials.json'), JSON.stringify({ ...before, discord: { ...before.discord, expiresAt: Date.now() + 3600_000 } }), { mode: 0o600 });
discord.setWanted(false);
check('no Discord key in the profile: let go', await until(() => fake.open === 0 && discord.cachedState().connection === 'idle'));
discord.setWanted(true, true);
check('near its end, the token is refreshed when connecting — the new pair saved first', await until(async () => discord.cachedState().connection === 'connected' && (await credentials()).discord.refreshToken !== before.discord.refreshToken));
const refreshCall = fake.tokenRequests.filter((r) => r.grant === 'refresh_token').at(-1);
check('…with the old refresh token, and no secret', refreshCall?.refreshToken === before.discord.refreshToken && fake.secretsSeen === 0);
// Revoked behind Deckhand's back (Discord's Authorized Apps): AUTHENTICATE refused, and the refresh too.
discord.setWanted(false);
await until(() => fake.open === 0);
fake.accessTokens.clear();
fake.refreshTokens.clear();
discord.setWanted(true, false);
check('revoked in Discord: refused', await until(() => discord.cachedState().connection === 'refused'));
const refusedPress = await thrown(() => runActionOrThrow(ctx, MUTE));
check('a press says to Connect again, notified', refusedPress instanceof ActionNeeded && /Connect again/.test(refusedPress.message));
const handshakesRefused = fake.handshakes;
discord.retry();
await sleep(200);
check('the scan never retries a refused one', fake.handshakes === handshakesRefused);
await discord.requestAccess(fake.clientId);
check('Connect again: connected', await until(() => discord.cachedState().connection === 'connected'));

console.log('\nRemove');
const lastSaved = (await credentials()).discord;
const revokedReply = await discord.remove();
check('Remove: revoked at Discord, refresh token and access token, no secret', revokedReply === true && fake.revoked.map((r) => `${r.hint}:${r.token}`).join() === `refresh_token:${lastSaved.refreshToken},access_token:${lastSaved.accessToken}` && fake.secretsSeen === 0);
check('forgotten: not set up, nothing in the file', (await credentials()).discord === undefined && (await until(() => discord.cachedState().connection === 'not-set-up')));
check('Remove with nothing saved: null', (await discord.remove()) === null);
discord.setWanted(false);
await fake.stop();

console.log('\nthe daemon');
// A second fake, for the child: a fresh state directory, and Discord's socket in the standard place.
const STATE2 = path.join(TMP, 'state2');
await fs.mkdir(STATE2, { recursive: true });
const RUN2 = path.join(TMP, 'run2');
await fs.mkdir(RUN2, { recursive: true });
const fake2 = await startFakeDiscord({ socketPath: path.join(RUN2, 'discord-ipc-0') });
const tokens = fake2.issue();
await fs.writeFile(
  path.join(STATE2, 'credentials.json'),
  JSON.stringify({ discord: { clientId: fake2.clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + 6e8, scopes: ['rpc'], userName: 'riccochet' } }),
  { mode: 0o600 },
);
const CONFIG_DIR = path.join(TMP, 'config');
await fs.mkdir(CONFIG_DIR, { recursive: true });
const DECKS_FILE = path.join(TMP, 'decks.json');
const DECK_SERIAL = 'FAKEXL0001';
await fs.writeFile(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    startProfile: 'voice',
    profiles: {
      voice: {
        layouts: {
          [DECK_SERIAL]: {
            startPage: 'main',
            pages: {
              // The shown page has no Discord key: another page does.
              main: { name: 'Main', buttons: { 0: { label: 'Plain' }, 1: { action: { type: 'profile', to: 'game' } } } },
              chat: { name: 'Chat', buttons: { 0: { action: MUTE } } },
            },
          },
        },
      },
      game: { layouts: { [DECK_SERIAL]: { pages: { main: { buttons: { 0: { action: { type: 'profile', to: 'voice' } } } } } } } },
    },
  }) + '\n',
);
await fs.writeFile(DECKS_FILE, JSON.stringify([{ model: 'xl', path: '/fake/xl-0', serialNumber: DECK_SERIAL, productName: 'Fake XL' }]));
const PRESS_FILE = path.join(TMP, 'press.json');
await fs.writeFile(PRESS_FILE, '{}');
let pressId = 0;
const pressInChild = async (index, holdMs = 30) => {
  await fs.writeFile(PRESS_FILE, JSON.stringify({ id: ++pressId, serial: DECK_SERIAL, index, holdMs }));
  await sleep(holdMs + 150);
};
const notes = await startFakeNotifications();
const CONTROL = path.join(TMP, 'deckhand.sock');
const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test/fake-decks.mjs'), path.join(REPO, 'dist/index.js')], {
  env: {
    ...process.env,
    XDG_RUNTIME_DIR: RUN2,
    DECKHAND_DISCORD_API_URL: fake2.apiUrl,
    DECKHAND_CONFIG_DIR: CONFIG_DIR,
    DECKHAND_STATE_DIR: STATE2,
    DECKHAND_SOCKET: CONTROL,
    FAKE_INPUT_LOG: path.join(TMP, 'input.log'),
    FAKE_DECKS_FILE: DECKS_FILE,
    FAKE_DECKS_LOG: path.join(TMP, 'opens.log'),
    FAKE_DECKS_PRESS: PRESS_FILE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => output.push(chunk));
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const ready = await until(async () => {
  if (!(await fs.stat(CONTROL).catch(() => null))) return false;
  try {
    const probe = await connect(CONTROL);
    const s = await probe.request('status', {});
    probe.socket.end();
    return s.ok && s.result.decks.some((d) => d.serial === DECK_SERIAL);
  } catch {
    return false;
  }
}, 10_000);
check('the daemon came up on the fake deck', ready);
const ctl = await connect(CONTROL);
const discordStatus = async () => (await ctl.request('discord.status', {})).result;
check('a Discord key on a page not shown: connected all the same (the Discord exception)', await until(async () => (await discordStatus()).connection === 'connected' && fake2.open === 1));
check('discord.status over the socket: set up, as whom — no token', await until(async () => {
  const s = await discordStatus();
  return s.setUp && s.userName === 'riccochet' && !JSON.stringify(s).includes(tokens.access_token);
}));
await ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'page', to: 'chat' } });
await pressInChild(0);
check('a press on the deck mutes in Discord, unmarked', await until(() => fake2.voice.mute === true));
await pressInChild(1);
await ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'profile', to: 'game' } });
check('a profile with no Discord key: let go', await until(async () => fake2.open === 0 && (await discordStatus()).connection === 'idle'));
// Slow, as Discord can be: back to the profile, and press during the handshake.
fake2.readyDelayMs = 1500;
await ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'profile', to: 'voice' } });
check('back to it: connecting', await until(async () => (await discordStatus()).connection === 'connecting'));
await ctl.request('action.run', { serial: DECK_SERIAL, action: { type: 'page', to: 'chat' } });
const notesBefore = notes.calls.length;
await pressInChild(0);
check('a press while connecting: notified that Discord is still connecting', await until(() => notes.calls.length === notesBefore + 1 && /still connecting/.test(notes.calls.at(-1)?.body ?? '')));
const failed = (await ctl.request('status', {})).result.decks.find((d) => d.serial === DECK_SERIAL)?.failed ?? [];
check('…and the key is not marked', failed.length === 0);
check('then connected', await until(async () => (await discordStatus()).connection === 'connected', 4000));
const listed = await ctl.request('discord.list', { kind: 'guilds' });
check('discord.list over the socket', listed.ok && listed.result.ok && listed.result.items.length === 2);
const badConnect = await ctl.request('discord.connect', { clientId: 'not a number' });
check('discord.connect refuses an ID that is not one', !badConnect.ok);
const removed = await ctl.request('discord.remove', {});
check('discord.remove: revoked, not set up', removed.ok && removed.result.revoked === true && removed.result.setUp === false);

ctl.socket.end();
child.kill('SIGTERM');
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
check('daemon: stops cleanly', code === 0 || code === null);
await fake2.stop();
await notes.stop();
if (failureCount() > 0) console.log(output.join('').split('\n').slice(-40).join('\n'));

await fs.rm(TMP, { recursive: true, force: true });
const failures = failureCount();
console.log(failures === 0 ? '\ndiscord: all checks passed' : `\ndiscord: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
