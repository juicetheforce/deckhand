// Discord in the editor, end to end in real Electron: Settings ›
// Integrations › Discord (Connect, Discord's Authorize window waited on,
// cancelled and answered, the states the mockups do not draw, Remove), and
// the keys — the library rows, the not-set-up face, the pickers.
//
// Driven like check-vts.mjs, on a private bus, against the control harness's
// daemon (the real socket commands and services/discord.ts) and
// scripts/test/fake-discord.mjs — never a real Discord: XDG_RUNTIME_DIR is a
// scratch directory for the daemon side, so a Discord running here is never
// found, and the token endpoint is the fake's. What is checked from outside
// the page: config.json and credentials.json.
//
// Usage: npm run check:discord   (builds first; run `npm run build:ts` at the root after changing src/)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_DISCORD_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-dc-'));
const configDir = path.join(scratch, 'config');
const editorState = path.join(scratch, 'state');
// The daemon's state directory, where credentials.json lives: read when the harness is imported, so set first.
const daemonState = path.join(scratch, 'daemon-state');
const run = path.join(scratch, 'run');
await fs.mkdir(configDir);
await fs.mkdir(run);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_STATE_DIR = daemonState;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const { startFakeDiscord } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-discord.mjs')).href);
const discord = await import(pathToFileURL(path.join(repoRoot, 'dist/services/discord.js')).href);
const electronPath = (await import('electron')).default;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const XL = 'DC-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { action: { type: 'discord.mute' } }, 1: { label: 'Plain' } } } } } },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

const env = {
  ...process.env,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: editorState,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;
// The daemon side only, after the editor's environment is taken: Discord is looked for here.
process.env.XDG_RUNTIME_DIR = run;
const fake = await startFakeDiscord({ socketPath: path.join(run, 'discord-ipc-0') });
process.env.DECKHAND_DISCORD_API_URL = fake.apiUrl;
await fake.quit();

const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const credentials = async () => JSON.parse(await fs.readFile(path.join(daemonState, 'credentials.json'), 'utf8').catch(() => '{}'));
const typeId = (value) =>
  `(() => { const i = document.querySelector('[data-discord-field=client-id]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const section = () =>
  inPage(
    editor,
    'settings',
    `(() => { const s = document.querySelector('#settings-discord'); return s && {
      state: s.dataset.discordSection ?? null,
      status: s.querySelector('[data-discord-status]')?.dataset.discordStatus ?? null,
      statusText: s.querySelector('[data-discord-status]')?.textContent ?? null,
      dot: s.querySelector('[data-discord-status] [data-dot]')?.dataset.dot ?? null,
      message: s.querySelector('[data-discord-message]')?.textContent ?? null,
      messageKind: s.querySelector('[data-discord-message]')?.dataset.discordMessage ?? null,
      approval: s.querySelector('[data-discord-message]')?.dataset.discordApproval ?? null,
      waiting: s.querySelector('[data-discord-approval=waiting]')?.textContent ?? null,
      cancel: s.querySelector('[data-discord=cancel]') !== null,
      field: s.querySelector('[data-discord-field=client-id]')?.value ?? null,
      placeholder: s.querySelector('[data-discord-field=client-id]')?.placeholder ?? null,
      connect: s.querySelector('[data-discord=connect]')?.textContent ?? null,
      connectDisabled: s.querySelector('[data-discord=connect]')?.disabled ?? null,
      hint: s.querySelector('[data-discord=connect]')?.nextElementSibling?.textContent ?? null,
      steps: [...s.querySelectorAll('[data-discord-steps] .sp-step')].map((li) => li.textContent),
      confirm: s.querySelector('[data-discord-confirm]')?.textContent ?? null,
      removable: s.querySelector('[data-discord=remove]') !== null,
      nav: document.querySelector('[data-settings-nav=discord]')?.textContent ?? null,
      navAfterTwitch: document.querySelector('[data-settings-nav=twitch]')?.nextElementSibling?.dataset.settingsNav ?? null,
    }; })()`,
  );
const configJson = async () => JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
const buttonsNow = async () => (await configJson()).profiles.default.layouts[XL].pages.main.buttons;

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);

const editorFace = () =>
  inPage(
    editor,
    'editor',
    `(() => {
      const row = (type) => document.querySelector('.library-entry[data-action-type="' + type + '"]');
      const key0 = document.querySelector('.key[data-key="0"]');
      const callout = document.querySelector('.inspector [data-not-set-up=discord]');
      return {
        group: [...document.querySelectorAll('.library-group')].some((g) => /Discord/.test(g.textContent ?? '')),
        rows: ['discord.mute', 'discord.deafen', 'discord.inputMode', 'discord.join', 'discord.leave', 'discord.userVolume'].map((t) => row(t)?.dataset.notSetUp ?? (row(t) ? 'set-up' : 'missing')),
        rowTitle: row('discord.mute')?.title ?? null,
        keyUnset: key0?.classList.contains('key-unset') ?? null,
        keyBadgeTitle: key0?.querySelector('.key-unset-badge')?.title ?? null,
        callout: callout?.textContent ?? null,
      };
    })()`,
  );

// --- Not set up --------------------------------------------------------------------
await until(async () => (await editorFace()).rows[0] === 'true');
await inPage(editor, 'editor', clickIn('.key[data-key="0"]'));
await until(async () => (await editorFace()).callout !== null);
r.notSetUp = await editorFace();

// --- Settings › Integrations › Discord -------------------------------------------------
await inPage(editor, 'editor', "window.deckhand.openSettings('discord').then(() => true)");
r.settingsOpen = await until(async () => (await stateOf(editor)).settingsOpen);
await until(async () => (await section())?.state != null);
r.opened = await section();
r.focused = await inPage(editor, 'settings', 'document.activeElement?.dataset.discordField ?? null');

// Not an ID: said at once, nothing asked.
await inPage(editor, 'settings', typeId('not a number'));
await inPage(editor, 'settings', clickIn('[data-discord=connect]'));
await sleep(200);
r.badId = await section();

// Discord not running.
await inPage(editor, 'settings', typeId(fake.clientId));
await inPage(editor, 'settings', clickIn('[data-discord=connect]'));
r.notRunning = (await until(async () => (await section())?.approval === 'not-running')) && (await section());

// Discord's window, waited on, then Cancel.
await fake.start();
fake.authorize = 'hang';
await inPage(editor, 'settings', clickIn('[data-discord=connect]'));
r.waiting = (await until(async () => (await section())?.waiting !== null)) && (await section());
r.editorCannotConnect = await inPage(editor, 'editor', `window.deckhand.discordConnect(${JSON.stringify(fake.clientId)}).then((x) => x.ok === false)`);
await inPage(editor, 'settings', clickIn('[data-discord=cancel]'));
r.cancelled = (await until(async () => (await section())?.approval === 'cancelled')) && (await section());
r.savedAfterCancel = (await credentials()).discord ?? null;

// Authorize: connected, as whom. The profile has a Discord key: the daemon wants it.
discord.setWanted(true);
fake.authorize = 'approve';
await inPage(editor, 'settings', clickIn('[data-discord=connect]'));
r.approved = (await until(async () => (await section())?.statusText === 'Connected as riccochet')) && (await section());
const saved = (await credentials()).discord ?? {};
r.pageHasNoToken = !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(saved.accessToken) && !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(saved.refreshToken);
r.setUp = (await until(async () => (await editorFace()).rows.every((x) => x === 'set-up') && (await editorFace()).keyUnset === false)) && (await editorFace());

// --- The pickers: Discord's own lists, by ID, never typed ------------------------------
const picker = (what) =>
  inPage(
    editor,
    'editor',
    `(() => { const ul = document.querySelector('.inspector [data-discord-picker="${what}"]'); return ul && {
      ids: [...ul.querySelectorAll('[data-discord-id]')].map((b) => b.dataset.discordId),
      names: [...ul.querySelectorAll('[data-discord-id] .target-name')].map((n) => n.textContent),
      unavailable: document.querySelector('.inspector [data-discord-list]')?.textContent ?? null,
      typed: document.querySelector('.inspector-section input[type=text], .inspector-section textarea') !== null,
    }; })()`,
  );
const pick = (what, id) => inPage(editor, 'editor', clickIn(`.inspector [data-discord-picker="${what}"] [data-discord-id="${id}"]`));
await inPage(editor, 'editor', clickIn('.key[data-key="2"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="discord.join"]'));
await until(async () => (await picker('server'))?.ids.length > 0);
r.servers = await picker('server');
await pick('server', 'g-1');
await until(async () => (await picker('voice channel'))?.ids.length > 0);
r.channels = await picker('voice channel');
await pick('voice channel', 'c-general');
r.joinSaved = await until(
  async () => JSON.stringify((await buttonsNow())['2']?.action) === JSON.stringify({ type: 'discord.join', guild: 'g-1', guildName: 'Test server', channel: 'c-general', channelName: 'General' }),
);
r.joinAction = (await buttonsNow())['2']?.action ?? null;

await inPage(editor, 'editor', clickIn('.key[data-key="3"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="discord.userVolume"]'));
await until(async () => (await picker('person'))?.unavailable != null);
r.noChannel = await picker('person');
fake.channelId = 'c-general';
await inPage(editor, 'editor', clickIn('.inspector [data-discord-refresh="person"]'));
await until(async () => (await picker('person'))?.ids.length > 0);
r.people = await picker('person');
await pick('person', '692523192819908688');
r.volumeSaved = await until(async () => (await buttonsNow())['3']?.action?.user === '692523192819908688');
r.volumeAction = (await buttonsNow())['3']?.action ?? null;

// --- The states the mockups do not draw ------------------------------------------------
await fake.quit();
r.waitingForDiscord = (await until(async () => (await section())?.statusText === 'Waiting for Discord')) && (await section());
fake.readyDelayMs = 1500;
await fake.start();
discord.retry();
r.connecting = (await until(async () => (await section())?.statusText === 'Connecting…')) && (await section());
r.reconnected = await until(async () => (await section())?.statusText === 'Connected as riccochet', 5000);

// --- Remove -----------------------------------------------------------------------------
await inPage(editor, 'settings', clickIn('[data-discord=remove]'));
r.confirm = (await section()).confirm;
await inPage(editor, 'settings', clickIn('[data-discord=keep]'));
r.kept = (await credentials()).discord !== undefined;
await inPage(editor, 'settings', clickIn('[data-discord=remove]'));
await inPage(editor, 'settings', clickIn('[data-discord=confirm-remove]'));
r.removed = (await until(async () => (await section())?.state === 'not-set-up')) && (await section());
r.savedAfterRemove = (await credentials()).discord ?? null;
r.revoked = fake.revoked.map((x) => x.hint);
r.removedFace = (await until(async () => (await editorFace()).keyUnset === true)) && (await editorFace());
r.keysKept = (await buttonsNow())['0']?.action?.type ?? null;

editor.child.kill();
await until(() => editor.exited !== null, 10_000);
discord.setWanted(false);

check('not set up: the library has a Discord group of six, each marked, saying how to set it up', () => {
  assert.equal(r.notSetUp.group, true);
  assert.deepEqual(r.notSetUp.rows, ['true', 'true', 'true', 'true', 'true', 'true']);
  assert.match(r.notSetUp.rowTitle, /^Discord is not set up\. Its keys do nothing until it is connected in Settings › Integrations\./);
});
check('not set up: the key is drawn dimmed with the not-set-up badge naming Discord, and the inspector says so', () => {
  assert.equal(r.notSetUp.keyUnset, true);
  assert.match(r.notSetUp.keyBadgeTitle, /^Discord is not set up/);
  assert.match(r.notSetUp.callout, /Discord is not set up\./);
});
check('Settings: Discord after Twitch, not set up, the field empty with the copy sheet’s placeholder and focused, the four steps open', () => {
  assert.equal(r.opened.nav, 'Discord');
  assert.equal(r.opened.navAfterTwitch, 'discord');
  assert.equal(r.opened.statusText, 'Not set up');
  assert.equal(r.opened.field, '');
  assert.equal(r.opened.placeholder, 'From the Developer Portal');
  assert.equal(r.focused, 'client-id');
  assert.equal(r.opened.connect, 'Connect');
  assert.equal(r.opened.hint, 'Connect opens Discord’s Authorize prompt.');
  assert.deepEqual(r.opened.steps, [
    '1In Discord’s Developer Portal, create an application.',
    '2Under OAuth2, turn on Public Client.',
    '3Add http://127.0.0.1 as a redirect.',
    '4Copy the Application ID into the field above.',
  ]);
  assert.equal(r.opened.removable, false);
});
check('an ID that is not one: said at once', () => assert.match(r.badId.message ?? '', /Application ID is a long number/));
check('Discord not running: says so, and saves nothing', () => {
  assert.ok(r.notRunning, 'never not-running');
  assert.match(r.notRunning.message, /Discord is not running/);
  assert.equal(r.notRunning.messageKind, 'error');
});
check('waiting: the copy sheet’s status and banner, with Cancel; Connect disabled; the editor window cannot connect', () => {
  assert.ok(r.waiting, 'never waiting');
  assert.equal(r.waiting.statusText, 'Waiting for you to authorize');
  assert.match(r.waiting.waiting, /^Approve Deckhand in Discord’s Authorize window\.Cancel$/);
  assert.equal(r.waiting.cancel, true);
  assert.equal(r.waiting.connectDisabled, true);
  assert.equal(r.editorCannotConnect, true);
});
check('Cancel: cancelled, nothing saved', () => {
  assert.ok(r.cancelled, 'never cancelled');
  assert.equal(r.cancelled.messageKind, 'warn');
  assert.equal(r.savedAfterCancel, null);
});
check('authorized: "Connected as riccochet", Remove…, Connect again; no token on the page', () => {
  assert.ok(r.approved, 'never connected');
  assert.equal(r.approved.dot, 'ok');
  assert.equal(r.approved.removable, true);
  assert.equal(r.approved.connect, 'Connect again');
  assert.equal(r.pageHasNoToken, true);
});
check('authorized: the library and the key come back by themselves', () => {
  assert.ok(r.setUp, 'not ungated');
  assert.equal(r.setUp.callout, null);
});
check("Join channel: Discord's servers, then that server's voice channels, by ID; a pick writes both with their names; nothing typed", () => {
  assert.deepEqual(r.servers.ids, ['g-1', 'g-2']);
  assert.equal(r.servers.typed, false);
  assert.deepEqual(r.channels.ids, ['c-general', 'c-empty']);
  assert.equal(r.joinSaved, true, JSON.stringify(r.joinAction));
});
check('User volume: in no channel, says to join one; then the others in it, by name; a pick writes the user by ID', () => {
  assert.match(r.noChannel.unavailable ?? '', /Join a voice channel/);
  assert.deepEqual(r.people.names, ['Theo']);
  assert.deepEqual(r.volumeAction, { type: 'discord.userVolume', user: '692523192819908688', userName: 'Theo' });
});
check('set up, Discord quit: "Waiting for Discord", as OBS’s page says', () => {
  assert.ok(r.waitingForDiscord, 'never waiting');
  assert.equal(r.waitingForDiscord.dot, 'waiting');
});
check('during a slow handshake: "Connecting…", then connected', () => {
  assert.ok(r.connecting, 'never connecting');
  assert.equal(r.connecting.dot, 'waiting');
  assert.equal(r.reconnected, true);
});
check('Remove: asks first, saying it revokes at Discord; Keep keeps it', () => {
  assert.match(r.confirm ?? '', /Every Discord key stops working.*revoked at Discord/);
  assert.equal(r.kept, true);
});
check('removed: revoked at Discord, forgotten, the key back to not set up, no key touched', () => {
  assert.ok(r.removed, 'never not set up');
  assert.match(r.removed.message ?? '', /^Removed, and revoked at Discord\./);
  assert.equal(r.savedAfterRemove, null);
  assert.deepEqual(r.revoked, ['refresh_token', 'access_token']);
  assert.equal(r.removedFace?.keyUnset, true);
  assert.equal(r.keysKept, 'discord.mute');
});

stopWatching();
await daemon.stop();
await fake.stop();
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
