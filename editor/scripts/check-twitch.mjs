// Twitch in the editor, end to end in real Electron: Settings ›
// Integrations › Twitch (Link, the code, Open twitch.tv/activate, Cancel,
// Remove), the library's Twitch rows gated while not linked, and the forms —
// the Stream info key's category picked from Twitch's own search.
//
// Driven like check-vts.mjs, on a private bus, against the control harness's
// daemon (the real socket commands and services/twitch.ts) and
// scripts/test/fake-twitch.mjs — never the real Twitch:
// DECKHAND_TWITCH_ID_URL and DECKHAND_TWITCH_API_URL point at the fake.
// Nothing is opened in a browser: the editor writes the URL it would open to
// DECKHAND_CHECK_OPEN_LOG. What is checked from outside the page:
// config.json, credentials.json, and the fake's requests.
//
// Usage: npm run check:twitch   (builds first; run `npm run build:ts` at the root after changing src/)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_TWITCH_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-twitch-'));
const configDir = path.join(scratch, 'config');
const editorState = path.join(scratch, 'state');
const daemonState = path.join(scratch, 'daemon-state');
const openLog = path.join(scratch, 'opened.log');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_STATE_DIR = daemonState;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { startFakeTwitch } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/fake-twitch.mjs')).href);
const fake = await startFakeTwitch({ interval: 1 });
process.env.DECKHAND_TWITCH_ID_URL = `${fake.url}/oauth2`;
process.env.DECKHAND_TWITCH_API_URL = `${fake.url}/helix`;
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
const twitch = await import(pathToFileURL(path.join(repoRoot, 'dist/services/twitch.js')).href);
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

const XL = 'TWITCH-XL';
const CONFIG = {
  decks: { [XL]: { name: 'Deck XL' } },
  profiles: {
    default: {
      name: 'Default',
      layouts: { [XL]: { startPage: 'main', pages: { main: { name: 'Main', buttons: { 0: { action: { type: 'twitch.chat', message: 'hi' } }, 1: { label: 'Plain' } } } } } },
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
  DECKHAND_CHECK_OPEN_LOG: openLog,
};
delete env.ELECTRON_RUN_AS_NODE;

const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
/** Type into a field as a person would: focus, the value, an input event — and leave it, when `leave`. */
const typeInto = (selector, value, leave = false) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)});
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    ${leave ? 'el.blur();' : ''}
    return true; })()`;
const credentials = async () => JSON.parse(await fs.readFile(path.join(daemonState, 'credentials.json'), 'utf8').catch(() => '{}'));
const configJson = async () => JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
const buttonsNow = async () => (await configJson()).profiles.default.layouts[XL].pages.main.buttons;
const polls = () => fake.requests.filter((q) => q.body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code').length;
const TYPES = ['twitch.marker', 'twitch.clip', 'twitch.chat', 'twitch.streamInfo'];

const section = () =>
  inPage(
    editor,
    'settings',
    `(() => { const s = document.querySelector('#settings-twitch'); return s && {
      state: s.dataset.twitchSection ?? null,
      statusText: s.querySelector('[data-twitch-status]')?.textContent ?? null,
      allows: s.querySelector('[data-twitch-allows]')?.textContent ?? null,
      text: s.textContent,
      code: s.querySelector('[data-twitch-code]')?.dataset.twitchCode ?? null,
      message: s.querySelector('[data-twitch-message]')?.textContent ?? null,
      linking: s.querySelector('[data-twitch-message]')?.dataset.twitchLinking ?? null,
      link: s.querySelector('[data-twitch=link]')?.textContent ?? null,
      cancel: s.querySelector('[data-twitch=cancel]') !== null,
      open: s.querySelector('[data-twitch=open-activate]') !== null,
      confirm: s.querySelector('[data-twitch-confirm]')?.textContent ?? null,
      removable: s.querySelector('[data-twitch=remove]') !== null,
    }; })()`,
  );
const editorFace = () =>
  inPage(
    editor,
    'editor',
    `(() => {
      const rows = ${JSON.stringify(TYPES)}.map((t) => document.querySelector('.library-entry[data-action-type="' + t + '"]'));
      const key0 = document.querySelector('.key[data-key-index="0"]');
      const callout = document.querySelector('.inspector [data-not-set-up=twitch]');
      return {
        group: [...document.querySelectorAll('.library-group')].some((g) => /Twitch/.test(g.textContent ?? '')),
        rows: rows.map((r) => r !== null),
        blocked: rows.map((r) => r?.dataset.notSetUp ?? null),
        title: rows[2]?.title ?? null,
        icons: rows.map((r) => r?.querySelector('img')?.getAttribute('src') ?? ''),
        keyUnset: key0?.classList.contains('key-unset') ?? null,
        callout: callout?.textContent ?? null,
        calloutButton: callout?.querySelector('button')?.textContent ?? null,
      };
    })()`,
  );

const r = {};
const editor = startEditorAt(electronPath, editorRoot, env);
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);

// --- Not linked ---------------------------------------------------------------------
await until(async () => (await editorFace()).blocked[2] === 'true');
await inPage(editor, 'editor', clickIn('.key[data-key-index="0"]'));
await until(async () => (await editorFace()).callout !== null);
r.notLinked = await editorFace();

// --- Settings › Integrations › Twitch ------------------------------------------------
await inPage(editor, 'editor', "window.deckhand.openSettings('twitch').then(() => true)");
await until(async () => (await section())?.state != null);
r.opened = await section();
r.focused = await inPage(editor, 'settings', 'document.activeElement?.dataset.twitch ?? null');
r.editorCannotLink = await inPage(editor, 'editor', 'window.deckhand.twitchLink().then((x) => x.ok === false)');

await inPage(editor, 'settings', clickIn('[data-twitch=link]'));
r.waiting = (await until(async () => (await section())?.code != null)) && (await section());
r.fakeCode = fake.requests.filter((q) => q.path === '/oauth2/device').length;
await inPage(editor, 'settings', clickIn('[data-twitch=open-activate]'));
await until(async () => (await fs.readFile(openLog, 'utf8').catch(() => '')).length > 0);
r.openedUrl = (await fs.readFile(openLog, 'utf8').catch(() => '')).trim();
r.editorCannotOpen = await inPage(editor, 'editor', 'window.deckhand.twitchOpenActivate().then((x) => x.ok === false)');
fake.approve();
r.linked = (await until(async () => (await section())?.state === 'linked')) && (await section());
const saved = (await credentials()).twitch ?? {};
r.saved = saved;
r.statusHasNoToken = !JSON.stringify(await inPage(editor, 'settings', 'window.deckhand.twitchStatus()')).includes(saved.refreshToken ?? '<none>');
r.pageHasNoToken = !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(saved.refreshToken ?? '<none>') && !(await inPage(editor, 'settings', 'document.body.innerHTML')).includes(saved.accessToken ?? '<none>');
r.linkedFace = (await until(async () => (await editorFace()).blocked.every((b) => b === null) && (await editorFace()).keyUnset === false)) && (await editorFace());

// Link again, then Cancel: polling stops, and the link it had stays.
await inPage(editor, 'settings', clickIn('[data-twitch=link]'));
await until(async () => (await section())?.cancel === true);
await inPage(editor, 'settings', clickIn('[data-twitch=cancel]'));
r.cancelled = (await until(async () => (await section())?.linking === 'cancelled')) && (await section());
const pollsAfterCancel = polls();
await sleep(1600);
r.pollsStopped = polls() === pollsAfterCancel;

// --- The forms ----------------------------------------------------------------------
const picker = () =>
  inPage(
    editor,
    'editor',
    `(() => { const ul = document.querySelector('.inspector [data-twitch-picker=category]'); return {
      ids: ul ? [...ul.querySelectorAll('[data-twitch-id]')].map((b) => b.dataset.twitchId) : [],
      names: ul ? [...ul.querySelectorAll('[data-twitch-id] .target-name')].map((n) => n.textContent) : [],
      chosen: document.querySelector('.inspector [data-twitch-category]')?.textContent ?? null,
    }; })()`,
  );
// Stream info: a category from Twitch's search, then a title.
await inPage(editor, 'editor', clickIn('.key[data-key-index="3"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="twitch.streamInfo"]'));
await until(async () => (await inPage(editor, 'editor', "document.querySelector('[data-twitch-field=category-search]') !== null")) === true);
r.streamInfoNotWrittenYet = (await buttonsNow())['3'] ?? null;
await inPage(editor, 'editor', typeInto('[data-twitch-field=category-search]', 'fort'));
await until(async () => (await picker()).ids.length > 0);
r.found = await picker();
r.searchedOnce = fake.searches.filter((q) => q === 'fort').length;
await inPage(editor, 'editor', clickIn('.inspector [data-twitch-picker=category] [data-twitch-id="33214"]'));
r.categorySaved = await until(async () => (await buttonsNow())['3']?.action?.category === '33214');
await inPage(editor, 'editor', typeInto('.inspector input[aria-label="Stream title"]', 'Ranked grind', true));
r.titleSaved = await until(async () => (await buttonsNow())['3']?.action?.title === 'Ranked grind');
r.streamInfo = (await buttonsNow())['3']?.action ?? null;
r.chosenShown = (await picker()).chosen;

// Chat message: over Twitch's 500, shown and never saved; then saved.
await inPage(editor, 'editor', clickIn('.key[data-key-index="2"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="twitch.chat"]'));
await until(async () => (await inPage(editor, 'editor', "document.querySelector('.inspector textarea[aria-label=\"Chat message\"]') !== null")) === true);
await inPage(editor, 'editor', typeInto('.inspector textarea[aria-label="Chat message"]', 'y'.repeat(501), true));
await sleep(700);
r.overShown = await inPage(editor, 'editor', "document.querySelector('.inspector [data-twitch-over]')?.textContent ?? null");
r.overNotSaved = (await buttonsNow())['2'] ?? null;
await inPage(editor, 'editor', typeInto('.inspector textarea[aria-label="Chat message"]', 'Thanks for watching!', true));
r.chatSaved = await until(async () => (await buttonsNow())['2']?.action?.message === 'Thanks for watching!');

// Stream marker: needs nothing, so a library pick writes it at once.
await inPage(editor, 'editor', clickIn('.key[data-key-index="4"]'));
await sleep(200);
await inPage(editor, 'editor', clickIn('.library-entry[data-action-type="twitch.marker"]'));
r.markerWritten = await until(async () => (await buttonsNow())['4']?.action?.type === 'twitch.marker');

// --- Remove -------------------------------------------------------------------------
const revokesBefore = fake.requests.filter((q) => q.path === '/oauth2/revoke').length;
await inPage(editor, 'settings', clickIn('[data-twitch=remove]'));
r.confirm = (await section()).confirm;
await inPage(editor, 'settings', clickIn('[data-twitch=keep]'));
r.kept = { state: (await section()).state, saved: (await credentials()).twitch !== undefined };
await inPage(editor, 'settings', clickIn('[data-twitch=remove]'));
await inPage(editor, 'settings', clickIn('[data-twitch=confirm-remove]'));
r.removed = (await until(async () => (await section())?.state === 'not-set-up')) && { section: await section(), saved: (await credentials()).twitch ?? null };
r.revoked = fake.requests.filter((q) => q.path === '/oauth2/revoke').length === revokesBefore + 1 && fake.requests.filter((q) => q.path === '/oauth2/revoke').at(-1).body.token === saved.refreshToken;
r.removedFace = (await until(async () => (await editorFace()).keyUnset === true)) && (await editorFace());
r.keysKept = (await buttonsNow())['0']?.action?.type ?? null;
r.slowDowns = fake.slowDowns;

editor.child.kill();
await until(() => editor.exited !== null, 10_000);

check('not linked: the library lists the four Twitch keys under Twitch, each marked, saying where to link', () => {
  assert.equal(r.notLinked.group, true, 'a Twitch group');
  assert.deepEqual(r.notLinked.rows, [true, true, true, true]);
  assert.deepEqual(r.notLinked.blocked, ['true', 'true', 'true', 'true']);
  assert.match(r.notLinked.title, /^Twitch is not set up\. Its keys do nothing until an account is linked in Settings › Integrations\. Click to set it up\.$/);
});
check("each Twitch row draws its own icon, not another key's", () => {
  assert.deepEqual(
    r.notLinked.icons.map((src) => decodeURIComponent(/path=([^&]+)/.exec(src)?.[1] ?? src)),
    ['builtin:twitch-marker', 'builtin:twitch-clip', 'builtin:twitch-chat', 'builtin:twitch-stream-info'],
  );
});
check('not linked: the key is dimmed, and its callout offers Set up Twitch', () => {
  assert.equal(r.notLinked.keyUnset, true);
  assert.match(r.notLinked.callout, /Twitch is not set up/);
  assert.equal(r.notLinked.calloutButton, 'Set up Twitch');
});
check('Settings opens at Twitch, Link Twitch focused, saying what the link will be able to do, on your own channel only', () => {
  assert.equal(r.opened.state, 'not-set-up');
  assert.equal(r.focused, 'link');
  assert.equal(r.opened.link, 'Link Twitch');
  assert.match(r.opened.allows, /^WILL BE ABLE TO\s*Title & categoryMarkersClipsChatYour channel only, and only when a key is pressed$/);
});
check('linked: what it is allowed, and About this link open — listed as DeckHandApp, the 30-day rule', () => {
  assert.match(r.linked.allows, /^ALLOWED\s*Title & categoryMarkersClipsChat/);
  assert.match(r.linked.text, /Listed as DeckHandApp at twitch\.tv\/settings\/connections\. Renews while Deckhand runs; Twitch ends it after 30 days unused\./);
});
check('only the Settings window can link or open the activate page', () => {
  assert.equal(r.editorCannotLink, true);
  assert.equal(r.editorCannotOpen, true);
});
check('Link: the code shown large, with Open twitch.tv/activate and Cancel', () => {
  assert.match(r.waiting.code ?? '', /^[A-Z0-9]{8}$/);
  assert.equal(r.waiting.open, true);
  assert.equal(r.waiting.cancel, true);
  assert.equal(r.fakeCode, 1, 'one code asked for');
});
check("Open twitch.tv/activate opens Twitch's page with the code filled in — the daemon's URL", () => {
  assert.equal(r.openedUrl, `https://www.twitch.tv/activate?device-code=${r.waiting.code}`);
});
check('approved at Twitch: linked, as the account, saved with the client ID it was made with', () => {
  assert.equal(r.linked.statusText, 'Linked as fakestreamer');
  assert.equal(r.linked.linking, 'approved');
  assert.equal(r.saved.clientId, fake.clientId);
  assert.equal(r.saved.login, 'fakestreamer');
});
check('no token reaches the Settings window: not its status, not its page', () => {
  assert.equal(r.statusHasNoToken, true);
  assert.equal(r.pageHasNoToken, true);
});
check('linked: the library rows and the key are no longer marked', () => {
  assert.deepEqual(r.linkedFace.blocked, [null, null, null, null]);
  assert.equal(r.linkedFace.keyUnset, false);
  assert.equal(r.linkedFace.callout, null);
});
check('Cancel: says so, stops the polling at once, and the link it had stays', () => {
  assert.match(r.cancelled.message, /cancelled/);
  assert.equal(r.cancelled.state, 'linked');
  assert.equal(r.pollsStopped, true);
});
check("Stream info: nothing written until something is chosen; the category from Twitch's search, by ID with its name", () => {
  assert.equal(r.streamInfoNotWrittenYet, null);
  assert.deepEqual(r.found.ids, ['33214']);
  assert.deepEqual(r.found.names, ['Fortnite']);
  assert.equal(r.searchedOnce, 1, 'one search for the query, once typing paused');
  assert.equal(r.categorySaved, true);
  assert.equal(r.titleSaved, true);
  assert.deepEqual(r.streamInfo, { type: 'twitch.streamInfo', category: '33214', categoryName: 'Fortnite', title: 'Ranked grind' });
  assert.equal(r.chosenShown, 'Fortnite');
});
check('Chat message over 500 characters: shown, and never saved; within it, saved', () => {
  assert.match(r.overShown ?? '', /501 characters: Twitch takes up to 500, so it is not saved\./);
  assert.equal(r.overNotSaved, null);
  assert.equal(r.chatSaved, true);
});
check('Stream marker: needs nothing set — a library pick writes the key at once', () => {
  assert.equal(r.markerWritten, true);
});
check('Remove asks first, saying what it costs; Keep keeps the link', () => {
  assert.match(r.confirm, /Every Twitch key stops working until an account is linked again\. The keys stay where they are\. The link is ended at Twitch too\./);
  assert.deepEqual(r.kept, { state: 'linked', saved: true });
});
check('Remove: not linked, nothing saved, the link ended at Twitch by its refresh token; the keys stay, dimmed', () => {
  assert.equal(r.removed.section.state, 'not-set-up');
  assert.equal(r.removed.saved, null);
  assert.equal(r.revoked, true);
  assert.equal(r.removedFace.keyUnset, true);
  assert.equal(r.keysKept, 'twitch.chat');
});
check('never a poll sooner than Twitch asked', () => assert.equal(r.slowDowns, 0));

twitch.stop();
stopWatching();
await daemon.stop();
await fake.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
