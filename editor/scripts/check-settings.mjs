// The settings window, end to end in real Electron.
//
// Driven like check-tray.mjs (scripts/lib/drive-editor.mjs), on a private bus.
// The settings window is opened by clicking the editor's gear, and every
// setting is changed by using its control in the settings window's page. What
// is checked from outside the page: preferences.json on disk, the accent on
// the editor's root element, how many windows exist, and whether closing the
// editor quits.
//
// The config lists the V2 before the XL, so Automatic opens on the V2 — the
// reason the Default deck setting exists.
//
// Usage: npm run check:settings   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inPage, onPrivateBus, startEditor as startEditorAt, stateOf, until } from './lib/drive-editor.mjs';

await onPrivateBus('DECKHAND_SETTINGS_PRIVATE_BUS');

const editorRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(editorRoot, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-settings-'));
const configDir = path.join(scratch, 'config');
const stateDir = path.join(scratch, 'state');
const prefsFile = path.join(stateDir, 'editor', 'preferences.json');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
// Before the daemon's modules load: Settings' idle question goes to a stand-in, not this desktop.
process.env.DECKHAND_PANEL_BIN = path.join(editorRoot, '..', 'scripts/test/fake-idle-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon, sleep } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);
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

const XL = 'SETTINGS-XL';
const V2 = 'SETTINGS-V2';
const page = { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } };
const CONFIG = {
  decks: { [V2]: { name: 'Deck V2' }, [XL]: { name: 'Deck XL' } },
  profiles: { default: { name: 'Default', layouts: { [V2]: page, [XL]: page } } },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');
const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(V2, new FakeDeck({ columns: 5, rows: 3, pixels: 72, model: 'original-v2', productName: 'Stream Deck' }));
await daemon.attach(XL, new FakeDeck());
const stopWatching = await reloadLikeTheDaemon(daemon);

// ABOUT: a VERSION file standing in for an install's, and a file the
// releases link writes to instead of opening a browser.
const versionFile = path.join(scratch, 'VERSION');
await fs.writeFile(versionFile, 'v9.8.7-check\n');
const openLog = path.join(scratch, 'opened.log');

const UPDATE_LINE = 'curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash';
// The update check, against a GitHub of the check's own: a newer release, and every request it gets.
const githubRequests = [];
const github = http.createServer((req, res) => {
  githubRequests.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ tag_name: 'v9.9.0', html_url: 'https://github.com/juicetheforce/deckhand/releases/tag/v9.9.0', body: `**What's new**\n\n- **First** line\n- Second line\n- Third line\n- Fourth line\n\n\nInstall or update: \`${UPDATE_LINE}\`. SHA256SUMS lets the installer check it.\n` }));
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));

const env = {
  ...process.env,
  DECKHAND_CHECK_VERSION_FILE: versionFile,
  DECKHAND_CHECK_OPEN_LOG: openLog,
  DECKHAND_CHECK_UPDATE_URL: `http://127.0.0.1:${github.address().port}/repos/juicetheforce/deckhand/releases/latest`,
  DECKHAND_EDITOR_CHECK: 'tray',
  DECKHAND_CONFIG_DIR: configDir,
  DECKHAND_STATE_DIR: stateDir,
  DECKHAND_SOCKET: daemon.socket,
  DECKHAND_BUILTIN_ICONS: path.join(repoRoot, 'assets', 'icons'),
};
delete env.ELECTRON_RUN_AS_NODE;
const startEditor = () => startEditorAt(electronPath, editorRoot, env);

const prefs = async () => {
  try {
    return JSON.parse(await fs.readFile(prefsFile, 'utf8'));
  } catch {
    return {};
  }
};
/**
 * The deck the editor has open, once it is connected and has followed the
 * deck: the Device dropdown's value with one deck connected, the SHOW IN
 * EDITOR button's data-deck with two or more.
 */
async function openDeck(editor) {
  await until(async () => (await inPage(editor, 'editor', "document.querySelector('.toolbar .pill-connected') !== null")) === true);
  await sleep(300);
  return inPage(editor, 'editor', "(() => { const d = document.querySelector('[data-crumb=\"device\"]'); return d instanceof HTMLSelectElement ? d.value : d.dataset.deck; })()");
}
const editorAccent = (editor) => inPage(editor, 'editor', "document.documentElement.dataset.accent ?? 'blue'");
const clickGear = (editor) => inPage(editor, 'editor', "document.querySelector('.toolbar-settings').click(), true");
const setSelect = (value) =>
  `(() => { const s = document.querySelector('#settings-default-deck'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const clickIn = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`;
const clickButton = (text) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); return true; })()`;
/**
 * Click a button that closes the settings window. The click waits until the
 * page has answered: closing the window first can lose the answer, and the
 * check then fails with "no answer" (seen once in a full run).
 */
const clickClosing = (text) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); setTimeout(() => b.click(), 0); return true; })()`;
/** Show one page of the settings window, by its sidebar entry. */
const nav = (editor, page) => inPage(editor, 'settings', clickIn(`[data-settings-nav=${page}]`)).then(() => sleep(100));
async function openSettings(editor) {
  await clickGear(editor);
  await until(async () => (await stateOf(editor)).settingsOpen);
  await until(async () => (await inPage(editor, 'settings', "document.querySelector('.settings-footer') !== null")) === true);
}

const r = {};
const editor = startEditor();
await until(() => editor.reports.some((x) => x.event === 'ready'), 30_000);

// Automatic: the first connected deck with a layout — the V2.
r.automaticOpensOn = await openDeck(editor);

// The gear opens the settings window; clicking it again brings that one forward.
await openSettings(editor);
await clickGear(editor);
await sleep(300);
r.windowsWithSettings = (await stateOf(editor)).windows;
// It opens on General; the pages are the sidebar's.
r.layout = await inPage(
  editor,
  'settings',
  `({
    page: document.querySelector('.settings').dataset.settingsPage,
    nav: [...document.querySelectorAll('[data-settings-nav]')].map((b) => b.textContent.trim()),
    heading: document.querySelector('.sp-nav-heading')?.textContent ?? null,
    note: document.querySelector('.settings-note').textContent,
  })`,
);
r.shown = await inPage(
  editor,
  'settings',
  `({
    closeToTray: document.querySelector('#settings-close-to-tray').checked,
    subtitle: document.querySelector('#settings-close-to-tray').closest('.sp-row').querySelector('.sp-row-detail').textContent,
    accentChecked: document.querySelector('[role=radio][aria-checked=true]').dataset.accentSwatch,
    title: document.title,
  })`,
);
await nav(editor, 'decks');
Object.assign(
  r.shown,
  await inPage(
    editor,
    'settings',
    `({
      deckOptions: [...document.querySelectorAll('#settings-default-deck option')].map((o) => o.textContent),
      deckValue: document.querySelector('#settings-default-deck').value,
      decksNote: document.querySelector('.settings-note').textContent,
    })`,
  ),
);
// The pages whose changes do not save by themselves do not say they do: OBS has its own Save.
r.notes = {};
for (const page of ['obs', 'vts', 'twitch', 'backups', 'about']) {
  await nav(editor, page);
  r.notes[page] = await inPage(editor, 'settings', "document.querySelector('.settings-note').textContent");
}

// ABOUT: the version, selectable; the releases link opens only the releases page.
await nav(editor, 'about');
r.about = await inPage(
  editor,
  'settings',
  `(() => { const v = document.querySelector('.settings-version'); const icon = document.querySelector('.sp-about-icon');
    return { text: v.textContent, select: getComputedStyle(v).userSelect, icon: icon?.getAttribute('src') ?? null, iconLoaded: icon ? icon.complete && icon.naturalWidth > 0 : false }; })()`,
);
r.editorOpenRefused = await inPage(editor, 'editor', 'window.deckhand.openReleases()');
await inPage(editor, 'settings', clickIn('[data-about=releases]'));
await sleep(300);
r.opened = await fs.readFile(openLog, 'utf8').catch(() => '');

// UPDATES: asked once when the editor opened; v9.9.0 is newer than v9.8.7-check.
const updateView = `(() => ({
  available: document.querySelector('[data-about=update]') !== null,
  row: document.querySelector('[data-about=updates]')?.textContent ?? null,
  dot: document.querySelector('[data-settings-nav=about] [data-dot=update]') !== null,
  switchHere: document.querySelector('#settings-check-updates') !== null,
}))()`;
r.updatesOnOpen = { requests: githubRequests.length, headers: githubRequests[0]?.headers ?? null };
r.updateShown = await inPage(editor, 'settings', updateView);
await fs.writeFile(openLog, '');
// Only if it is there: missing, the checks below say so by name instead of the run stopping here.
if (r.updateShown.available) await inPage(editor, 'settings', clickIn('[data-about=update]'));
await sleep(300);
r.updateOpened = await fs.readFile(openLog, 'utf8').catch(() => '');

// The pill, in the editor: left of the settings icon, its panel below it.
const pillView = `(() => {
  const pill = document.querySelector('[data-update-pill]');
  const panel = document.querySelector('[data-update-panel]');
  return {
    pill: pill?.textContent ?? null,
    title: pill?.getAttribute('title') ?? null,
    label: pill?.getAttribute('aria-label') ?? null,
    beforeSettings: document.querySelector('.toolbar-settings')?.previousElementSibling?.contains(pill) ?? false,
    panelTitle: panel?.querySelector('.update-panel-title')?.textContent ?? null,
    sub: panel?.querySelector('.update-panel-sub')?.textContent ?? null,
    lines: panel ? [...panel.querySelectorAll('.update-panel-text')].map((l) => l.textContent) : null,
    command: panel?.querySelector('[data-update-line]')?.textContent ?? null,
    copy: panel?.querySelector('[data-update-copy]')?.textContent ?? null,
    hint: panel?.querySelector('.update-panel-hint')?.textContent ?? null,
    onTop: panel ? (() => { const b = panel.getBoundingClientRect(); return panel.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) && b.left >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight; })() : null,
  };
})()`;
r.pillAtRest = await inPage(editor, 'editor', pillView);
await inPage(editor, 'editor', clickIn('[data-update-pill]'));
await sleep(100);
r.pillOpen = await inPage(editor, 'editor', pillView);
await fs.writeFile(openLog, '');
await inPage(editor, 'editor', clickIn('[data-update-copy]'));
await sleep(100);
r.pillCopied = await inPage(editor, 'editor', pillView);
r.copiedLog = await fs.readFile(openLog, 'utf8').catch(() => '');
await sleep(2200);
r.pillCopiedAfter = (await inPage(editor, 'editor', pillView)).copy;
await fs.writeFile(openLog, '');
await inPage(editor, 'editor', clickIn('[data-update-notes]'));
await sleep(300);
r.notesOpened = await fs.readFile(openLog, 'utf8').catch(() => '');
await inPage(editor, 'editor', "(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)");
await sleep(100);
r.pillEscaped = await inPage(editor, 'editor', pillView);
await inPage(editor, 'editor', clickIn('[data-update-pill]'));
await sleep(100);
await inPage(editor, 'editor', "(document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true)");
await sleep(100);
r.pillClickedOutside = (await inPage(editor, 'editor', pillView)).panelTitle;
await inPage(editor, 'editor', clickIn('[data-update-pill]'));
await sleep(100);
await inPage(editor, 'editor', clickIn('[data-update-pill]'));
await sleep(100);
r.pillClickedAgain = (await inPage(editor, 'editor', pillView)).panelTitle;
await inPage(editor, 'editor', clickIn('[data-update-pill]'));
await sleep(100);
await inPage(editor, 'editor', clickIn('[data-update-later]'));
r.notNowStored = await until(async () => (await prefs()).dismissedUpdate === 'v9.9.0');
await sleep(100);
r.afterNotNow = { pill: (await inPage(editor, 'editor', pillView)).pill, about: (await inPage(editor, 'settings', updateView)).available };

// The switch: in General now. Off, nothing shown, nothing asked; on again, asked at once.
await nav(editor, 'general');
r.switchInGeneral = await inPage(editor, 'settings', `(() => { const g = document.querySelector('[data-settings-group=updates]'); return { text: g?.textContent ?? null, on: document.querySelector('#settings-check-updates')?.checked ?? null, heading: [...document.querySelectorAll('.sp-group')].map((x) => x.querySelector('h2,h3,.sp-group-heading')?.textContent ?? '') }; })()`);
await inPage(editor, 'settings', clickIn('#settings-check-updates'));
r.updateOffStored = await until(async () => (await prefs()).checkForUpdates === false);
await nav(editor, 'about');
r.updateOff = { view: await inPage(editor, 'settings', updateView), pill: (await inPage(editor, 'editor', pillView)).pill, requests: githubRequests.length };
await nav(editor, 'general');
await inPage(editor, 'settings', clickIn('#settings-check-updates'));
await nav(editor, 'about');
r.updateOnAgain = { shown: await until(async () => (await inPage(editor, 'settings', updateView)).available), requests: githubRequests.length };
await nav(editor, 'general');

// The editor window cannot change settings, even through the bridge.
// Read back from main, not preferences.json: the file is written 400 ms after
// a change, so reading it straight away passed whatever the guard did.
r.editorRefused = await inPage(editor, 'editor', "window.deckhand.setAppSettings({ accent: 'teal' }).then(() => window.deckhand.appSettings()).then((s) => s.accent)");

// Default deck → the XL; purple accent — each saved at once, the accent live in the editor.
await nav(editor, 'decks');
await inPage(editor, 'settings', setSelect(XL));
r.deckSaved = await until(async () => (await prefs()).defaultDeck === XL);
await nav(editor, 'general');
await inPage(editor, 'settings', clickIn('[data-accent-swatch=purple]'));
r.accentSaved = await until(async () => (await prefs()).accent === 'purple');
r.accentLiveInEditor = await until(async () => (await editorAccent(editor)) === 'purple');
r.accentInSettings = await inPage(editor, 'settings', "document.documentElement.dataset.accent ?? 'blue'");
r.editorStillOnV2 = await openDeck(editor); // a setting changes the next opening, not this one

// Closing the editor takes the settings window with it; reopening opens on the XL, still purple.
editor.send('close');
r.closedToTray = await until(async () => {
  const s = await stateOf(editor);
  return !s.windowOpen && !s.holding && !s.settingsOpen;
});
r.windowsInTray = (await stateOf(editor)).windows;
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.reopensOn = await openDeck(editor);
r.accentAfterReopen = await editorAccent(editor);

// Unplug the XL. The setting still names it — unplugging must not lose the
// choice — but the list offers only what is plugged in, and until the XL is
// back the editor opens as Automatic would. Plugged back in, it opens on the XL.
await daemon.sessions.get(XL).close();
daemon.sessions.delete(XL);
daemon.events.state();
r.unpluggedMovesToV2 = await until(async () => (await openDeck(editor)) === V2);
await openSettings(editor);
await nav(editor, 'decks');
r.unpluggedShown = await inPage(
  editor,
  'settings',
  `({ options: [...document.querySelectorAll('#settings-default-deck option')].map((o) => o.textContent), value: document.querySelector('#settings-default-deck').value })`,
);
r.unpluggedStillSaved = (await prefs()).defaultDeck;
await inPage(editor, 'settings', clickClosing('Done'));
await until(async () => !(await stateOf(editor)).settingsOpen);
editor.send('close');
await until(async () => !(await stateOf(editor)).windowOpen);
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.unpluggedReopensOn = await openDeck(editor);
await daemon.attach(XL, new FakeDeck());
editor.send('close');
await until(async () => !(await stateOf(editor)).windowOpen);
editor.send('click');
await until(async () => (await stateOf(editor)).windowOpen);
r.replugReopensOn = await until(async () => (await openDeck(editor)) === XL);

// Notifications: in config.json, because the daemon sends them — not in the preferences.
await openSettings(editor);
const configJson = async () => JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
r.notificationsShown = await inPage(editor, 'settings', "[document.querySelector('#settings-notifications').checked, document.querySelector('#settings-notifications').disabled]");
await inPage(editor, 'settings', clickIn('#settings-notifications'));
r.notificationsOffSaved = await until(async () => (await configJson()).notifications === false);
r.notificationsNotInPrefs = !('notifications' in (await prefs()));

// Icon size (Claude Design's 16a–16c): a slider in Appearance, in config.json
// because the daemon draws the icons. The sample follows every move; config.json
// changes only on release — a key let go, or the end of a drag.
const slider = "document.querySelector('[role=slider][aria-label=\"Icon size\"]')";
const sliderState = `(() => { const s = ${slider}; const img = document.querySelector('[data-settings=icon-sample] img'); return { now: s.getAttribute('aria-valuenow'), text: s.getAttribute('aria-valuetext'), min: s.getAttribute('aria-valuemin'), max: s.getAttribute('aria-valuemax'), value: s.parentElement.querySelector('.sp-slider-value').textContent, ticks: s.querySelectorAll('.sp-slider-tick').length, sample: img.getAttribute('width'), row: s.closest('.sp-row')?.textContent ?? '' }; })()`;
const key = (type, k) => `(() => { ${slider}.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}', bubbles: true, cancelable: true })); return true; })()`;
const iconSizeOnDisk = async () => (await configJson()).defaults?.builtinIconSize ?? 'absent';
r.iconSizeAtRest = await inPage(editor, 'settings', sliderState);
await inPage(editor, 'settings', key('keydown', 'ArrowRight'));
await sleep(100);
await inPage(editor, 'settings', key('keydown', 'ArrowRight'));
// Longer than the store's 400 ms autosave: a value saved too early would be on disk by now.
await sleep(900);
r.iconSizeWhileHeld = { shown: await inPage(editor, 'settings', sliderState), onDisk: await iconSizeOnDisk() };
await inPage(editor, 'settings', key('keyup', 'ArrowRight'));
r.iconSizeKeySaved = await until(async () => (await iconSizeOnDisk()) === 52.5);
await inPage(editor, 'settings', key('keydown', 'End'));
await inPage(editor, 'settings', key('keyup', 'End'));
r.iconSizeEnd = await until(async () => (await iconSizeOnDisk()) === 70);
// A drag, by pointer: down at the left end, move to the middle, up.
const pointer = (type, fraction) => `(() => { const s = ${slider}; const r = s.getBoundingClientRect(); s.dispatchEvent(new PointerEvent('${type}', { bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width * ${fraction}, clientY: r.top + 12 })); return true; })()`;
await inPage(editor, 'settings', pointer('pointerdown', 0.02));
await inPage(editor, 'settings', pointer('pointermove', 0.5));
await sleep(900);
r.iconSizeWhileDragging = { shown: await inPage(editor, 'settings', sliderState), onDisk: await iconSizeOnDisk() };
await inPage(editor, 'settings', pointer('pointerup', 0.5));
r.iconSizeDragSaved = await until(async () => (await iconSizeOnDisk()) === 49);

// Sleep when the screen locks: on by default, in config.json because the daemon sleeps the decks.
r.sleepShown = await inPage(editor, 'settings', "[document.querySelector('#settings-sleep-on-lock').checked, document.querySelector('#settings-sleep-on-lock').disabled]");
await inPage(editor, 'settings', clickIn('#settings-sleep-on-lock'));
r.sleepOffSaved = await until(async () => (await configJson()).defaults?.sleep?.onLock === false);

// Idle dimming: a desktop that offers it (a stand-in says so), then one that doesn't.
const idleView = `(() => ({
  dimAfter: document.querySelector('#settings-dim-after').value,
  dimDisabled: document.querySelector('#settings-dim-after').disabled,
  sleepDisabled: document.querySelector('#settings-sleep-after').disabled,
  dimToDisabled: String(document.querySelector('[role=slider][aria-label="Dim to"]').closest('.sp-slider, [class*=sp-slider]')?.className.includes('sp-slider-disabled') ?? null),
  dimToNow: document.querySelector('[role=slider][aria-label="Dim to"]').getAttribute('aria-valuenow'),
  note: document.querySelector('[data-settings=idle-unavailable]')?.textContent ?? null,
  options: [...document.querySelector('#settings-dim-after').options].map((o) => o.textContent),
}))()`;
const choose = (id, value) => `(() => { const s = document.querySelector('${id}'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '${value}'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const sleepOnDisk = async () => (await configJson()).defaults?.sleep ?? null;
r.idleAtRest = await inPage(editor, 'settings', idleView);
await inPage(editor, 'settings', choose('#settings-dim-after', '60'));
await inPage(editor, 'settings', choose('#settings-sleep-after', '300'));
r.idleSaved = await until(async () => { const v = await sleepOnDisk(); return v?.dimAfter === 60 && v?.sleepAfter === 300 && v?.onLock === false; });
r.idleEnabled = await inPage(editor, 'settings', idleView);
await inPage(editor, 'settings', choose('#settings-dim-after', ''));
await inPage(editor, 'settings', choose('#settings-sleep-after', ''));
r.idleOffSaved = await until(async () => { const v = await sleepOnDisk(); return v?.dimAfter === undefined && v?.sleepAfter === undefined; });
process.env.FAKE_IDLE_UNAVAILABLE = '1';
await inPage(editor, 'settings', "window.location.reload(), true").catch(() => undefined);
await sleep(1200);
await nav(editor, 'general');
r.idleUnavailable = await inPage(editor, 'settings', idleView);
delete process.env.FAKE_IDLE_UNAVAILABLE;
await inPage(editor, 'settings', "window.location.reload(), true").catch(() => undefined);
await sleep(1200);
await nav(editor, 'general');

// Label size: the same slider, over defaults.labelSize. Saved on release, the sample live.
const labelSlider = "document.querySelector('[role=slider][aria-label=\"Label size\"]')";
const labelState = `(() => { const s = ${labelSlider}; return { now: s.getAttribute('aria-valuenow'), min: s.getAttribute('aria-valuemin'), max: s.getAttribute('aria-valuemax'), sample: document.querySelector('[data-settings=label-sample]').style.fontSize }; })()`;
const labelKey = (type, k) => `(() => { ${labelSlider}.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}', bubbles: true, cancelable: true })); return true; })()`;
const labelOnDisk = async () => (await configJson()).defaults?.labelSize ?? 'absent';
r.labelAtRest = await inPage(editor, 'settings', labelState);
await inPage(editor, 'settings', labelKey('keydown', 'End'));
await sleep(900);
r.labelWhileHeld = { shown: await inPage(editor, 'settings', labelState), onDisk: await labelOnDisk() };
await inPage(editor, 'settings', labelKey('keyup', 'End'));
r.labelSaved = await until(async () => (await labelOnDisk()) === 28);

// Dropdowns: a <select>'s popup is painted from its <option>s' colours. With none set
// it comes from the system's theme under this page's light text, unreadable.
const optionColours = `(() => {
  const rgb = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = (c) => { const v = rgb(c).slice(0, 3).map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const of = (select, name) => {
    const o = select.querySelector('option') ?? select.appendChild(document.createElement('option'));
    const st = getComputedStyle(o);
    const bg = rgb(st.backgroundColor);
    const opaque = bg.length === 3 || bg[3] === 1;
    const a = lum(st.backgroundColor), b = lum(st.color);
    return { name, opaque, contrast: opaque ? Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10 : 0 };
  };
  const shown = [...document.querySelectorAll('select')].map((x) => of(x, x.id || x.getAttribute('aria-label') || x.dataset.crumb || 'a select'));
  /* One made here, with no class: a dropdown added later is covered without being named. */
  const fresh = document.createElement('select');
  document.body.appendChild(fresh);
  const anyNew = of(fresh, 'a new dropdown');
  fresh.remove();
  return [...shown, anyNew];
})()`;
r.dropdownsSettings = await inPage(editor, 'settings', optionColours);
r.dropdownsEditor = await inPage(editor, 'editor', optionColours);

// Reset to defaults asks first: a button, not a link, and one click changes nothing; Keep keeps.
r.resetButton = await inPage(
  editor,
  'settings',
  "(() => { const b = document.querySelector('[data-settings=reset]'); return { text: b.textContent, tag: b.tagName, quiet: b.classList.contains('sp-button-quiet') }; })()",
);
const prefsBeforeReset = JSON.stringify(await prefs());
await inPage(editor, 'settings', clickIn('[data-settings=reset]'));
r.resetAsks = await inPage(editor, 'settings', "document.querySelector('[data-settings-confirm=reset]')?.textContent ?? null");
await sleep(600);
r.oneClickChangesNothing = JSON.stringify(await prefs()) === prefsBeforeReset && (await configJson()).notifications === false;
await inPage(editor, 'settings', clickIn('[data-settings=keep-settings]'));
await sleep(600);
r.keepKeeps = JSON.stringify(await prefs()) === prefsBeforeReset && (await inPage(editor, 'settings', "document.querySelector('[data-settings-confirm=reset]') === null"));
// Reset, confirmed: all three back, the accent gone from the editor, notifications on again.
await inPage(editor, 'settings', clickIn('[data-settings=reset]'));
await inPage(editor, 'settings', clickIn('[data-settings=confirm-reset]'));
r.notificationsBackOn = await until(async () => !('notifications' in (await configJson())));
r.iconSizeBackToDefault = await until(async () => (await iconSizeOnDisk()) === 'absent') && (await inPage(editor, 'settings', sliderState)).now === '65';
r.sleepBackOn = await until(async () => (await configJson()).defaults?.sleep === undefined);
r.labelBackToDefault = await until(async () => (await labelOnDisk()) === 'absent');
r.reset = await until(async () => {
  const p = await prefs();
  return p.defaultDeck === null && p.closeToTray === true && p.accent === 'blue';
});
r.accentAfterReset = await until(async () => (await editorAccent(editor)) === 'blue');
r.resetShown = [
  await nav(editor, 'decks').then(() => inPage(editor, 'settings', "document.querySelector('#settings-default-deck').value")),
  await nav(editor, 'general').then(() => inPage(editor, 'settings', "document.querySelector('#settings-close-to-tray').checked")),
];

// Done closes the settings window and leaves the editor open.
await inPage(editor, 'settings', clickClosing('Done'));
r.doneCloses = await until(async () => {
  const s = await stateOf(editor);
  return !s.settingsOpen && s.windowOpen;
});

// Close to system tray, unticked: closing the editor now quits.
await openSettings(editor);
await inPage(editor, 'settings', clickIn('#settings-close-to-tray'));
r.trayOffSaved = await until(async () => (await prefs()).closeToTray === false);
editor.send('close');
r.quitWhenOff = await until(() => editor.exited !== null);
r.quitCode = editor.exited?.code ?? null;
if (editor.exited === null) editor.child.kill();

check('Automatic opens on the first connected deck with a layout (the V2, first in config)', () => assert.equal(r.automaticOpensOn, V2));
check('the gear opens one settings window; a second click brings it forward rather than opening another', () => assert.equal(r.windowsWithSettings, 2));
check('it opens on General, with the sidebar: General, Decks, INTEGRATIONS (OBS Studio, VTube Studio, Twitch, Discord), Backups, About', () => {
  assert.equal(r.layout.page, 'general');
  assert.deepEqual(r.layout.nav, ['General', 'Decks', 'OBS Studio', 'VTube Studio', 'Twitch', 'Discord', 'Backups', 'About']);
  assert.equal(r.layout.heading, 'INTEGRATIONS');
});
check('"Changes save automatically" only where it is true: General and Decks, not OBS (its own Save) or the other pages', () => {
  assert.equal(r.layout.note, 'Changes save automatically');
  assert.equal(r.shown.decksNote, 'Changes save automatically');
  assert.deepEqual(r.notes, { obs: '', vts: '', twitch: '', backups: '', about: '' });
});
check('the settings window shows every deck by name, Automatic, close-to-tray on, blue, and the corrected subtitle', () => {
  assert.deepEqual(r.shown.deckOptions, ['Automatic', 'Deck V2', 'Deck XL']);
  assert.equal(r.shown.deckValue, '');
  assert.equal(r.shown.closeToTray, true);
  assert.equal(r.shown.accentChecked, 'blue');
  assert.match(r.shown.subtitle, /system tray/);
  assert.doesNotMatch(r.shown.subtitle, /keys/i, 'the keys run whatever the editor does');
  assert.equal(r.shown.title, 'Deckhand Settings');
});
check('the editor window cannot change settings through the bridge', () => assert.notEqual(r.editorRefused, 'teal'));
check("About shows the installed version, selectable to copy, beside Deckhand's own icon", () => {
  assert.equal(r.about.text, 'v9.8.7-check');
  assert.equal(r.about.select, 'text');
  assert.match(r.about.icon ?? '', /deckhand/);
  assert.equal(r.about.iconLoaded, true);
});
check('the releases link opens the GitHub releases page, once, and only from the settings window', () => {
  assert.equal(r.opened, 'https://github.com/juicetheforce/deckhand/releases\n');
  assert.equal(r.editorOpenRefused.ok, false);
});
check('Check for updates: asked GitHub once when the editor opened, as "Deckhand", saying nothing about this install', () => {
  assert.equal(r.updatesOnOpen.requests, 1);
  assert.equal(r.updatesOnOpen.headers['user-agent'], 'Deckhand');
  assert.ok(!JSON.stringify(r.updatesOnOpen.headers).includes('9.8.7'), 'the installed version was sent');
});
check('a newer release: About says "Update available" and names it; no dot on About, and the switch has left', () => {
  assert.equal(r.updateShown.available, true);
  assert.match(r.updateShown.row ?? '', /Update available.*Deckhand v9\.9\.0/);
  assert.equal(r.updateShown.dot, false);
  assert.equal(r.updateShown.switchHere, false);
});
check("its link opens that release's page", () => {
  assert.equal(r.updateOpened, 'https://github.com/juicetheforce/deckhand/releases/tag/v9.9.0\n');
});
check('the pill: one word, immediately left of the settings icon, with the design\'s tooltip and label; no panel until asked', () => {
  assert.deepEqual({ pill: r.pillAtRest.pill, title: r.pillAtRest.title, label: r.pillAtRest.label, before: r.pillAtRest.beforeSettings, panel: r.pillAtRest.panelTitle }, {
    pill: 'Update', title: 'Deckhand v9.9.0 is available', label: 'Update available: Deckhand v9.9.0', before: true, panel: null,
  });
});
check('the panel: the version, what you have, three lines of What\'s new in plain text, the release\'s own line, Copy, the hint', () => {
  assert.equal(r.pillOpen.panelTitle, 'Deckhand v9.9.0');
  assert.equal(r.pillOpen.sub, 'You have v9.8.7-check');
  assert.deepEqual(r.pillOpen.lines, ['First line', 'Second line', 'Third line']);
  assert.equal(r.pillOpen.command, `$${UPDATE_LINE}`);
  assert.equal(r.pillOpen.copy, 'Copy');
  assert.equal(r.pillOpen.hint, 'Deckhand restarts itself when it’s done.');
  assert.equal(r.pillOpen.onTop, true, 'the panel is whole, inside the window, and on top');
});
check('Copy: copies the line, says Copied, and is back after 2 s; nothing runs', () => {
  assert.equal(r.pillCopied.copy, 'Copied');
  assert.equal(r.copiedLog, `copied ${UPDATE_LINE}\n`);
  assert.equal(r.pillCopiedAfter, 'Copy');
});
check('Full release notes opens the page from the editor', () => assert.equal(r.notesOpened, 'https://github.com/juicetheforce/deckhand/releases/tag/v9.9.0\n'));
check('Esc, a click outside and the pill again each close it, and the pill stays', () => {
  assert.equal(r.pillEscaped.panelTitle, null);
  assert.equal(r.pillEscaped.pill, 'Update');
  assert.equal(r.pillClickedOutside, null);
  assert.equal(r.pillClickedAgain, null);
});
check('Not now: no pill, stored for that version, and About still says', () => {
  assert.equal(r.notNowStored, true);
  assert.deepEqual(r.afterNotNow, { pill: null, about: true });
});
check('Check for updates is in General, with the design\'s words, after Appearance', () => {
  assert.match(r.switchInGeneral.text ?? '', /Check for updatesShows Update in the title bar when a new version is out/);
  assert.equal(r.switchInGeneral.on, true);
});
check('switched off: nothing shown, nothing asked, kept in the preferences', () => {
  assert.equal(r.updateOffStored, true);
  assert.equal(r.updateOff.view.available, false);
  assert.equal(r.updateOff.pill, null);
  assert.equal(r.updateOff.requests, 1);
});
check('switched on again: asked once more, at once, and shown', () => {
  assert.equal(r.updateOnAgain.shown, true);
  assert.equal(r.updateOnAgain.requests, 2);
});
check('Notifications starts ticked; unticking writes "notifications": false to config.json, not the preferences', () => {
  assert.deepEqual(r.notificationsShown, [true, false]);
  assert.equal(r.notificationsOffSaved, true);
  assert.equal(r.notificationsNotInPrefs, true);
});
check('Reset to defaults is a button, without an ellipsis, and asks first: one click changes nothing, Keep keeps', () => {
  assert.deepEqual(r.resetButton, { text: 'Reset to defaults', tag: 'BUTTON', quiet: false });
  assert.match(r.resetAsks ?? '', /^Reset the default deck, close to tray, sleep settings, notifications, accent color, icon size and label size to their defaults\?ResetKeep$/);
  assert.equal(r.oneClickChangesNothing, true);
  assert.equal(r.keepKeeps, true);
});
check('Reset to defaults turns notifications back on: the field leaves config.json', () => assert.equal(r.notificationsBackOn, true));
check('Icon size: a slider in Appearance, shown relative to its largest — 40–100% in steps of 5, 13 ticks, 65% by default — its sample a 56 px key\'s icon at 45.5% of it', () => {
  assert.deepEqual({ ...r.iconSizeAtRest, row: undefined }, { now: '65', text: '65%', min: '40', max: '100', value: '65%', ticks: 13, sample: '25', row: undefined });
  assert.match(r.iconSizeAtRest.row, /^Icon sizeBuilt-in icons on keys/);
});
check('Icon size by keyboard: the sample follows each step at once, and config.json changes only when the key is let go — stored as a percent of the key (75% shown: 52.5); End is the top (70)', () => {
  // Two steps up: 75% shown, 52.5% of the key stored, a 29 px sample.
  assert.deepEqual(r.iconSizeWhileHeld, { shown: { ...r.iconSizeWhileHeld.shown, now: '75', value: '75%', sample: '29' }, onDisk: 'absent' });
  assert.equal(r.iconSizeKeySaved, true);
  assert.equal(r.iconSizeEnd, true);
});
check('Icon size by dragging: snapped to the step, the sample live, nothing saved until the pointer is let go', () => {
  assert.equal(r.iconSizeWhileDragging.shown.now, '70', 'the middle of 40–100');
  assert.equal(r.iconSizeWhileDragging.onDisk, 70);
  assert.equal(r.iconSizeDragSaved, true);
});
check('Reset to defaults puts Icon size back to 65%: the field leaves config.json', () => assert.equal(r.iconSizeBackToDefault, true));
check('Dim after, Dim to and Sleep after: off by default, each saved in config.json without losing the others, Dim to only with Dim after', () => {
  assert.deepEqual({ ...r.idleAtRest, options: undefined }, { dimAfter: '', dimDisabled: false, sleepDisabled: false, dimToDisabled: 'true', dimToNow: '20', note: null, options: undefined });
  assert.deepEqual(r.idleAtRest.options, ['Off', '1 minute', '2 minutes', '5 minutes', '10 minutes', '15 minutes', '30 minutes', '1 hour']);
  assert.equal(r.idleSaved, true);
  assert.equal(r.idleEnabled.dimToDisabled, 'false');
  assert.equal(r.idleOffSaved, true);
});
check('a desktop without idle notifications: the controls greyed out, and the sentence that says why', () => {
  assert.equal(r.idleUnavailable.dimDisabled, true);
  assert.equal(r.idleUnavailable.sleepDisabled, true);
  assert.equal(r.idleUnavailable.dimToDisabled, 'true');
  assert.equal(r.idleUnavailable.note, 'Dimming after idle isn’t available on this desktop; the decks still sleep when the screen locks.');
});
check('every dropdown, in both windows and any added later, has a popup of its own colours that can be read', () => {
  const all = [...r.dropdownsSettings, ...r.dropdownsEditor];
  const names = all.map((d) => d.name);
  for (const name of ['settings-dim-after', 'settings-sleep-after', 'profile', 'a new dropdown']) assert.ok(names.includes(name), `${name} was not looked at: ${names.join()}`);
  for (const d of all) {
    assert.equal(d.opaque, true, `${d.name}: its options have no background of their own, so the system theme paints the popup`);
    assert.ok(d.contrast >= 4.5, `${d.name}: contrast ${d.contrast}`);
  }
});
check('Sleep when the screen locks: on by default, off saved in config.json, and Reset to defaults turns it on', () => {
  assert.deepEqual(r.sleepShown, [true, false]);
  assert.equal(r.sleepOffSaved, true);
  assert.equal(r.sleepBackOn, true);
});
check('Label size: a slider from 8 to 28, 14 by default, the sample live, saved on release, and Reset to defaults removes it', () => {
  assert.deepEqual(r.labelAtRest, { now: '14', min: '8', max: '28', sample: '11px' });
  assert.deepEqual(r.labelWhileHeld, { shown: { now: '28', min: '8', max: '28', sample: '22px' }, onDisk: 'absent' });
  assert.equal(r.labelSaved, true);
  assert.equal(r.labelBackToDefault, true);
});
check('each change is saved at once; the accent reaches the editor behind it live, and the settings window too', () => {
  assert.equal(r.deckSaved, true);
  assert.equal(r.accentSaved, true);
  assert.equal(r.accentLiveInEditor, true);
  assert.equal(r.accentInSettings, 'purple');
});
check('changing Default deck does not move the editor that is open', () => assert.equal(r.editorStillOnV2, V2));
check('closing the editor closes the settings window with it', () => {
  assert.equal(r.closedToTray, true);
  assert.equal(r.windowsInTray, 0);
});
check('reopened, the editor opens on the Default deck (the XL), in the chosen accent', () => {
  assert.equal(r.reopensOn, XL);
  assert.equal(r.accentAfterReopen, 'purple');
});
check('with the XL unplugged the setting still names it, but the list offers only the V2 and shows Automatic', () => {
  assert.equal(r.unpluggedMovesToV2, true);
  assert.deepEqual(r.unpluggedShown, { options: ['Automatic', 'Deck V2'], value: '' });
  assert.equal(r.unpluggedStillSaved, XL);
});
check('reopened with the XL unplugged it opens on the first connected deck; with the XL back, on the XL', () => {
  assert.equal(r.unpluggedReopensOn, V2);
  assert.equal(r.replugReopensOn, true);
});
check('Reset to defaults puts all three back, on disk, in the window and in the editor', () => {
  assert.equal(r.reset, true);
  assert.equal(r.accentAfterReset, true);
  assert.deepEqual(r.resetShown, ['', true]);
});
check('Done closes the settings window and leaves the editor open', () => assert.equal(r.doneCloses, true));
check('with Close to system tray unticked, closing the editor quits', () => {
  assert.equal(r.trayOffSaved, true);
  assert.equal(r.quitWhenOff, true);
  assert.equal(r.quitCode, 0);
});

stopWatching();
await daemon.stop();
github.close();
// Retries: Electron's helper processes write to userData for a moment after
// the editor exits, so the first rmdir can meet ENOTEMPTY (check:failures did).
await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
