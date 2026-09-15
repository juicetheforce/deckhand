// Check modes, run only when main loads the page with ?check=<name>
// (scripts/check-shared-imports.mjs, scripts/check-bridge.mjs). Not part of
// the editor's normal behaviour.

import { parseCombo } from '../../../src/keymap.js';
import type { StateSnapshot } from '../../../src/control/protocol.js';
import type { DaemonView, DeckhandBridge, SharedImportReport, StoreView } from '../shared/bridge.js';
import { iconUrl } from '../shared/icons.js';

/** Proof 0a: the daemon's keymap runs in the renderer, and a protocol type compiles here. */
function sharedImports(): SharedImportReport {
  const snapshot: StateSnapshot = { activeProfile: { id: 'default', name: 'Default' }, decks: [] };
  const profileId = snapshot.activeProfile?.id ?? 'none';
  try {
    return { parseCombo: parseCombo('ctrl+1'), protocolTypeUsed: profileId };
  } catch (err) {
    return { parseCombo: [], protocolTypeUsed: profileId, error: (err as Error).message };
  }
}

function waitFor<T>(subscribe: (cb: (v: T) => void) => () => void, first: T, condition: (v: T) => boolean, ms = 10_000): Promise<T> {
  if (condition(first)) return Promise.resolve(first);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    const stop = subscribe((v) => {
      if (!condition(v)) return;
      clearTimeout(timer);
      stop();
      resolve(v);
    });
  });
}

/**
 * Step 2: every bridge call, end to end through the preload and main process,
 * against a real config file and the test daemon. The Node side of
 * scripts/check-bridge.mjs checks the file and the fake deck afterwards.
 */
async function bridge(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  // Pushed events are recorded separately from snapshots: a check that only
  // read snapshots passed with the preload dropping every daemon event.
  const daemonEvents: DaemonView[] = [];
  const storeEvents: StoreView[] = [];
  api.onDaemon((v) => daemonEvents.push(v));
  api.onStore((v) => storeEvents.push(v));
  const eventually = async (condition: () => boolean, ms = 3000) => {
    const started = Date.now();
    while (!condition() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 25));
    return condition();
  };
  const snap = await api.snapshot();
  out.storeOpen = snap.store.open;

  const daemon = await waitFor<DaemonView>(api.onDaemon, snap.daemon, (v) => v.connected);
  out.daemonConnected = daemon.connected;
  out.decks = (daemon.decks ?? []).map((d) => ({ serial: d.serial, keyCount: d.keyCount, rows: d.rows, columns: d.columns }));
  const serial = daemon.decks?.[0]?.serial ?? '';
  if (!snap.store.open) return { ...out, error: snap.store.error };

  const profile = Object.keys(snap.store.state.config.profiles)[0];
  const added = await api.apply({ kind: 'addPage', profile, serial, name: 'Bridge page' });
  out.addPage = added;
  const page = added.ok ? added.result.pageId! : '';
  out.setAction = await api.apply({ kind: 'setAction', at: { profile, serial, page, index: 2 }, action: { type: 'hotkey', keys: 'ctrl+2' } });
  out.badEdit = await api.apply({ kind: 'setAction', at: { profile, serial, page: 'no-such-page', index: 0 }, action: { type: 'noop' } });

  const saved = await waitFor<StoreView>(api.onStore, (await api.snapshot()).store, (v) => v.open && !v.state.dirty);
  out.savedThroughAutosave = saved.open && !saved.state.dirty;

  out.previewSet = await api.previewSet(serial, 3, { label: 'bridge preview', background: '#00ff00' });
  out.previewBadKey = await api.previewSet(serial, 999, { label: 'x' });
  const withPreview = await waitFor<DaemonView>(api.onDaemon, (await api.snapshot()).daemon, (v) =>
    (v.status?.decks.find((d) => d.serial === serial)?.previews ?? []).includes(3),
  );
  out.previewInState = (withPreview.status?.decks.find((d) => d.serial === serial)?.previews ?? []).includes(3);
  out.daemonEventPushed = await eventually(() =>
    daemonEvents.some((v) => (v.status?.decks.find((d) => d.serial === serial)?.previews ?? []).includes(3)),
  );
  out.storeEventPushed = await eventually(() => storeEvents.some((v) => v.open && !v.state.dirty));

  // The icon protocol (step 3): an image loads; a non-image file in the same
  // folder and a missing image do not; page script cannot read icons as bytes.
  const icon = snap.store.state.config.profiles[profile].layouts[serial].pages.main?.buttons['0']?.icon;
  const loads = (url: string) =>
    new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve(-1);
      img.src = url;
    });
  if (icon) {
    out.iconImageWidth = await loads(iconUrl(icon));
    out.iconTextFile = await loads(iconUrl(icon.replace(/dot\.png$/, 'secret.txt')));
    out.iconMissing = await loads(iconUrl(icon.replace(/dot\.png$/, 'absent.png')));
    try {
      await fetch(iconUrl(icon));
      out.iconFetch = 'allowed';
    } catch (err) {
      out.iconFetch = `refused: ${(err as Error).message}`;
    }
  }

  // Left for the quit: an edit made just before quitting must still be written.
  out.lastEdit = await api.apply({ kind: 'setLabel', at: { profile, serial, page, index: 2 }, label: 'written on quit' });
  return out;
}

/**
 * Step 3: let the shell render against the test daemon, optionally select a
 * key, wait for icons to load, and report what is on screen; main then
 * captures the window (scripts/screenshot.mjs).
 */
async function screenshot(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const snap = await api.snapshot();
  await waitFor<DaemonView>(api.onDaemon, snap.daemon, (v) => v.connected && (v.decks?.length ?? 0) > 0);
  const started = Date.now();
  while (!document.querySelector('.grid') && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
  const deck = new URLSearchParams(window.location.search).get('selectDeck');
  if (deck !== null) {
    // Choose the device the way a user does: change the Device dropdown.
    const select = document.querySelectorAll<HTMLSelectElement>('.toolbar select')[1];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, deck);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  }
  const selectIndex = new URLSearchParams(window.location.search).get('selectKey');
  if (selectIndex !== null) (document.querySelectorAll<HTMLButtonElement>('.key')[Number(selectIndex)])?.click();
  if (new URLSearchParams(window.location.search).get('selectTab') === 'icon') {
    await new Promise((r) => setTimeout(r, 200));
    [...document.querySelectorAll<HTMLButtonElement>('.inspector-tab')].find((b) => b.textContent === 'Icon')?.click();
    const opened = Date.now();
    while (document.querySelectorAll('.picker-item').length === 0 && Date.now() - opened < 5000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
  }
  const images = [...document.querySelectorAll<HTMLImageElement>('img')];
  const settled = (img: HTMLImageElement) =>
    new Promise<void>((resolve) => {
      if (img.complete) return resolve();
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  // Lazy-loaded thumbnails below the fold never load, so waiting for every image would hang (seen with the icon picker); wait at most 5 s.
  // Only images inside the window are waited for: lazy thumbnails below the fold never load.
  const inView = images.filter((img) => {
    const rect = img.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  });
  const settleStarted = performance.now();
  await Promise.race([Promise.all(inView.map(settled)), new Promise((r) => setTimeout(r, 5000))]);
  const settleMs = Math.round(performance.now() - settleStarted);
  await new Promise((r) => setTimeout(r, 300));
  return {
    selectKeyParam: selectIndex,
    selected: [...document.querySelectorAll('.key-selected')].map((k) => k.getAttribute('aria-label')),
    inspectorTitle: document.querySelector('.inspector-title')?.textContent ?? null,
    keys: document.querySelectorAll('.key').length,
    kinds: Object.fromEntries(['empty', 'unbound', 'hotkey', 'other'].map((k) => [k, document.querySelectorAll(`.key-${k}`).length])),
    images: images.length,
    unsettledImages: images.filter((img) => !img.complete).length,
    /** Time for the images inside the window to finish loading, capped at 5 s. */
    settleMs,
    imagesInView: inView.length,
    loadedImages: images.filter((img) => img.complete && img.naturalWidth > 0).length,
    brokenImages: images.filter((img) => img.naturalWidth === 0).map((img) => decodeURIComponent(img.src.split('path=')[1] ?? img.src)),
    notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent?.slice(0, 80)),
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
  };
}

/**
 * Live switching (scope §10), driven through the real UI: clicks, the
 * profile dropdown, "+ Page". scripts/check-live.mjs runs the harness daemon,
 * moves the deck itself once (standing in for a deck press) and checks the
 * deck afterwards.
 */
async function live(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 8000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const selectedTab = () => document.querySelector('.tab-selected')?.textContent ?? null;
  const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent === label);
  const deck = async () => (await api.snapshot()).daemon.status?.decks[0];
  const chooseProfile = (id: string) => {
    const select = document.querySelectorAll<HTMLSelectElement>('.toolbar select')[0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Record every tab the breadcrumb shows, to catch it jumping back mid-switch.
  const tabHistory: string[] = [];
  const observer = new MutationObserver(() => {
    const t = selectedTab();
    if (t !== null && tabHistory[tabHistory.length - 1] !== t) tabHistory.push(t);
  });

  await until(() => document.querySelector('.grid') !== null);
  out.opensOn = { tab: selectedTab(), deck: await deck() };
  observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });

  // 1. A page tab shows that page on the deck.
  tabHistory.length = 0;
  tab('Second')!.click();
  out.tabShowsPage = await until(async () => (await deck())?.page === 'second');
  await sleep(300);
  out.tabHistoryDuringSwitch = [...tabHistory];

  // 2. The profile dropdown switches the decks; the breadcrumb lands on the new start page.
  tabHistory.length = 0;
  chooseProfile('other');
  out.profileSwitches = await until(async () => {
    const d = await deck();
    return d?.profile === 'other' && d.page === 'hotbar' && selectedTab() === 'Hotbar';
  });
  await sleep(300);
  out.tabHistoryDuringProfileSwitch = [...tabHistory];
  chooseProfile('default');
  out.profileSwitchesBack = await until(async () => {
    const d = await deck();
    return d?.profile === 'default' && d.page === 'main' && selectedTab() === 'Main';
  });

  // 3. A page added through "+ Page" is selected and shown on the deck (save, reload, then show).
  [...document.querySelectorAll<HTMLButtonElement>('.tab-add')][0].click();
  await until(() => document.querySelector('.add-page input') !== null);
  const input = document.querySelector<HTMLInputElement>('.add-page input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Live page');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  out.addedPageShown = await until(async () => {
    const d = await deck();
    return selectedTab() === 'Live page' && d?.page !== undefined && d.page.startsWith('pg_');
  }, 10_000);
  out.addedPageId = (await deck())?.page;

  // 4. Signal the check script (a preview on key 0, which it can see) to move
  //    the deck to Main by itself; the breadcrumb must follow.
  const serial = (await deck())!.serial;
  out.tabBeforePress = selectedTab();
  await api.previewSet(serial, 0, { label: 'press now' });
  out.followsDeck = await until(() => selectedTab() === 'Main', 10_000);
  await api.previewClear(serial, 0);

  // 5. Leave the deck on Second, then quit: closing must not change it.
  tab('Second')!.click();
  out.leftOnSecond = await until(async () => (await deck())?.page === 'second');
  observer.disconnect();
  return out;
}

/**
 * Step 4: the hotkey inspector, through the real UI, with synthetic key
 * events (capture reads event.code and the modifier flags, which synthetic
 * events carry). scripts/check-hotkey.mjs puts a fake busctl on PATH that
 * reports ctrl+f1 as a KWin shortcut, and checks the saved file afterwards.
 */
async function hotkey(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 5000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  const click = async (text: string) => {
    if (!(await until(() => button(text) !== undefined && !button(text)!.disabled))) throw new Error(`no enabled button "${text}"`);
    button(text)!.click();
  };
  const selectKey = async (index: number) => {
    await until(() => document.querySelectorAll('.key').length > index);
    document.querySelectorAll<HTMLButtonElement>('.key')[index].click();
    await until(() => document.querySelector('.inspector-title')?.textContent === `Key ${index + 1}`);
  };
  /** Dispatch a key event; returns true if it was swallowed (preventDefault). */
  const press = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}, type = 'keydown') =>
    !window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...mods }));
  const typeInto = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const saved = async () => {
    const s = (await api.snapshot()).store;
    if (!s.open || s.state.dirty) return null;
    const c = s.state.config;
    const p = Object.values(c.profiles)[0];
    return Object.values(p.layouts)[0].pages.main.buttons;
  };
  const listening = () => document.querySelector('.listening') !== null;
  const text = () => document.querySelector('.inspector')?.textContent ?? '';

  await until(() => document.querySelector('.grid') !== null);

  // 1. Record ctrl+1 on an empty key; the key events are swallowed.
  await selectKey(3);
  await click('Record hotkey');
  out.listeningShown = await until(listening);
  const swallowCtrl = press('ControlLeft', { ctrlKey: true });
  out.heldShown = await until(() => [...document.querySelectorAll('.listening kbd')].some((k) => k.textContent === 'Ctrl'));
  const swallowOne = press('Digit1', { ctrlKey: true });
  out.swallowed = swallowCtrl && swallowOne;
  out.recorded = await until(async () => (await saved())?.['3']?.action?.keys === 'ctrl+1');

  // 2. Cancel stops listening and changes nothing; Esc is recorded like any other key.
  await click('Re-record');
  await until(listening);
  await click('Cancel');
  out.cancelChangesNothing = (await until(() => !listening())) && (await saved())?.['3']?.action?.keys === 'ctrl+1';
  await click('Re-record');
  await until(listening);
  out.escSwallowed = press('Escape');
  out.escRecorded = await until(async () => (await saved())?.['3']?.action?.keys === 'esc');

  // 3. A KDE shortcut asks first. "Choose another" saves nothing; "Use it anyway" saves.
  await click('Re-record');
  await until(listening);
  press('F1', { ctrlKey: true });
  out.confirmShown = await until(() => document.querySelector('.confirm') !== null);
  out.confirmText = document.querySelector('.confirm p')?.textContent;
  await click('Choose another');
  await until(listening);
  await click('Cancel');
  await sleep(600);
  out.chooseAnotherSavedNothing = (await saved())?.['3']?.action?.keys === 'esc';
  await click('Re-record');
  await until(listening);
  press('F1', { ctrlKey: true });
  await until(() => document.querySelector('.confirm') !== null);
  await click('Use it anyway');
  out.useAnywaySaved = await until(async () => (await saved())?.['3']?.action?.keys === 'ctrl+f1');
  out.savedWarningShown = await until(() => text().includes('Ctrl+F1 is a system shortcut (KWin).'));

  // 4. Type manually: the daemon-misread "ctrl++" is refused; "Control + F13" is saved as ctrl+f13, with the layout note.
  await click('Type manually');
  await until(() => document.querySelector('.typing input') !== null);
  typeInto(document.querySelector<HTMLInputElement>('.typing input')!, 'ctrl++');
  await click('Save');
  out.typedRefusal = (await until(() => document.querySelector('.typing .field-error') !== null)) ? document.querySelector('.typing .field-error')!.textContent : null;
  typeInto(document.querySelector<HTMLInputElement>('.typing input')!, 'Control + F13');
  await click('Save');
  out.typedSaved = await until(async () => (await saved())?.['3']?.action?.keys === 'ctrl+f13');
  out.remapNoteShown = await until(() => text().includes('F13 may not reach the game'));

  // 5. A key with no name says so, and saves nothing.
  await click('Re-record');
  await until(listening);
  press('IntlBackslash');
  out.unknownKeyMessage = await until(() => text().includes('has no name Deckhand can send'));
  await click('Cancel');
  await until(() => !listening());

  // 6. Label, then "Clear hotkey" keeps it.
  typeInto(document.querySelector<HTMLInputElement>('.label-input')!, 'Bolt');
  out.labelSaved = await until(async () => (await saved())?.['3']?.label === 'Bolt');
  await click('Clear hotkey');
  out.clearHotkeyKeepsLabel = await until(async () => {
    const b = (await saved())?.['3'];
    return b !== undefined && b.action === undefined && b.label === 'Bolt';
  });

  // 7. The library's Hotkey entry starts listening on the selected key.
  await selectKey(4);
  [...document.querySelectorAll<HTMLButtonElement>('.library-entry')].find((b) => b.textContent?.startsWith('Hotkey'))!.click();
  out.libraryStartsListening = await until(listening);
  await click('Cancel');
  await until(() => !listening());

  // 8. Keys whose action is read-only: no recording; the label still edits.
  await selectKey(0);
  out.mediaReadOnly = button('Record hotkey') === undefined && button('Re-record') === undefined;
  typeInto(document.querySelector<HTMLInputElement>('.label-input')!, 'Next track');
  out.mediaLabelSaved = await until(async () => (await saved())?.['0']?.label === 'Next track');
  await selectKey(1);
  out.sequenceReadOnly = button('Record hotkey') === undefined && button('Re-record') === undefined;

  // 9. "Clear button" removes the whole key.
  await selectKey(2);
  await click('Clear button');
  out.clearButtonRemoves = await until(async () => {
    const b = await saved();
    return b !== null && b['2'] === undefined;
  });

  return out;
}

/**
 * Step 5: the icon picker, through the real UI. scripts/check-icons.mjs runs
 * the harness daemon with HOME pointed at a scratch icon tree, writes a file
 * into the open folder when this check signals for it (a preview on key 31),
 * and checks the saved config, the recent-folders file and the deck afterwards.
 */
async function icons(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 5000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
  const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
  const click = async (text: string) => {
    if (!(await until(() => button(text) !== undefined && !button(text)!.disabled))) throw new Error(`no enabled button "${text}"`);
    button(text)!.click();
  };
  const selectKey = async (index: number) => {
    await until(() => document.querySelectorAll('.key').length > index);
    document.querySelectorAll<HTMLButtonElement>('.key')[index].click();
    await until(() => document.querySelector('.inspector-title')?.textContent === `Key ${index + 1}`);
  };
  const typeInto = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const snap = await api.snapshot();
  const serial = snap.daemon.decks?.[0]?.serial ?? '';
  const saved = async () => {
    const s = (await api.snapshot()).store;
    if (!s.open || s.state.dirty) return null;
    return Object.values(Object.values(s.state.config.profiles)[0].layouts)[0].pages.main.buttons;
  };
  const previews = async () => (await api.snapshot()).daemon.status?.decks.find((d) => d.serial === serial)?.previews ?? [];
  const names = () => [...document.querySelectorAll('.picker-item .picker-name')].map((n) => n.textContent);
  const item = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.picker-item')].find((i) => i.querySelector('.picker-name')?.textContent === name);
  const clickItem = async (name: string) => {
    if (!(await until(() => item(name) !== undefined))) throw new Error(`no picker item "${name}"; have ${JSON.stringify(names())}`);
    item(name)!.click();
  };
  const crumbs = () => [...document.querySelectorAll('.picker-crumb')].map((c) => c.textContent).join('/');
  const selectedName = () => document.querySelector('.picker-item-selected .picker-name')?.textContent ?? null;
  const gridKey = (key: string) => document.querySelector('.picker-grid')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const iconOf = async (key: string) => (await saved())?.[key]?.icon;

  await waitFor<DaemonView>(api.onDaemon, snap.daemon, (v) => v.connected && (v.decks?.length ?? 0) > 0);
  await until(() => document.querySelector('.grid') !== null);

  // 1. With no icon and no recent folder, the picker would open on Pictures.
  out.startWithNothing = await api.iconStartFolder(null);

  // 2. The grid draws a key whose icon cannot be read with the built-in missing icon, loaded under the page's CSP.
  out.missingInGrid = await until(() => {
    const img = document.querySelectorAll('.key')[2]?.querySelector<HTMLImageElement>('.key-icon-missing');
    return img !== null && img !== undefined && img.src.includes('missing') && img.complete && img.naturalWidth > 0;
  });
  out.goodIconNotMissing = document.querySelectorAll('.key')[1]?.querySelector('.key-icon-missing') === null;

  // 3. The Icon tab opens on the folder of the key's icon, marks it, lists subfolders first.
  await selectKey(1);
  await click('Icon');
  await until(() => crumbs().endsWith('BEAR') && names().length >= 3);
  out.openedOn = crumbs();
  out.blmItems = names();
  out.currentMarked = [...document.querySelectorAll('.picker-item-current .picker-name')].map((n) => n.textContent);

  // 4. Selecting an image previews it on the deck and saves nothing.
  await clickItem('Flame_IV.png');
  out.previewShown = await until(async () => (await previews()).includes(1));
  out.previewNotSaved = (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Bolt_III.png';

  // 5. Arrow keys move the selection (and the preview).
  gridKey('ArrowLeft');
  out.arrowLeft = await until(() => selectedName() === 'Bolt_III.png');
  gridKey('ArrowRight');
  out.arrowRight = await until(() => selectedName() === 'Flame_IV.png');

  // 6. Use this icon saves the path as ~/..., clears the preview after the reload, and remembers the folder.
  await click('Use this icon');
  out.usedSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Flame_IV.png');
  out.previewClearedOnUse = await until(async () => !(await previews()).includes(1));
  out.recentChip = await until(() => [...document.querySelectorAll('.chip')].some((c) => c.textContent === 'BEAR'));
  out.useDisabledOnCurrent = await until(() => button('Use this icon')?.disabled === true);

  // 7. Double-click chooses.
  await until(() => item('Bolt_III.png') !== undefined);
  item('Bolt_III.png')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  out.doubleClickSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Bolt_III.png');

  // 8. The open folder is watched: ask the script to add a file (signal: a preview on key 31), and it appears.
  out.newFileAbsentBefore = !names().includes('Frost.png');
  await api.previewSet(serial, 31, { label: 'WRITE-FILE' });
  out.watcherShowedNewFile = await until(() => names().includes('Frost.png'), 10_000);
  await api.previewClear(serial, 31);

  // 9. The breadcrumb goes up; files the editor does not show are left out.
  await click('icons');
  await until(() => crumbs().endsWith('icons') && names().includes('FFXIV'));
  out.rootItems = names();

  // 10. The filter searches below the open folder and says where each match lives; clicking that opens it.
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, 'aura');
  out.filterFound = await until(() => names().join() === 'Aura.png');
  out.filterWhere = document.querySelector('.picker-where')?.textContent;
  (document.querySelector<HTMLElement>('.picker-where'))?.click();
  out.whereOpens = await until(() => crumbs().endsWith('Shared_Actions') && document.querySelector<HTMLInputElement>('.picker-filter')!.value === '');

  // 11. Enter chooses; a path with spaces and parentheses is stored as it is.
  await click('icons');
  await until(() => crumbs().endsWith('icons'));
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, 'halo');
  await clickItem('Halo (Area).png');
  await until(async () => (await previews()).includes(1));
  gridKey('Enter');
  out.enterSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/FFXIV/WOLF/Halo (Area).png');
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, '');
  await until(() => names().includes('corrupt.png'));

  // 12. A file the deck cannot draw: refused by the daemon, marked, cannot be chosen; its thumbnail is the missing icon.
  // Wait for the picker to be idle first: while the previous choice is still
  // settling every button is disabled, which would pass this check for the
  // wrong reason (a deliberate break found that).
  await until(() => button('Remove icon')?.disabled === false);
  await clickItem('corrupt.png');
  out.corruptRefused = await until(() => document.querySelector('.picker .field-error')?.textContent?.includes('cannot draw') === true);
  out.useDisabledForRefused = button('Use this icon')?.disabled === true && button('Remove icon')?.disabled === false;
  out.corruptThumbMissing = await until(() => item('corrupt.png')?.querySelector('img')?.src.includes('missing') === true);

  // 13. Leaving the tab ends the preview.
  await clickItem('back ground.png');
  await until(async () => (await previews()).includes(1));
  await click('Key');
  out.tabClears = await until(async () => !(await previews()).includes(1));
  out.keyTabShowsPath = document.querySelector('.inspector .path')?.textContent;

  // 14. Selecting another key ends the preview; the picker stays in the same folder.
  await click('Icon');
  await clickItem('fishing.png');
  await until(async () => (await previews()).includes(1));
  await selectKey(0);
  out.keyChangeClears = await until(async () => !(await previews()).includes(1));
  out.placeKept = await until(() => crumbs().endsWith('icons') && names().includes('fishing.png'));

  // 15. A page change ends the preview — even one still in flight: the thumbnail
  // and the page tab are clicked in the same tick, so the picker is gone before
  // the preview's reply arrives (this ordering was a real bug, seen once by luck).
  await until(() => item('fishing.png') !== undefined);
  item('fishing.png')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.tab')].find((b) => b.textContent === 'Second')!.click();
  await sleep(500);
  out.pageChangeClears = await until(async () => !(await previews()).includes(0));
  [...document.querySelectorAll<HTMLButtonElement>('.tab')].find((b) => b.textContent === 'Main')!.click();
  await until(async () => (await api.snapshot()).daemon.status?.decks.find((d) => d.serial === serial)?.page === 'main');

  // 16. A key's icon file renamed away, then back, reaches the grid with no
  // navigation at all (the maintainer saw the stale icon on the real decks). The script
  // renames when it sees a preview on key 30 (away) and key 29 (back).
  const keyIcon = () => document.querySelectorAll('.key')[1]?.querySelector<HTMLImageElement>('img');
  const iconIsMissing = () => keyIcon()?.src.includes('missing') === true && keyIcon()?.classList.contains('key-icon-missing') === true;
  await selectKey(1);
  if (!document.querySelector('.picker')) await click('Icon');
  await until(() => button('Remove icon')?.disabled === false);
  await clickItem('back ground.png');
  await click('Use this icon');
  await until(async () => (await iconOf('1')) === '~/Pictures/icons/back ground.png');
  out.iconShownBeforeRename = await until(() => keyIcon() !== undefined && keyIcon()!.complete && keyIcon()!.naturalWidth > 0 && !iconIsMissing());
  await api.previewSet(serial, 30, { label: 'RENAME-AWAY' });
  out.renameAwayShowsMissing = await until(() => iconIsMissing(), 10_000);
  await api.previewClear(serial, 30);
  await api.previewSet(serial, 29, { label: 'RENAME-BACK' });
  out.renameBackShowsIcon = await until(() => keyIcon() !== undefined && !iconIsMissing() && keyIcon()!.complete && keyIcon()!.naturalWidth > 0, 10_000);
  await api.previewClear(serial, 29);

  // 17. Remove icon removes only the icon.
  await selectKey(1);
  if (!document.querySelector('.picker')) await click('Icon');
  await click('Remove icon');
  out.removeKeepsAction = await until(async () => {
    const b = (await saved())?.['1'];
    return b !== undefined && b.icon === undefined && b.action?.keys === 'ctrl+2';
  });
  out.removeButtonGone = await until(() => button('Remove icon') === undefined);
  out.notConnectedNoteShown = document.body.textContent?.includes('not connected, so icons are not shown') ?? false;
  return out;
}

export async function runCheck(name: string, api: DeckhandBridge): Promise<void> {
  try {
    if (name === 'shared') api.reportCheck(name, sharedImports());
    else if (name === 'bridge') api.reportCheck(name, await bridge(api));
    else if (name === 'screenshot') api.reportCheck(name, await screenshot(api));
    else if (name === 'live') api.reportCheck(name, await live(api));
    else if (name === 'hotkey') api.reportCheck(name, await hotkey(api));
    else if (name === 'icons') api.reportCheck(name, await icons(api));
    else api.reportCheck(name, { error: `unknown check "${name}"` });
  } catch (err) {
    api.reportCheck(name, { error: (err as Error).stack ?? String(err) });
  }
}
