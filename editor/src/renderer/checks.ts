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
  const images = [...document.querySelectorAll<HTMLImageElement>('img')];
  const settled = (img: HTMLImageElement) =>
    new Promise<void>((resolve) => {
      if (img.complete) return resolve();
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  await Promise.all(images.map(settled));
  await new Promise((r) => setTimeout(r, 300));
  return {
    selectKeyParam: selectIndex,
    selected: [...document.querySelectorAll('.key-selected')].map((k) => k.getAttribute('aria-label')),
    inspectorTitle: document.querySelector('.inspector-title')?.textContent ?? null,
    keys: document.querySelectorAll('.key').length,
    kinds: Object.fromEntries(['empty', 'unbound', 'hotkey', 'other'].map((k) => [k, document.querySelectorAll(`.key-${k}`).length])),
    images: images.length,
    brokenImages: images.filter((img) => img.naturalWidth === 0).map((img) => decodeURIComponent(img.src.split('path=')[1] ?? img.src)),
    notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent?.slice(0, 80)),
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
  };
}

export async function runCheck(name: string, api: DeckhandBridge): Promise<void> {
  try {
    if (name === 'shared') api.reportCheck(name, sharedImports());
    else if (name === 'bridge') api.reportCheck(name, await bridge(api));
    else if (name === 'screenshot') api.reportCheck(name, await screenshot(api));
    else api.reportCheck(name, { error: `unknown check "${name}"` });
  } catch (err) {
    api.reportCheck(name, { error: (err as Error).stack ?? String(err) });
  }
}
