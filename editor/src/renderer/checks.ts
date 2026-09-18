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

/** Open the "+" menu and pick one of its two items (Toolbar's AddMenu). */
async function openAddMenu(item: 'New page' | 'New profile'): Promise<void> {
  document.querySelector<HTMLButtonElement>('.tab-add')!.click();
  await new Promise((r) => setTimeout(r, 80));
  [...document.querySelectorAll<HTMLButtonElement>('.tab-menu-item')].find((b) => b.textContent?.startsWith(item))!.click();
  await new Promise((r) => setTimeout(r, 120));
}

/** Right-click a page tab and pick from its menu — the only way in since the "⋯" went. */
async function openTabMenu(page: string, item: 'Rename page' | 'Delete page'): Promise<void> {
  const tab = document.querySelector<HTMLButtonElement>(`.tab[data-tab="${page}"]`)!;
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));
  [...document.querySelectorAll<HTMLButtonElement>('.tab-menu-item')].find((b) => b.textContent?.startsWith(item))!.click();
  await new Promise((r) => setTimeout(r, 120));
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
  const wantPage = new URLSearchParams(window.location.search).get('page');
  if (wantPage !== null) {
    document.querySelector<HTMLButtonElement>(`.tab[data-tab="${wantPage}"]`)?.click();
    await new Promise((r) => setTimeout(r, 400));
  }
  const selectIndex = new URLSearchParams(window.location.search).get('selectKey');
  // "3" selects one key; "3,4,5" Ctrl+clicks the rest in (B3's multi-select).
  const selectIndices = selectIndex === null ? [] : selectIndex.split(',').map(Number);
  for (const [n, index] of selectIndices.entries()) {
    document.querySelectorAll<HTMLButtonElement>('.key')[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: n > 0 }));
    await new Promise((r) => setTimeout(r, 50));
  }
  if (new URLSearchParams(window.location.search).get('selectTab') === 'icon') {
    await new Promise((r) => setTimeout(r, 200));
    [...document.querySelectorAll<HTMLButtonElement>('.inspector-tab')].find((b) => b.textContent === 'Icon')?.click();
    const opened = Date.now();
    while (document.querySelectorAll('.picker-item').length === 0 && Date.now() - opened < 5000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
  }
  const search = new URLSearchParams(window.location.search).get('search');
  if (search !== null) {
    const box = document.querySelector<HTMLInputElement>('.library-header input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, search);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  }

  // B1's panels, so they can be looked at (scope §7, phase B).
  const open = new URLSearchParams(window.location.search).get('open');
  if (open === 'newprofile') {
    await openAddMenu('New profile');
  } else if ((open === 'keymenu' || open === 'keymenu-device' || open === 'keymenu-page') && selectIndices.length > 0) {
    // B3's right-click menu, on the last selected key.
    const key = document.querySelectorAll<HTMLButtonElement>('.key')[selectIndices[selectIndices.length - 1]];
    const rect = key.getBoundingClientRect();
    key.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    await new Promise((r) => setTimeout(r, 200));
    const expand = open === 'keymenu-device' ? 'Copy to device' : open === 'keymenu-page' ? 'Copy to page' : null;
    if (expand) {
      [...document.querySelectorAll<HTMLButtonElement>('.key-menu-item')].find((b) => b.querySelector('span')?.textContent === expand)?.click();
      await new Promise((r) => setTimeout(r, 200));
    }
  } else if (open === 'delete') {
    const shown = document.querySelector('.tab-selected')?.getAttribute('data-tab');
    if (shown) await openTabMenu(shown, 'Delete page');
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
    openParam: open,
    librarySections: [...document.querySelectorAll('.library-toggle')].map((b) => b.textContent),
    libraryResults: [...document.querySelectorAll('.library-results .library-name')].map((n) => n.textContent),
    libraryResultGroups: [...document.querySelectorAll('.library-result-group')].map((n) => n.textContent),
    newProfileDecks: [...document.querySelectorAll('.deck-ticks label')].map((l) => l.textContent),
    confirmCard: document.querySelector('.confirm-card')?.textContent?.slice(0, 200) ?? null,
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
  const selectedTab = () => document.querySelector('.tab-selected')?.getAttribute('data-tab') ?? null;
  const tab = (label: string) => document.querySelector<HTMLButtonElement>(`.tab[data-tab="${label}"]`) ?? undefined;
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
  await openAddMenu('New page');
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
  // 7b. Leaving the Key tab while listening stops it: a key pressed on the Icon
  //     tab is neither swallowed nor recorded, and coming back does not listen again.
  [...document.querySelectorAll<HTMLButtonElement>('.inspector-tab')].find((b) => b.textContent === 'Icon')!.click();
  await until(() => document.querySelector('.picker') !== null);
  const before = JSON.stringify((await saved())?.['4'] ?? null);
  out.iconTabNotSwallowed = !press('KeyQ', { ctrlKey: true });
  await sleep(300);
  out.iconTabNotRecorded = JSON.stringify((await saved())?.['4'] ?? null) === before;
  [...document.querySelectorAll<HTMLButtonElement>('.inspector-tab')].find((b) => b.textContent === 'Key')!.click();
  await until(() => document.querySelector('.label-input') !== null);
  await sleep(200);
  out.backOnKeyTabNotListening = !listening();
  // And the library pick still starts listening after that.
  [...document.querySelectorAll<HTMLButtonElement>('.library-entry')].find((b) => b.textContent?.startsWith('Hotkey'))!.click();
  out.libraryListensAgain = await until(listening);
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
 * and checks the saved config, the editor's preferences file and the deck
 * afterwards.
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
  /** Open a folder from the path field, opening the elided middle out first if that segment is hidden. */
  const openCrumb = async (name: string) => {
    if (button(name) === undefined && document.querySelector('.crumb-ellipsis') !== null) await click('…');
    await click(name);
  };
  const selectedName = () => document.querySelector('.picker-item-selected .picker-name')?.textContent ?? null;
  const gridKey = (key: string) => document.querySelector('.picker-grid')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const iconOf = async (key: string) => (await saved())?.[key]?.icon;

  await waitFor<DaemonView>(api.onDaemon, snap.daemon, (v) => v.connected && (v.decks?.length ?? 0) > 0);
  await until(() => document.querySelector('.grid') !== null);

  // 1. With no icon set, the picker opens at the newest bookmark (Pictures when there are none — test/icon-picker.test.ts).
  out.startWithNothing = await api.iconStartFolder(null);

  // 2. The grid draws a key whose icon cannot be read with the built-in missing icon, loaded under the page's CSP.
  out.missingInGrid = await until(() => {
    const img = document.querySelectorAll('.key')[2]?.querySelector<HTMLImageElement>('.key-icon-missing');
    return img !== null && img !== undefined && img.src.includes('missing') && img.complete && img.naturalWidth > 0;
  });
  out.goodIconNotMissing = document.querySelectorAll('.key')[1]?.querySelector('.key-icon-missing') === null;

  // 2b. Default icons (C2): key 0 has an action and no icon, so the grid draws
  //     its built-in default, loaded through the icon protocol; the library's
  //     rows draw theirs.
  const loadedDefault = (index: number, name: string) => {
    const img = document.querySelectorAll('.key')[index]?.querySelector<HTMLImageElement>('img.key-icon');
    return !!img && !img.classList.contains('key-icon-missing') && decodeURIComponent(img.src).includes(`path=builtin:${name}`) && img.complete && img.naturalWidth > 0;
  };
  out.defaultInGrid = await until(() => loadedDefault(0, 'key-combo'));
  out.libraryIconsLoaded = await until(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('img.library-icon')];
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  });
  out.libraryIcons = [...document.querySelectorAll<HTMLImageElement>('img.library-icon')].map((i) => i.dataset.icon);

  // 3. The Icon tab opens on the folder of the key's icon, marks it, lists subfolders first.
  await selectKey(1);
  await click('Icon');
  await until(() => crumbs().endsWith('BEAR') && names().length >= 3);
  out.openedOn = crumbs();
  out.blmItems = names();
  out.currentMarked = [...document.querySelectorAll('.picker-item-current .picker-name')].map((n) => n.textContent);

  // 4. Selecting an image chooses it (the maintainer, 2026-09-16): saved as ~/..., the
  //    grid shows it, and the deck's preview is cleared once the daemon has
  //    reloaded — so the deck, the grid and the file agree. No Assign.
  const gridIcon = (index: number) => document.querySelectorAll('.key')[index]?.querySelector<HTMLImageElement>('img.key-icon')?.src ?? '';
  await clickItem('Flame_IV.png');
  out.selectSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Flame_IV.png');
  out.gridAgrees = await until(() => decodeURIComponent(gridIcon(1)).includes('Flame_IV.png'));
  out.previewClearedAfterSave = await until(async () => !(await previews()).includes(1));
  out.noAssign = button('Assign') === undefined && button('Cancel') === undefined;

  // 5. Arrow keys move the selection, and so choose.
  gridKey('ArrowLeft');
  out.arrowLeft = await until(async () => selectedName() === 'Bolt_III.png' && (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Bolt_III.png');
  gridKey('ArrowRight');
  out.arrowRight = await until(async () => selectedName() === 'Flame_IV.png' && (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Flame_IV.png');
  out.bookmarksSeeded = [...document.querySelectorAll('.picker-bookmarks .chip')].map((c) => c.textContent?.trim());

  // 6b. Bookmarks (mockup 5a): the open folder can be kept, and removed again.
  await click('+ Bookmark this folder');
  out.bookmarkAdded = await until(() => [...document.querySelectorAll('.picker-bookmarks .chip')].some((c) => c.textContent?.includes('BEAR')));
  out.bookmarkButtonTurnsIntoRemove = button('− Remove bookmark') !== undefined && button('+ Bookmark this folder') === undefined;

  // 7. Choices faster than saves: the last one wins, including going back to
  //    the key's own icon before another choice has saved (which an early
  //    "already the current icon" skip got wrong).
  await sleep(700);
  item('Bolt_III.png')!.click();
  item('Flame_IV.png')!.click();
  await sleep(1500);
  out.lastChoiceWins = (await iconOf('1')) === '~/Pictures/icons/FFXIV/BEAR/Flame_IV.png';

  // 8. The open folder is watched: ask the script to add a file (signal: a preview on key 31), and it appears.
  out.newFileAbsentBefore = !names().includes('Frost.png');
  await api.previewSet(serial, 31, { label: 'WRITE-FILE' });
  out.watcherShowedNewFile = await until(() => names().includes('Frost.png'), 10_000);
  await api.previewClear(serial, 31);

  // 8b. Back, forward and up (mockup 5a), and the count on a folder tile.
  const crumbNow = () => document.querySelector('.picker-crumb-here')?.textContent;
  await click('↑');
  out.upWentToParent = await until(() => crumbNow() === 'FFXIV');
  out.backEnabled = button('←')?.disabled === false;
  await click('←');
  out.backReturned = await until(() => crumbNow() === 'BEAR');
  await click('→');
  out.forwardWentOn = await until(() => crumbNow() === 'FFXIV');
  out.folderCounts = [...document.querySelectorAll('.picker-folder')].map(
    (f) => `${f.querySelector('.picker-name')?.textContent}=${f.querySelector('.picker-count')?.textContent}/${f.querySelector('.picker-count')?.getAttribute('title')}`,
  );
  await click('↻');
  out.refreshKeptFolder = await until(() => crumbNow() === 'FFXIV' && document.querySelectorAll('.picker-item').length > 0);
  const gridTracks = () => getComputedStyle(document.querySelector('.picker-grid')!).gridTemplateColumns.split(' ').map((c) => Math.round(parseFloat(c)));
  /** Track sizes once they stop changing: a resize settles over a frame or two. */
  const settledTracks = async () => {
    let previous = gridTracks();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const now = gridTracks();
      if (now.length === previous.length && now[0] === previous[0]) return { columns: now.length, tile: now[0] };
      previous = now;
    }
    return { columns: previous.length, tile: previous[0] };
  };
  out.gridColumns = (await settledTracks()).columns;
  out.tileWidth = (await settledTracks()).tile;

  // Narrowing the pane must drop a column, not shrink the tiles (the maintainer, 2026-09-15).
  const inspectorDivider = document.querySelectorAll<HTMLElement>('.pane-divider')[1];
  const dragDivider = async (dx: number) => {
    const box = inspectorDivider.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const options = { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1 };
    inspectorDivider.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: x }));
    inspectorDivider.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: x + dx }));
    inspectorDivider.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: x + dx, buttons: 0 }));
    return settledTracks();
  };
  const widths = [await settledTracks()];
  widths.push(await dragDivider(40)); // narrower
  widths.push(await dragDivider(40)); // narrower still
  widths.push(await dragDivider(-80)); // back to where it started
  out.narrowing = widths;

  // 9. A deep path is elided; the ellipsis opens it out, and the breadcrumb goes up.
  out.pathElided = document.querySelector('.crumb-ellipsis') !== null;
  await click('…');
  out.pathExpanded = await until(() => document.querySelector('.crumb-ellipsis') === null && button('icons') !== undefined);
  await openCrumb('icons');
  await until(() => crumbs().endsWith('icons') && names().includes('FFXIV'));
  out.rootItems = names();

  // 10. The filter searches below the open folder and says where each match lives; clicking that opens it.
  out.filterIsItsOwnField = (() => {
    const field = document.querySelector<HTMLInputElement>('.picker-filter');
    const picker = document.querySelector('.picker');
    // Its own band, full width, and not tucked inside the path field.
    return field !== null && field.parentElement === picker && field.getBoundingClientRect().width > (picker?.getBoundingClientRect().width ?? 0) * 0.9;
  })();
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, 'aura');
  out.filterFound = await until(() => names().join() === 'Aura.png');
  out.filterWhere = document.querySelector('.picker-where')?.textContent;
  (document.querySelector<HTMLElement>('.picker-where'))?.click();
  // Opening a folder from a match clears the filter.
  out.whereOpens = await until(() => crumbs().endsWith('Shared_Actions') && document.querySelector<HTMLInputElement>('.picker-filter')!.value === '');

  // 11. A filter match is chosen by selecting it; a path with spaces and parentheses is stored as it is.
  await openCrumb('icons');
  await until(() => crumbs().endsWith('icons'));
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, 'halo');
  await clickItem('Halo (Area).png');
  out.matchSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/FFXIV/WOLF/Halo (Area).png');
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, '');
  await until(() => names().includes('corrupt.png'));

  // 12. A file the deck cannot draw: refused by the daemon, marked, never saved; its thumbnail is the missing icon.
  await until(async () => !(await previews()).includes(1)); // the previous choice has finished saving
  await clickItem('corrupt.png');
  out.corruptRefused = await until(() => document.querySelector('.picker .field-error')?.textContent?.includes('cannot draw') === true);
  await sleep(700);
  out.corruptNotSaved = (await iconOf('1')) === '~/Pictures/icons/FFXIV/WOLF/Halo (Area).png';
  out.corruptThumbMissing = await until(() => item('corrupt.png')?.querySelector('img')?.src.includes('missing') === true);

  // 13. Leaving the tab straight after choosing: the choice is still saved, and no preview is left.
  await clickItem('back ground.png');
  await click('Key');
  out.tabLeftSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/back ground.png');
  out.tabClears = await until(async () => !(await previews()).includes(1));
  out.keyTabShowsPath = document.querySelector('.inspector .path')?.textContent;

  // 14. Selecting another key straight after choosing: saved on the key it was chosen for; the picker stays in the same folder.
  await click('Icon');
  await clickItem('fishing.png');
  await selectKey(0);
  out.keyChangeSaved = await until(async () => (await iconOf('1')) === '~/Pictures/icons/fishing.png');
  out.keyChangeClears = await until(async () => !(await previews()).includes(1));
  out.placeKept = await until(() => crumbs().endsWith('icons') && names().includes('fishing.png'));

  // 15. A page change ends the preview — even one still in flight: the thumbnail
  // and the page tab are clicked in the same tick, so the picker is gone before
  // the preview's reply arrives (this ordering was a real bug, seen once by luck).
  await until(() => item('fishing.png') !== undefined);
  item('fishing.png')!.click();
  document.querySelector<HTMLButtonElement>('.tab[data-tab="Second"]')!.click();
  await sleep(500);
  out.pageChangeClears = await until(async () => !(await previews()).includes(0));
  out.pageChangeSaved = await until(async () => (await iconOf('0')) === '~/Pictures/icons/fishing.png');
  document.querySelector<HTMLButtonElement>('.tab[data-tab="Main"]')!.click();
  await until(async () => (await api.snapshot()).daemon.status?.decks.find((d) => d.serial === serial)?.page === 'main');
  // Key 0 back to no icon, as it started.
  await selectKey(0);
  if (!document.querySelector('.picker')) await click('Icon');
  await click('Clear icon');
  out.keyZeroCleared = await until(async () => (await saved())?.['0'] !== undefined && (await iconOf('0')) === undefined);

  // 16. A key's icon file renamed away, then back, reaches the grid with no
  // navigation at all (the maintainer saw the stale icon on the real decks). The script
  // renames when it sees a preview on key 30 (away) and key 29 (back).
  const keyIcon = () => document.querySelectorAll('.key')[1]?.querySelector<HTMLImageElement>('img');
  const iconIsMissing = () => keyIcon()?.src.includes('missing') === true && keyIcon()?.classList.contains('key-icon-missing') === true;
  await selectKey(1);
  if (!document.querySelector('.picker')) await click('Icon');
  await clickItem('back ground.png');
  await until(async () => (await iconOf('1')) === '~/Pictures/icons/back ground.png');
  out.iconShownBeforeRename = await until(() => keyIcon() !== undefined && keyIcon()!.complete && keyIcon()!.naturalWidth > 0 && !iconIsMissing());
  await api.previewSet(serial, 30, { label: 'RENAME-AWAY' });
  out.renameAwayShowsMissing = await until(() => iconIsMissing(), 10_000);
  await api.previewClear(serial, 30);
  await api.previewSet(serial, 29, { label: 'RENAME-BACK' });
  out.renameBackShowsIcon = await until(() => keyIcon() !== undefined && !iconIsMissing() && keyIcon()!.complete && keyIcon()!.naturalWidth > 0, 10_000);
  await api.previewClear(serial, 29);

  // 16b. The pinned Built-in section (scope §10): the first chip, then the same
  //      grid, filter and history as any folder; choosing writes builtin:<name>.
  await selectKey(1);
  if (!document.querySelector('.picker')) await click('Icon');
  out.builtinChipFirst = document.querySelector('.picker-bookmarks .chip')?.textContent?.trim();
  await click('Built-in');
  await until(() => crumbs() === 'Built-in' && names().includes('speaker'));
  out.builtinCrumbs = crumbs();
  out.builtinChipSelected = document.querySelector('.chip-builtin')?.classList.contains('chip-selected') ?? false;
  out.builtinUpDisabled = document.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')?.disabled ?? false;
  out.builtinNames = names();
  out.builtinNoBookmarkButton = button('+ Bookmark this folder') === undefined && button('− Remove bookmark') === undefined;
  out.builtinStatus = document.querySelector('.picker-status')?.textContent;
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, 'mic');
  out.builtinFilter = await until(() => names().join() === 'mic,mic-muted');
  await clickItem('mic-muted');
  out.builtinSaved = await until(async () => (await iconOf('1')) === 'builtin:mic-muted');
  out.builtinInGrid = await until(() => loadedDefault(1, 'mic-muted'));
  out.builtinPreviewCleared = await until(async () => !(await previews()).includes(1));
  typeInto(document.querySelector<HTMLInputElement>('.picker-filter')!, '');
  out.builtinStartFolder = await api.iconStartFolder('builtin:mic-muted');
  await click('Key');
  out.builtinKeyTab = await until(() => document.querySelector('.inspector .path')?.textContent === 'Built-in: mic-muted');
  await click('Icon');
  out.builtinCurrentMarked = await until(() => [...document.querySelectorAll('.picker-item-current .picker-name')].map((n) => n.textContent).join() === 'mic-muted');
  await click('←');
  out.builtinBackLeaves = await until(() => crumbs() !== 'Built-in' && crumbs() !== '');

  // 17. "Clear icon" removes only the icon (scope §10: it writes the absent state, not None).
  await selectKey(1);
  if (!document.querySelector('.picker')) await click('Icon');
  await click('Clear icon');
  out.removeKeepsAction = await until(async () => {
    const b = (await saved())?.['1'];
    return b !== undefined && b.icon === undefined && b.action?.keys === 'ctrl+2';
  });
  out.removeButtonGone = await until(() => button('Clear icon') === undefined);
  out.clearedShowsDefault = await until(() => loadedDefault(1, 'key-combo'));
  out.pickerButtons = [...document.querySelectorAll('.picker-actions button')].map((b) => b.textContent);
  out.bands = [...(document.querySelector('.picker')?.children ?? [])].map((c) => c.className.split(' ')[0]);
  out.actionsBelowGrid = (() => {
    const kids = [...(document.querySelector('.picker')?.children ?? [])];
    return kids.findIndex((c) => c.className.includes('picker-bottom')) > kids.findIndex((c) => c.className.includes('picker-grid'));
  })();
  out.bookmarkChipLabels = [...document.querySelectorAll('.picker-bookmarks .chip')].map((c) => c.textContent?.trim());
  out.notConnectedNoteShown = document.body.textContent?.includes('not connected, so icons are not shown') ?? false;
  // Remove the bookmark added earlier, so the file ends with exactly the seeded ones.
  const bookmarkedNow = [...document.querySelectorAll<HTMLButtonElement>('.picker-bookmarks .chip')].find((c) => c.textContent?.includes('BEAR'));
  if (bookmarkedNow) {
    bookmarkedNow.click();
    await until(() => button('− Remove bookmark') !== undefined);
    await click('− Remove bookmark');
    await until(() => button('+ Bookmark this folder') !== undefined);
  }
  out.bookmarksAtEnd = [...document.querySelectorAll('.picker-bookmarks .chip')].map((c) => c.textContent?.trim()).filter((n) => n !== '+ Bookmark this folder');
  await sleep(600); // let the debounced preferences write land before quitting
  return out;
}

/**
 * The resizable panes (scope §10), through the real UI: the widths the editor
 * starts with come from its state file, dragging a divider changes them and
 * stops at the limits, double-click restores the default, and arrow keys move
 * it too. scripts/check-panes.mjs seeds the state file and reads it back
 * afterwards.
 */
async function panes(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean, ms = 5000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const columns = () =>
    getComputedStyle(document.querySelector('.panes')!)
      .gridTemplateColumns.split(' ')
      .map((c) => Math.round(parseFloat(c)));
  const widths = () => {
    const c = columns();
    return { library: c[0], inspector: c[c.length - 1] };
  };
  const dividers = () => [...document.querySelectorAll<HTMLElement>('.pane-divider')];
  /** Drag a divider by `dx` pixels with synthetic pointer events. */
  const drag = async (which: 0 | 1, dx: number) => {
    const el = dividers()[which];
    const box = el.getBoundingClientRect();
    const startX = box.left + box.width / 2;
    const options = { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: startX }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: startX + dx / 2 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: startX + dx }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: startX + dx, buttons: 0 }));
    await sleep(120);
  };

  await until(() => document.querySelector('.panes') !== null && dividers().length === 2);
  await sleep(300); // the stored widths arrive from main just after the first paint
  out.startingWidths = widths();
  out.dividerCount = dividers().length;

  await drag(0, 60);
  out.afterLibraryDrag = widths();

  await drag(0, 5000);
  out.libraryAtMax = widths().library;

  await drag(1, -40);
  out.afterInspectorDrag = widths();

  await drag(1, -5000);
  out.inspectorAtMax = widths().inspector;

  // Double-click restores that pane's default.
  dividers()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(120);
  out.afterDoubleClick = widths().library;

  // Arrow keys move a divider, for anyone not using a pointer.
  const before = widths().inspector;
  dividers()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await sleep(120);
  out.arrowMoved = widths().inspector !== before;
  out.finalWidths = widths();
  // The grid between them keeps a width of its own.
  out.gridColumnPositive = columns()[2] > 100;
  await sleep(600); // let the debounced write reach the state file before quitting
  return out;
}

/**
 * M4 phase B, B1: profiles and pages, driven through the real UI against two
 * decks. Deliberately the same four things the maintainer checks by hand on the real
 * decks, so the hardware run confirms rather than discovers.
 */
async function structure(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const decks = async () => (await api.snapshot()).daemon.status?.decks ?? [];
  const deckAt = async (serial: string) => (await decks()).find((d) => d.serial === serial);
  const selectedTab = () => document.querySelector('.tab-selected')?.getAttribute('data-tab') ?? null;
  const tab = (label: string) => document.querySelector<HTMLButtonElement>(`.tab[data-tab="${label}"]`) ?? undefined;
  const profileValue = () => document.querySelectorAll<HTMLSelectElement>('.toolbar select')[0].value;
  const chooseProfile = (id: string) => {
    const select = document.querySelectorAll<HTMLSelectElement>('.toolbar select')[0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  await until(() => document.querySelector('.grid') !== null);

  // 1. Opening switches nothing. The script put deck A on its second page
  //    before Electron started, so the breadcrumb must open there, and both
  //    decks must be exactly where they were.
  out.opensOn = { tab: selectedTab(), profile: profileValue(), decks: await decks() };

  // 2. "+ Profile", both decks ticked.
  await openAddMenu('New profile');
  await until(() => document.querySelector('.new-profile input') !== null);
  out.ticksShown = [...document.querySelectorAll('.deck-ticks label')].map((l) => l.textContent);
  out.ticksCheckedByDefault = [...document.querySelectorAll<HTMLInputElement>('.deck-ticks input')].map((i) => i.checked);
  const nameField = document.querySelector<HTMLInputElement>('.new-profile input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameField, 'Hardware test');
  nameField.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll<HTMLButtonElement>('.new-profile button')].find((b) => b.textContent === 'Create')!.click();

  // 3. Selecting it moves BOTH decks — the thing one deck cannot prove.
  out.bothDecksSwitched = await until(async () => {
    const all = await decks();
    return all.length === 2 && all.every((d) => d.profile !== undefined && d.profile.startsWith('prof_'));
  });
  out.afterCreate = await decks();
  out.profileAfterCreate = profileValue();

  // 4. Back to Default: both decks return, each to its own start page.
  chooseProfile('default');
  out.bothDecksReturned = await until(async () => {
    const all = await decks();
    return all.length === 2 && all.every((d) => d.profile === 'default' && d.page === 'main');
  });

  // 5. A page change from outside the editor moves the breadcrumb. Signalled
  //    to the script with a preview, as check-live does, since nothing in this
  //    config has a page key to press.
  // The deck being edited, from the Device dropdown — not decks()[0], which is
  // whichever deck the daemon lists first (it was the other one).
  const serial = document.querySelectorAll<HTMLSelectElement>('.toolbar select')[1].value;
  tab('Second')!.click();
  out.onSecond = await until(async () => (await deckAt(serial))?.page === 'second');
  out.tabBeforePress = selectedTab();
  await api.previewSet(serial, 0, { label: 'move it' });
  out.followsDeck = await until(() => selectedTab() === 'Main');
  await api.previewClear(serial, 0);

  // 6. Deleting a page clears the key that navigated to it.
  tab('Second')!.click();
  await until(async () => (await deckAt(serial))?.page === 'second');
  await openTabMenu('Second', 'Delete page');
  await until(() => document.querySelector('.confirm-card') !== null);
  out.confirmText = document.querySelector('.confirm-card')?.textContent ?? null;
  [...document.querySelectorAll<HTMLButtonElement>('.confirm-card button')].find((b) => b.textContent === 'Delete page')!.click();
  out.pageGone = await until(() => tab('Second') === undefined);

  // 7. Leave both decks somewhere that is not their start state, then quit.
  chooseProfile('other');
  out.leftOnOther = await until(async () => (await deckAt(serial))?.profile === 'other');
  out.finalDecks = await decks();
  await sleep(300);
  return out;
}

/**
 * M4 phase B, B2: the page and profile inspectors, driven through the real UI.
 * The point is that a key configured here really works — the deck moves when
 * the harness presses it — rather than the inspector merely writing plausible
 * JSON.
 */
async function navigate(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const decks = async () => (await api.snapshot()).daemon.status?.decks ?? [];
  const serial = () => document.querySelectorAll<HTMLSelectElement>('.toolbar select')[1].value;
  const deck = async () => (await decks()).find((d) => d.serial === serial());
  const selectedTab = () => document.querySelector('.tab-selected')?.getAttribute('data-tab') ?? null;
  const tab = (label: string) => document.querySelector<HTMLButtonElement>(`.tab[data-tab="${label}"]`) ?? undefined;
  const key = (index: number) => document.querySelectorAll<HTMLButtonElement>('.key')[index];
  const library = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.library-entry')].find((b) => b.textContent?.startsWith(name));
  const targets = () => [...document.querySelectorAll<HTMLButtonElement>('.target')];
  const target = (name: string) => targets().find((t) => t.textContent?.startsWith(name));

  await until(() => document.querySelector('.grid') !== null);

  // 1. The guard flags the page that cannot be left, and not the others.
  out.tabsAtStart = [...document.querySelectorAll('.tab')].map((t) => t.textContent);

  // 2. Configure key 1 on Main as "Go to page -> Second" through the library.
  key(1).click();
  await until(() => document.querySelector('.inspector-title') !== null);
  library('Go to page')!.click();
  await until(() => targets().length > 0);
  out.pageTargets = targets().map((t) => t.textContent);
  target('Second')!.click();
  out.pageKeySaved = await until(async () => {
    const snap = await api.snapshot();
    if (!snap.store.open) return false;
    const pages = Object.values(snap.store.state.config.profiles)[0].layouts[serial()].pages;
    return JSON.stringify(pages.main.buttons['1']?.action) === JSON.stringify({ type: 'page', to: 'second' });
  });
  // Written by ID, so renaming the page later cannot break the link.
  out.wroteIdNotName = true;

  // 3. The guard clears once Main has a way off, and Second keeps its badge.
  //    Waited for: the store updates before React re-renders, so reading the
  //    DOM straight after the save read the old badges (seen on the first run).
  await until(() => tab('Main')?.textContent === 'Main'); // no badge left on it
  out.tabsAfterLinking = [...document.querySelectorAll('.tab')].map((t) => t.textContent);

  // 4. Configure key 2 as "Switch profile -> Other", and read the coverage line.
  key(2).click();
  await until(() => document.querySelector('.inspector-title')?.textContent === 'Key 3');
  library('Switch profile')!.click();
  await until(() => targets().length > 0);
  out.profileTargets = targets().map((t) => t.textContent);
  target('Other')!.click();
  await until(async () => {
    const snap = await api.snapshot();
    if (!snap.store.open) return false;
    const pages = Object.values(snap.store.state.config.profiles)[0].layouts[serial()].pages;
    return pages.main.buttons['2']?.action?.type === 'profile';
  });
  out.profileKeyAction = await (async () => {
    const snap = await api.snapshot();
    if (!snap.store.open) return null;
    const pages = Object.values(snap.store.state.config.profiles)[0].layouts[serial()].pages;
    return pages.main.buttons['2']?.action ?? null;
  })();

  // 5. "Back" replaces the target with back: true in one step.
  key(1).click();
  await until(() => document.querySelector('.inspector-title')?.textContent === 'Key 2');
  [...document.querySelectorAll<HTMLButtonElement>('.inspector-section .button-row button')]
    .find((b) => b.textContent === 'Back')!
    .click();
  out.backSaved = await until(async () => {
    const snap = await api.snapshot();
    if (!snap.store.open) return false;
    const pages = Object.values(snap.store.state.config.profiles)[0].layouts[serial()].pages;
    return JSON.stringify(pages.main.buttons['1']?.action) === JSON.stringify({ type: 'page', back: true });
  });

  // 6. Hand back to the script: it presses the keys on the fake deck.
  out.tabBeforePress = selectedTab();
  await api.previewSet(serial(), 31, { label: 'press now' });
  out.deckFollowedTheProfileKey = await until(async () => (await deck())?.profile === 'other');
  await api.previewClear(serial(), 31);
  out.finalTab = selectedTab();
  await sleep(300);
  return out;
}

/**
 * M4 phase B3: bulk operations through the real UI, against two fake decks of
 * the real shapes. The Node side (scripts/check-bulk.mjs) checks the saved file.
 */
async function bulk(api: DeckhandBridge, out: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const key = (index: number) => document.querySelectorAll<HTMLButtonElement>('.key')[index];
  const selected = () =>
    [...document.querySelectorAll('.key')].flatMap((k, i) => (k.classList.contains('key-selected') ? [i] : []));
  const title = () => document.querySelector('.inspector-title')?.textContent ?? null;
  const click = (index: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
    key(index).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  const rightClick = (index: number) => {
    const rect = key(index).getBoundingClientRect();
    key(index).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
  };
  const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.key-menu-item')];
  const menuItem = (label: string) => menuItems().find((b) => b.querySelector('span')?.textContent === label);
  /** A key event where a real one lands: the focused element, bubbling up to window. */
  const press = (code: string, mods: { ctrlKey?: boolean } = {}, target: EventTarget = document.activeElement ?? document.body) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...mods }));
  const buttons = async (page = 'main') => {
    const s = (await api.snapshot()).store;
    if (!s.open) return null;
    const layout = s.state.config.profiles.default.layouts['BULK-XL'];
    return layout.pages[page]?.buttons ?? null;
  };
  const savedKeys = async () => Object.keys((await buttons()) ?? {}).map(Number).sort((a, b) => a - b);
  const status = () => document.querySelector('.bulk-status')?.textContent ?? '';

  await until(() => document.querySelectorAll('.key').length === 32);

  // 1. Click, then Ctrl+click: two keys, and the inspector says so.
  click(0);
  await until(() => selected().join() === '0');
  click(1, { ctrlKey: true });
  await until(() => title() === '2 keys selected');
  out.ctrlClick = { selected: selected(), title: title() };

  // 2. Ctrl+D: each copy in the next empty key, and the copies become the selection.
  press('KeyD', { ctrlKey: true });
  await until(async () => (await savedKeys()).includes(4));
  await until(() => selected().join() === '3,4');
  out.duplicate = { keys: await savedKeys(), selected: selected(), copied: (await buttons())?.['3'] };

  // 3. Shift+click a run, copy it, paste at key 16 (row 2, column 0).
  click(0);
  await until(() => selected().join() === '0');
  click(2, { shiftKey: true });
  await until(() => selected().join() === '0,1,2');
  press('KeyC', { ctrlKey: true });
  await until(() => status().includes('Clipboard'));
  out.clipboardLine = status();
  click(16);
  // Wait for the selection to render: the shortcut reads the selection React last rendered.
  await until(() => selected().join() === '16');
  press('KeyV', { ctrlKey: true });
  await until(async () => (await savedKeys()).includes(18));
  await until(() => selected().join() === '16,17,18');
  out.paste = { keys: await savedKeys(), selected: selected(), pastedNav: (await buttons())?.['18'], message: status() };

  // 4. Right-click inside the selection: the menu acts on all three. Clear them.
  await until(() => selected().join() === '16,17,18');
  rightClick(17);
  await until(() => menuItems().length > 0);
  out.menuLabels = menuItems().map((b) => b.querySelector('span')?.textContent);
  menuItem('Clear 3 buttons')!.click();
  await until(async () => !(await savedKeys()).includes(16));
  out.afterMenuClear = await savedKeys();

  // 5. Right-click outside the selection selects that key alone first.
  click(0);
  await until(() => selected().join() === '0');
  click(1, { ctrlKey: true });
  await until(() => selected().length === 2);
  rightClick(4);
  await until(() => menuItems().length > 0);
  out.rightClickOutside = { selected: selected(), firstItem: menuItems()[0]?.textContent };
  press('Escape');
  await until(() => menuItems().length === 0);
  out.escapeClosedMenuOnly = { menuGone: menuItems().length === 0, selected: selected() };

  // 6. Delete clears the selected key.
  press('Delete');
  await until(async () => !(await savedKeys()).includes(4));
  out.afterDelete = await savedKeys();

  // 7. Shortcuts do nothing while typing in a field: Delete in the label field of key 3.
  click(3);
  await until(() => title() === 'Key 4');
  const label = document.querySelector<HTMLInputElement>('.inspector input[aria-label="Label"]') ?? document.querySelector<HTMLInputElement>('.inspector input');
  out.labelFieldFound = label !== null;
  if (label) {
    label.focus();
    press('Delete', {}, label);
    press('KeyD', { ctrlKey: true }, label);
    await sleep(700);
  }
  out.afterTypingShortcuts = await savedKeys();
  (document.activeElement as HTMLElement | null)?.blur();

  // 8. And nothing while the hotkey inspector is recording: Delete is recorded as the combo, not a clear.
  const record = [...document.querySelectorAll<HTMLButtonElement>('.inspector button')].find((b) => b.textContent === 'Re-record');
  out.recordFound = record !== undefined;
  record?.click();
  await until(() => document.querySelector('.listening') !== null);
  press('Delete');
  out.recordedDelete = await until(async () => (await buttons())?.['3']?.action?.keys === 'delete');
  out.keyThreeAfterRecording = (await buttons())?.['3'] ?? null;
  // Again with the key sent to window itself, where listener order differed
  // (check:hotkey dispatches this way): Escape is recorded and the selection stays.
  await until(() => document.querySelector('.listening') === null);
  [...document.querySelectorAll<HTMLButtonElement>('.inspector button')].find((b) => b.textContent === 'Re-record')?.click();
  await until(() => document.querySelector('.listening') !== null);
  press('Escape', {}, window);
  out.recordedEscAtWindow = await until(async () => (await buttons())?.['3']?.action?.keys === 'esc');
  out.selectionAfterEscAtWindow = selected();

  // 9. Copy to page: key 1 to "Second", same position; selection and clipboard untouched.
  const clipboardBefore = document.querySelector('.bulk-clipboard')?.textContent;
  await until(() => document.querySelector('.listening') === null);
  click(1);
  await until(() => selected().join() === '1');
  rightClick(1);
  await until(() => menuItems().length > 0);
  menuItem('Copy to page')!.click();
  await until(() => document.querySelectorAll('.key-menu-indent').length > 0);
  const pageItems = [...document.querySelectorAll('.key-menu-indent')].map((b) => b.querySelector('span')?.textContent);
  [...document.querySelectorAll<HTMLButtonElement>('.key-menu-indent')].find((b) => b.textContent?.startsWith('Second'))!.click();
  await until(async () => (await buttons('second'))?.['1'] !== undefined);
  await until(() => document.querySelector('.bulk-message') !== null);
  out.copyToPage = {
    pageItems,
    secondKey1: (await buttons('second'))?.['1'],
    selected: selected(),
    clipboardUnchanged: document.querySelector('.bulk-clipboard')?.textContent === clipboardBefore,
    message: document.querySelector('.bulk-message')?.textContent,
  };

  // 10. Copy to device: keys 1, 2, 7, 24 to the V2's Main. 7 and 24 have no place there; key 2's page is not on the V2.
  click(1);
  await until(() => selected().join() === '1');
  for (const index of [2, 7, 24]) {
    click(index, { ctrlKey: true });
    await until(() => selected().includes(index));
  }
  rightClick(2);
  await until(() => menuItems().length > 0);
  menuItem('Copy to device')!.click();
  await until(() => document.querySelectorAll('.key-menu-heading').length > 0);
  const deviceItems = [...document.querySelectorAll('.key-menu-heading, .key-menu-indent')].map((e) => e.querySelector('span')?.textContent ?? e.textContent);
  [...document.querySelectorAll<HTMLButtonElement>('.key-menu-indent')].find((b) => b.textContent?.startsWith('Main'))!.click();
  const v2Buttons = async () => {
    const s = (await api.snapshot()).store;
    return s.open ? s.state.config.profiles.default.layouts['BULK-V2'].pages.main.buttons : null;
  };
  await until(async () => Object.keys((await v2Buttons()) ?? {}).length === 2);
  await until(() => document.querySelector('.bulk-message')?.textContent?.startsWith('Copied 2') ?? false);
  out.copyToDevice = {
    items: deviceItems,
    v2Buttons: await v2Buttons(),
    message: document.querySelector('.bulk-message')?.textContent,
    deckStayed: document.querySelectorAll<HTMLSelectElement>('.toolbar select')[1].value === 'BULK-XL' && document.querySelectorAll('.key').length === 32,
  };

  // 11. Key onto key. Pointer events go where a real pointer's would: the
  //     element under it, bubbling to window.
  const centre = (index: number) => {
    const r = key(index).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const pointer = (type: string, x: number, y: number) =>
    (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true }),
    );
  const dragKey = async (from: number, to: number, before?: () => void) => {
    const a = centre(from);
    const b = centre(to);
    pointer('pointerdown', a.x, a.y);
    pointer('pointermove', a.x + 10, a.y + 10);
    pointer('pointermove', b.x, b.y);
    await sleep(50);
    before?.();
    pointer('pointerup', b.x, b.y);
  };
  const drawn = () => ({
    dragging: [...document.querySelectorAll('.key')].flatMap((k, i) => (k.classList.contains('key-dragging') ? [i] : [])),
    target: [...document.querySelectorAll('.key')].flatMap((k, i) => (k.classList.contains('key-drop-target') ? [i] : [])),
  });

  // a. Onto an occupied key: the two swap, and the moved button is selected.
  let whileDragging: unknown = null;
  await dragKey(0, 1, () => (whileDragging = drawn()));
  await until(async () => (await buttons())?.['1']?.label === 'Jump');
  await until(() => selected().join() === '1');
  out.swap = { whileDragging, after: drawn(), key0: (await buttons())?.['0'], key1: (await buttons())?.['1'], selected: selected() };

  // b. Onto an empty key: a move.
  await dragKey(1, 10);
  await until(async () => (await buttons())?.['10'] !== undefined);
  out.moveToEmpty = { key1: (await buttons())?.['1'] ?? null, key10: (await buttons())?.['10'] };

  // c. A click straight after dropping elsewhere still selects (the post-drag click is not left pending).
  click(2);
  out.clickAfterDrop = await until(() => selected().join() === '2');

  // d. Under the threshold it is a click, not a drag; the browser's click follows on the same key.
  const small = centre(0);
  pointer('pointerdown', small.x, small.y);
  pointer('pointermove', small.x + 3, small.y);
  pointer('pointerup', small.x + 3, small.y);
  click(0);
  out.smallMoveIsClick = { selected: await until(() => selected().join() === '0'), dragDrawn: drawn() };

  // e. Escape during a drag cancels it, and does not clear the selection.
  const keysBeforeCancel = JSON.stringify(await buttons());
  await dragKey(0, 5, () => press('Escape'));
  await sleep(600);
  out.escapeCancels = { unchanged: JSON.stringify(await buttons()) === keysBeforeCancel, selected: selected(), drawn: drawn() };

  // f. An empty key cannot be dragged.
  await dragKey(12, 0);
  await sleep(600);
  out.emptyNotDragged = JSON.stringify(await buttons()) === keysBeforeCancel;

  // 11g. An action from the library onto a key (C2): authoring — a new button.
  const libraryRow = (type: string) => document.querySelector<HTMLButtonElement>(`.library-entry[data-action-type="${type}"]`)!;
  const dragAction = async (type: string, to: number, before?: () => void) => {
    const r = libraryRow(type).getBoundingClientRect();
    const a = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const b = centre(to);
    pointer('pointerdown', a.x, a.y);
    pointer('pointermove', a.x + 10, a.y + 10);
    pointer('pointermove', b.x, b.y);
    await sleep(50);
    before?.();
    pointer('pointerup', b.x, b.y);
  };
  const keyImage = (index: number) => decodeURIComponent(key(index).querySelector<HTMLImageElement>('img.key-icon')?.src ?? '');
  const marked = (index: number) => key(index).querySelector('.key-mark')?.textContent ?? null;
  const heading = () => [...document.querySelectorAll('.inspector .section-heading')].map((h) => h.textContent);

  // a. Onto an occupied key (Jump: icon, label, hotkey): the action is replaced, icon and label cleared.
  let whileActionDragging: unknown = null;
  await dragAction('page', 10, () => (whileActionDragging = { target: drawn().target, label: document.querySelector('.action-drag')?.textContent }));
  await until(async () => (await buttons())?.['10']?.action?.type === 'page');
  await until(() => selected().join() === '10' && heading().includes('Go to page'));
  await until(() => keyImage(10).includes('path=builtin:forward'));
  out.actionDropOccupied = {
    whileDragging: whileActionDragging,
    key10: (await buttons())?.['10'],
    selected: selected(),
    form: heading().includes('Go to page'),
    face: keyImage(10).includes('path=builtin:forward'),
    mark: marked(10),
    labelShown: key(10).querySelector('.key-label') !== null,
    ghostGone: document.querySelector('.action-drag') === null,
  };
  // b. Choosing the page completes it, and the mark goes.
  [...document.querySelectorAll<HTMLButtonElement>('.inspector .target')].find((b) => b.textContent?.startsWith('Second'))!.click();
  await until(async () => (await buttons())?.['10']?.action?.to === 'second');
  out.actionCompleted = { key10: (await buttons())?.['10'], mark: (await until(() => marked(10) === null)) };

  // c. Hotkey onto an empty key: written at once, not listening (a drop is not a click).
  await dragAction('hotkey', 12);
  await until(async () => (await buttons())?.['12'] !== undefined);
  await until(() => selected().join() === '12' && heading().includes('Hotkey'));
  await sleep(200);
  out.actionDropEmpty = {
    key12: (await buttons())?.['12'],
    listening: document.querySelector('.listening') !== null,
    recordButton: [...document.querySelectorAll('.inspector button')].some((b) => b.textContent === 'Record hotkey'),
    mark: marked(12),
  };

  // d. Escape during a library drag cancels it: nothing written, selection kept.
  const beforeActionCancel = JSON.stringify(await buttons());
  await dragAction('profile', 13, () => press('Escape'));
  await sleep(600);
  out.actionEscapeCancels = { unchanged: JSON.stringify(await buttons()) === beforeActionCancel, selected: selected(), ghostGone: document.querySelector('.action-drag') === null };

  // e. Clicking an action retargets the selected key and keeps icon and label (C2 call 3).
  click(24);
  await until(() => selected().join() === '24' && title() === 'Key 25');
  libraryRow('profile').click();
  await until(() => heading().includes('Switch profile'));
  const unchangedUntilChosen = (await buttons())?.['24']?.action?.type === 'hotkey';
  [...document.querySelectorAll<HTMLButtonElement>('.inspector .target')].find((b) => b.textContent?.startsWith('Default'))!.click();
  await until(async () => (await buttons())?.['24']?.action?.type === 'profile');
  out.clickRetargets = { unchangedUntilChosen, key24: (await buttons())?.['24'] };

  // 12. Ctrl+A selects every key; Escape selects none.
  press('KeyA', { ctrlKey: true });
  await until(() => selected().length === 32);
  out.selectAll = selected().length;
  press('Escape');
  await until(() => selected().length === 0);
  out.afterEscape = selected().length;

  await sleep(700); // past the autosave
  return out;
}

/** C2: each action form writes exactly the settings it names (scripts/check-forms.mjs). */
async function forms(api: DeckhandBridge): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const buttons = async () => {
    const s = (await api.snapshot()).store;
    return s.open && !s.state.dirty ? s.state.config.profiles.default.layouts['FORMS-XL'].pages.main.buttons : null;
  };
  /** Wait until the saved key matches, and return what was saved either way. */
  const savedAs = async (index: number, expected: unknown) => {
    const want = JSON.stringify(expected);
    await until(async () => JSON.stringify((await buttons())?.[String(index)] ?? null) === want);
    return (await buttons())?.[String(index)] ?? null;
  };
  const actionAs = async (index: number, expected: unknown) => {
    const want = JSON.stringify(expected);
    await until(async () => JSON.stringify((await buttons())?.[String(index)]?.action ?? null) === want);
    return (await buttons())?.[String(index)]?.action ?? null;
  };
  const selectKey = async (index: number) => {
    await until(() => document.querySelectorAll('.key').length > index);
    document.querySelectorAll<HTMLButtonElement>('.key')[index].click();
    await until(() => document.querySelector('.inspector-title')?.textContent === `Key ${index + 1}`);
  };
  const libraryClick = (type: string) => document.querySelector<HTMLButtonElement>(`.library-entry[data-action-type="${type}"]`)!.click();
  const inspectorButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.inspector button')].find((b) => b.textContent?.trim() === text);
  const clickButton = async (text: string) => {
    if (!(await until(() => inspectorButton(text) !== undefined && !inspectorButton(text)!.disabled))) throw new Error(`no enabled button "${text}"`);
    inspectorButton(text)!.click();
  };
  const input = (label: string) => document.querySelector<HTMLInputElement>(`.inspector input[aria-label="${label}"]`)!;
  const typeInto = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const headings = () => [...document.querySelectorAll('.inspector .section-heading')].map((h) => h.textContent);
  const pairRows = () => [...document.querySelectorAll('.pair-icons .form-name')].map((n) => n.textContent);
  const pairValue = (field: string) => document.querySelector(`.pair-icons [data-pair="${field}"]`)?.textContent ?? null;

  await until(() => document.querySelector('.grid') !== null);

  // Clock, on an empty key: a click writes it (nothing to choose).
  await selectKey(0);
  libraryClick('clock');
  const clock = [await actionAs(0, { type: 'clock' })];
  await clickButton('14:05:09');
  clock.push(await actionAs(0, { type: 'clock', format: 'HH:mm:ss' }));
  await clickButton('14:05');
  clock.push(await actionAs(0, { type: 'clock' }));
  out.clock = clock;

  // Volume, retargeting a hotkey key: written at once, label and icon kept.
  await selectKey(1);
  libraryClick('audio.volume');
  const vol = { label: 'Vol', icon: 'builtin:headset' };
  const volume = [await savedAs(1, { ...vol, action: { type: 'audio.volume' } })];
  await clickButton('Quieter');
  volume.push(await savedAs(1, { ...vol, action: { type: 'audio.volume', delta: -5 } }));
  typeInto(input('Volume step'), '10');
  volume.push(await savedAs(1, { ...vol, action: { type: 'audio.volume', delta: -10 } }));
  document.querySelector<HTMLInputElement>('.inspector .form-check input')!.click();
  volume.push(await savedAs(1, { ...vol, action: { type: 'audio.volume', delta: -10, showLevel: true } }));
  out.volume = volume;

  // Brightness on an empty key: it needs a choice first.
  await selectKey(2);
  libraryClick('brightness');
  await until(() => headings().includes('Brightness'));
  await sleep(500);
  const brightness: unknown[] = [(await buttons())?.['2'] ?? null];
  await clickButton('Dimmer');
  brightness.push(await actionAs(2, { type: 'brightness', delta: -10 }));
  await clickButton('Set to');
  brightness.push(await actionAs(2, { type: 'brightness', value: 50 }));
  typeInto(input('Brightness level'), '30');
  brightness.push(await actionAs(2, { type: 'brightness', value: 30 }));
  out.brightness = brightness;

  // Media control.
  await selectKey(3);
  await until(() => headings().includes('Media control'));
  await clickButton('Next');
  const next = await actionAs(3, { type: 'media.control', method: 'next' });
  await sleep(100);
  const pairShownForNext = pairRows().length > 0;
  await clickButton('Play / pause');
  const back = await actionAs(3, { type: 'media.control' });
  await until(() => pairRows().length === 2);
  out.mediaControl = { next, pairShownForNext, back, pairShownForPlayPause: pairRows() };

  // Mic mute: labels, then its state icons from the Built-in section.
  await selectKey(4);
  await until(() => headings().includes('Mic mute'));
  typeInto(input('Label while muted'), 'MUTED');
  input('Label while muted').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); // saves at once, as leaving the field does
  await actionAs(4, { type: 'audio.micMute', labelMuted: 'MUTED' });
  typeInto(input('Label while unmuted'), 'live');
  out.micLabels = await actionAs(4, { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live' });
  const labels = { type: 'audio.micMute', labelMuted: 'MUTED', labelUnmuted: 'live' };
  [...document.querySelectorAll<HTMLButtonElement>('.pair-icons .form-row')].find((row) => row.textContent?.includes('While muted'))!.querySelector('button')!.click();
  await until(() => document.querySelector('.picker') !== null);
  out.slotOpened = {
    tab: document.querySelector('.inspector-tab-selected')?.textContent,
    slot: document.querySelector('.icon-slots .segment-selected')?.textContent,
  };
  const pickerItem = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.picker-item')].find((i) => i.querySelector('.picker-name')?.textContent === name);
  const chooseBuiltin = async (name: string) => {
    document.querySelector<HTMLButtonElement>('.chip-builtin')!.click();
    await until(() => pickerItem(name) !== undefined);
    pickerItem(name)!.click();
  };
  await chooseBuiltin('speaker-muted');
  const afterMuted = await savedAs(4, { action: { ...labels, iconMuted: 'builtin:speaker-muted' } });
  [...document.querySelectorAll<HTMLButtonElement>('.icon-slots .segment')].find((b) => b.textContent === 'While unmuted')!.click();
  await sleep(100);
  await chooseBuiltin('headset');
  const afterUnmuted = await savedAs(4, { action: { ...labels, iconMuted: 'builtin:speaker-muted', iconUnmuted: 'builtin:headset' } });
  const gridShowsUnmuted = await until(() =>
    decodeURIComponent(document.querySelectorAll('.key')[4].querySelector<HTMLImageElement>('img.key-icon')?.src ?? '').includes('path=builtin:headset'),
  );
  [...document.querySelectorAll<HTMLButtonElement>('.icon-slots .segment')].find((b) => b.textContent === 'Key icon')!.click();
  await sleep(200);
  const keySlotCurrent = [...document.querySelectorAll('.picker-item-current .picker-name')].map((n) => n.textContent);
  document.querySelector<HTMLButtonElement>('.inspector-tab:not(.inspector-tab-selected)')!.click();
  await until(() => pairValue('iconMuted') !== null);
  const formSays = { iconMuted: pairValue('iconMuted'), iconUnmuted: pairValue('iconUnmuted') };
  // Clearing a state icon removes only that one.
  [...document.querySelectorAll<HTMLButtonElement>('.pair-icons .form-row')].find((row) => row.textContent?.includes('While muted'))!.querySelector('button')!.click();
  await until(() => document.querySelector('.picker') !== null);
  const clear = [...document.querySelectorAll<HTMLButtonElement>('.picker-actions button')].find((b) => b.textContent === 'Clear icon');
  clear?.click();
  const cleared = await savedAs(4, { action: { ...labels, iconUnmuted: 'builtin:headset' } });
  out.micIcons = { afterMuted, afterUnmuted, gridShowsUnmuted, formSays, keySlotCurrent, cleared };
  document.querySelector<HTMLButtonElement>('.inspector-tab:not(.inspector-tab-selected)')!.click();

  // Now playing.
  await selectKey(5);
  await until(() => headings().includes('Now playing'));
  await clickButton('Title');
  await actionAs(5, { type: 'media.info', show: 'title' });
  document.querySelector<HTMLInputElement>('.inspector .form-check input')!.click();
  await actionAs(5, { type: 'media.info', show: 'title', showArt: false });
  await clickButton('Does nothing');
  await actionAs(5, { type: 'media.info', show: 'title', showArt: false, pressAction: 'none' });
  typeInto(input('Label when nothing plays'), 'Quiet');
  out.mediaInfo = await actionAs(5, { type: 'media.info', show: 'title', showArt: false, pressAction: 'none', idleLabel: 'Quiet' });

  // Nothing; and a key the form cannot show all of.
  await selectKey(6);
  out.noopForm = await until(() => headings().includes('Nothing'));
  out.noopJson = document.querySelector('.inspector .json') !== null;
  await selectKey(7);
  out.playerReadOnly = await until(() => headings().includes('Action') && document.querySelector('.inspector .json') !== null);

  // Output device, on an empty key: nothing until a device is picked.
  const device = (node: string) => document.querySelector<HTMLButtonElement>(`.inspector .target[data-node="${node}"]`);
  const deviceList = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.inspector .target-list .target')].map((t) => `${t.querySelector('.target-name')?.textContent}|${t.querySelector('.target-note')?.textContent}`);
  await selectKey(9);
  libraryClick('audio.sink');
  await until(() => deviceList().length > 0);
  await sleep(500);
  const outputWrites: unknown[] = [(await buttons())?.['9'] ?? null];
  const outputList = deviceList();
  device('alsa_output.usb-Example_Headset-00.mono-chat')!.click();
  outputWrites.push(await actionAs(9, { type: 'audio.sink', node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono' }));
  await until(() => document.querySelector('.inspector .form-check input') !== null);
  document.querySelector<HTMLInputElement>('.inspector .form-check input')!.click();
  outputWrites.push(await actionAs(9, { type: 'audio.sink', node: 'alsa_output.usb-Example_Headset-00.mono-chat', label: 'Example Headset Mono', moveStreams: false }));
  out.output = { list: outputList, writes: outputWrites };

  // Input device: the stored one is unplugged while the form is open.
  await selectKey(10);
  await until(() => device('alsa_input.pci-0000_00_1f.3.HiFi__Mic__source')?.classList.contains('target-selected') === true);
  const before = document.querySelector('.inspector .target-selected')?.getAttribute('data-node');
  const serial = (await api.snapshot()).daemon.decks?.[0]?.serial ?? '';
  await api.previewSet(serial, 31, { label: 'unplug' });
  const missingShown = await until(
    () => (document.querySelector('.inspector .target-selected .target-note')?.textContent?.includes('not present now') ?? false) && (document.querySelector('.inspector .warning-text')?.textContent?.includes('not present now') ?? false),
  );
  await api.previewClear(serial, 31);
  device('alsa_input.usb-Example_Headset-00.mono-fallback')!.click();
  const picked = await actionAs(10, { type: 'audio.source', node: 'alsa_input.usb-Example_Headset-00.mono-fallback', label: 'Example Headset Mono Mic' });
  out.input = { before, missingShown, picked };

  // Cycle outputs.
  const mark = (index: number) => document.querySelectorAll('.key')[index].querySelector('.key-mark')?.textContent ?? null;
  const cycleNodes = async () => ((await buttons())?.['11']?.action?.devices as Array<{ node: string }> | undefined)?.map((d) => d.node) ?? [];
  const add = async (node: string, count: number) => {
    await until(() => device(node) !== null);
    device(node)!.click();
    await until(async () => (await cycleNodes()).length === count);
  };
  await selectKey(11);
  libraryClick('audio.cycle');
  await add('alsa_output.usb-Example_Headset-00.analog-stereo', 1);
  const markWithOne = (await until(() => mark(11) === 'not set up')) ? mark(11) : null;
  await add('alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink', 2);
  await add('alsa_output.usb-Example_Headset-00.mono-chat', 3);
  const cycleButton = (label: string) => document.querySelector<HTMLButtonElement>(`.inspector .cycle-controls button[aria-label="${label}"]`)!;
  cycleButton('Move Example Headset Mono up').click();
  await until(async () => (await cycleNodes())[1] === 'alsa_output.usb-Example_Headset-00.mono-chat');
  cycleButton('Remove Example Headset Analog Stereo').click();
  await until(async () => (await cycleNodes()).length === 2);
  const order = await cycleNodes();
  const markWithTwo = (await until(() => mark(11) === null)) ? null : mark(11);
  const nameToggle = [...document.querySelectorAll<HTMLLabelElement>('.inspector .form-check')].find((l) => l.textContent?.includes('name'))!.querySelector('input')!;
  nameToggle.click();
  await until(async () => (await buttons())?.['11']?.action?.showCurrent === false);
  out.cycle = { markWithOne, order, markWithTwo, final: (await buttons())?.['11']?.action };

  // Cycle inputs: the same form over sources, so this checks the list it draws
  // from is the input list and that "move what is recording" writes moveStreams.
  const cycleInNodes = async () => ((await buttons())?.['20']?.action?.devices as Array<{ node: string }> | undefined)?.map((d) => d.node) ?? [];
  const addIn = async (node: string, count: number) => {
    await until(() => device(node) !== null);
    device(node)!.click();
    await until(async () => (await cycleInNodes()).length === count);
  };
  await selectKey(20);
  libraryClick('audio.cycleSource');
  // A monitor source must never be offered: the daemon filters them out, and
  // this is the check that the form reads the source list rather than the sinks.
  // **Not the built-in mic**: the Input device block above unplugs it through
  // the preview handshake and nothing plugs it back in, so it is gone by here.
  // Wait for the form before looking: without this every lookup is null and
  // the check passes its own "no sinks offered" half for the wrong reason.
  await until(() => document.querySelector('.inspector .target-list') !== null);
  const offersInputsOnly =
    device('alsa_input.virtual-portless') !== null &&
    device('alsa_output.usb-Example_Headset-00.analog-stereo') === null &&
    device('alsa_output.usb-Example_Headset-00.analog-stereo.monitor') === null;
  await addIn('alsa_input.usb-Example_Headset-00.mono-fallback', 1);
  const markInWithOne = (await until(() => mark(20) === 'not set up')) ? mark(20) : null;
  await addIn('alsa_input.virtual-portless', 2);
  const markInWithTwo = (await until(() => mark(20) === null)) ? null : mark(20);
  const moveToggle = [...document.querySelectorAll<HTMLLabelElement>('.inspector .form-check')].find((l) => l.textContent?.includes('recording'))!.querySelector('input')!;
  moveToggle.click();
  await until(async () => (await buttons())?.['20']?.action?.moveStreams === false);
  out.cycleInputs = { offersInputsOnly, markInWithOne, markInWithTwo, final: (await buttons())?.['20']?.action };

  await selectKey(12);
  out.matchReadOnly = await until(() => headings().includes('Action') && document.querySelector('.inspector .json') !== null);

  // Type text.
  const textarea = () => document.querySelector<HTMLTextAreaElement>('.inspector textarea[aria-label="Text to type"]')!;
  const typeText = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  };
  await selectKey(13);
  libraryClick('text');
  await until(() => document.querySelector('.inspector textarea') !== null);
  // A hidden window delivers no focus events for focus()/blur(), and React's
  // onFocus/onBlur listen for focusin/focusout: dispatch those (a break that
  // wrote on blur first passed because focus() and blur() did nothing).
  textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(600);
  const afterBlur = (await buttons())?.['13'] ?? null;
  typeText('Hi!\nok');
  const typed = await actionAs(13, { type: 'text', text: 'Hi!\nok' });
  const estimate = document.querySelector('.inspector .inspector-section')?.textContent?.includes('About') ?? false;
  typeText('café');
  const refusedShown = await until(() => document.querySelector('.inspector .field-error')?.textContent?.includes('cannot type') === true);
  await sleep(700);
  const refusedNotSaved = (await buttons())?.['13']?.action ?? null;
  typeText('Hi!\nok');
  await sleep(600);
  out.text = { afterBlur, typed, estimate, refusedShown, refusedNotSaved };

  // Hotkey hold and repeat.
  await selectKey(14);
  await until(() => document.querySelector('.inspector input[aria-label="Hold for"]') !== null);
  const hotkeyExtras = [];
  typeInto(input('Hold for'), '250');
  hotkeyExtras.push(await actionAs(14, { type: 'hotkey', keys: 'ctrl+1', holdMs: 250 }));
  typeInto(input('Repeat'), '3');
  hotkeyExtras.push(await actionAs(14, { type: 'hotkey', keys: 'ctrl+1', holdMs: 250, repeat: 3 }));
  typeInto(input('Hold for'), '0');
  hotkeyExtras.push(await actionAs(14, { type: 'hotkey', keys: 'ctrl+1', repeat: 3 }));
  typeInto(input('Repeat'), '1');
  hotkeyExtras.push(await actionAs(14, { type: 'hotkey', keys: 'ctrl+1' }));
  out.hotkeyExtras = hotkeyExtras;

  // Press/Release: listens on a library click, like Hotkey.
  await selectKey(15);
  libraryClick('keyHold');
  const listening = await until(() => document.querySelector('.listening') !== null);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F24', key: 'F24', bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F24', key: 'F24', bubbles: true, cancelable: true }));
  const pair = { action: { type: 'keyHold', keys: 'f24', state: 'down' }, onRelease: { type: 'keyHold', keys: 'f24', state: 'up' } };
  const pressSaved = await savedAs(15, pair);
  await until(() => document.querySelectorAll('.inspector .phase').length === 2 && !document.querySelector('.inspector .phase .muted'));
  const phases = [...document.querySelectorAll('.inspector .phase')].map((p) => p.textContent);
  await clickButton('Clear');
  const pressCleared = await savedAs(15, null);
  out.pressRelease = { listening, saved: pressSaved, phases, cleared: pressCleared };

  // Run command.
  await selectKey(16);
  libraryClick('command');
  await until(() => document.querySelector('.inspector input[aria-label="Command"]') !== null);
  typeInto(input('Command'), 'kate ~/notes.md');
  const commandTyped = await actionAs(16, { type: 'command', command: 'kate ~/notes.md' });
  typeInto(input('Command'), '');
  const commandEmptied = await actionAs(16, { type: 'command' });
  await until(() => document.querySelectorAll('.key')[16].querySelector('.key-mark')?.textContent === 'not set up');
  out.command = { typed: commandTyped, emptied: commandEmptied, mark: document.querySelectorAll('.key')[16].querySelector('.key-mark')?.textContent ?? null };

  await selectKey(17);
  out.oddPairReadOnly = await until(() => headings().includes('Action') && document.querySelector('.inspector .json') !== null);

  // Multi action.
  const multiWrites: unknown[] = [];
  const stepRow = (i: number) => document.querySelector<HTMLElement>(`.inspector .step[data-step-index="${i}"]`);
  const openStep = async (i: number) => {
    if (!stepRow(i)?.classList.contains('step-open')) stepRow(i)!.querySelector<HTMLButtonElement>('.step-main')!.click();
    await until(() => stepRow(i)?.classList.contains('step-open') === true);
  };
  const addStep = async (type: string) => {
    await clickButton('Add a step');
    await until(() => document.querySelector(`.inspector [data-step-type="${type}"]`) !== null);
    document.querySelector<HTMLButtonElement>(`.inspector [data-step-type="${type}"]`)!.click();
  };
  await selectKey(18);
  libraryClick('multi');
  await until(() => headings().includes('Multi action'));
  await sleep(500);
  multiWrites.push((await buttons())?.['18']?.action ?? null);
  await addStep('hotkey');
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey' }] }));
  const markWhileEmpty = (await until(() => document.querySelectorAll('.key')[18].querySelector('.key-mark')?.textContent === 'not set up')) ? 'not set up' : null;
  // The step's own hotkey form, typed manually.
  await openStep(0);
  stepRow(0)!.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.textContent === 'Type manually' && b.click());
  await until(() => stepRow(0)!.querySelector('input[aria-label="Key combination"]') !== null);
  const combo = stepRow(0)!.querySelector<HTMLInputElement>('input[aria-label="Key combination"]')!;
  typeInto(combo, 'ctrl+1');
  combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+1' }] }));
  typeInto(stepRow(0)!.querySelector<HTMLInputElement>('input[aria-label="Delay after step 1"]')!, '200');
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+1', delayMs: 200 }] }));
  await addStep('text');
  await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+1', delayMs: 200 }, { type: 'text' }] });
  await openStep(1);
  const stepText = stepRow(1)!.querySelector<HTMLTextAreaElement>('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(stepText, 'gg');
  stepText.dispatchEvent(new Event('input', { bubbles: true }));
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+1', delayMs: 200 }, { type: 'text', text: 'gg' }] }));
  await until(() => document.querySelector('.inspector .step-total')?.textContent?.includes('delays') === true);
  const total = document.querySelector('.inspector .step-total')?.textContent;
  const summaries = [...document.querySelectorAll('.inspector .step-summary')].map((n) => n.textContent);
  // Drag step 2 by its handle onto step 1.
  const handle = stepRow(1)!.querySelector<HTMLElement>('.step-handle')!.getBoundingClientRect();
  const target = stepRow(0)!.querySelector<HTMLElement>('.step-main')!.getBoundingClientRect();
  const pointerAt = (type: string, x: number, y: number) =>
    (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, button: 0, isPrimary: true }));
  pointerAt('pointerdown', handle.x + handle.width / 2, handle.y + handle.height / 2);
  pointerAt('pointermove', target.x + 10, target.y + target.height / 2);
  pointerAt('pointerup', target.x + 10, target.y + target.height / 2);
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'text', text: 'gg' }, { type: 'hotkey', keys: 'ctrl+1', delayMs: 200 }] }));
  await until(() => stepRow(0)?.querySelector('.step-name')?.textContent === 'Type text');
  stepRow(0)!.querySelector<HTMLButtonElement>('.step-remove')!.click();
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+1', delayMs: 200 }] }));
  // Editing a step that has a delay keeps the delay.
  await openStep(0);
  stepRow(0)!.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.textContent === 'Type manually' && b.click());
  await until(() => stepRow(0)!.querySelector('input[aria-label="Key combination"]') !== null);
  const recombo = stepRow(0)!.querySelector<HTMLInputElement>('input[aria-label="Key combination"]')!;
  typeInto(recombo, 'ctrl+2');
  recombo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  multiWrites.push(await actionAs(18, { type: 'multi', steps: [{ type: 'hotkey', keys: 'ctrl+2', delayMs: 200 }] }));
  // Test run: a countdown, then it is sent.
  await clickButton('Test run');
  const clickedAt = Date.now();
  const countdownShown = await until(() => document.querySelector('.inspector .test-countdown') !== null, 2000);
  await until(() => document.querySelector('.inspector .test-result') !== null, 8000);
  // Scope §10: it arms rather than fires — nothing is sent for the whole countdown.
  const testAfterMs = Date.now() - clickedAt;
  out.multi = { writes: multiWrites, markWhileEmpty, total, summaries, countdownShown, testAfterMs, testResult: document.querySelector('.inspector .test-result')?.textContent ?? null };

  // A multi with a step the editor has no form for.
  await selectKey(19);
  await until(() => stepRow(0) !== null);
  await openStep(0);
  const json = stepRow(0)!.querySelector('.json') !== null;
  typeInto(stepRow(0)!.querySelector<HTMLInputElement>('input[aria-label="Delay after step 1"]')!, '75');
  const afterDelay = await actionAs(19, { type: 'multi', steps: [{ type: 'hotkey', keys: ['a', 'b'], delayMs: 75 }, { type: 'media.control', method: 'next' }] });
  out.multiReadOnly = { json, afterDelay };

  // A mute key with its own icon.
  await selectKey(8);
  await until(() => pairValue('iconMuted') !== null);
  out.ownIcon = {
    iconMuted: pairValue('iconMuted'),
    iconUnmuted: pairValue('iconUnmuted'),
    note: document.querySelector('.pair-icons')?.textContent?.includes('instead of swapping') ?? false,
  };

  await sleep(700); // past the autosave
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
    else if (name === 'panes') api.reportCheck(name, await panes(api));
    else if (name === 'structure') api.reportCheck(name, await structure(api));
    else if (name === 'navigate') api.reportCheck(name, await navigate(api));
    else if (name === 'forms') api.reportCheck(name, await forms(api));
    else if (name === 'bulk') {
      // Reports how far it got, so a failure part-way through can be diagnosed.
      const progress: Record<string, unknown> = {};
      try {
        api.reportCheck(name, await bulk(api, progress));
      } catch (err) {
        api.reportCheck(name, { ...progress, error: (err as Error).stack ?? String(err) });
      }
    }
    else api.reportCheck(name, { error: `unknown check "${name}"` });
  } catch (err) {
    api.reportCheck(name, { error: (err as Error).stack ?? String(err) });
  }
}
