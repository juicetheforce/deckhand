import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { startPageOf } from '../../../src/config-common.js';
import type { Config } from '../../../src/types.js';
import { planProfileDeletion, type ProfileDeletion } from '../shared/profile-deletion.js';
import type { DaemonResult, DaemonView, StoreState } from '../shared/bridge.js';
import { DeckGrid } from './DeckGrid.js';
import { DeckCanvas, type CanvasDeck } from './DeckCanvas.js';
import { DeckPanel } from './DeckPanel.js';
import { roundPosition } from './canvas.js';
import { withPosition, type DeckPositions } from '../shared/deck-positions.js';
import { Inspector, type Pick } from './Inspector.js';
import { Library } from './Library.js';
import { actionName, libraryIcon } from './catalogue.js';
import { builtinRef, iconUrl } from '../shared/icons.js';
import { useActionDrag, type ActionDrag } from './useActionDrag.js';
import type { KeyRef } from './keyUnder.js';
import {
  canSwitchDeck,
  clickKeys,
  deckForProfile,
  deviceTargets,
  emptyState,
  failedKeysOn,
  latchedKeysOn,
  focusDeck,
  followDeck,
  othersToStartPages,
  pageOf,
  restoreShown,
  setDeckPage,
  setShown,
  shownDecks,
  geometryFor,
  layoutFor,
  labelDefaults,
  pageChoices,
  pageDeletion,
  pageLabel,
  pageLabelIn,
  profileLabel,
  deckLabel,
  profileChoices,
  profileCoverage,
  reconcileSelection,
  faceIcon,
  appIconsOf,
  type Selection,
} from './model.js';
import { BulkStatus, KeyMenu } from './KeyMenu.js';
import { Notices } from './Notices.js';
import { PaneDivider } from './PaneDivider.js';
import { DEFAULT_PANE_WIDTHS, paneColumns, type PaneName, type PaneWidths } from './panes.js';
import { Toolbar, type AddPageResult, type AddProfileResult } from './Toolbar.js';
import { keyCapture } from './key-capture.js';
import { useBulk } from './useBulk.js';
import { useEditor } from './useEditor.js';

export function App() {
  const snapshot = useEditor();
  // The app settings, read before the editor mounts: its first selection opens on the Default deck.
  const [defaultDeck, setDefaultDeck] = useState<string | null | undefined>(undefined);
  // And the decks last shown beside it (SHOW IN EDITOR), restored once the daemon reports them.
  const [rememberedShown, setRememberedShown] = useState<string[] | undefined>(undefined);
  // And where each deck sits on the canvas.
  const [rememberedPositions, setRememberedPositions] = useState<DeckPositions | undefined>(undefined);
  const [rememberedLocked, setRememberedLocked] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    void window.deckhand.appSettings().then((s) => setDefaultDeck(s.defaultDeck));
    void window.deckhand.shownDecks().then(setRememberedShown);
    void window.deckhand.deckPositions().then(setRememberedPositions);
    void window.deckhand.lockedDecks().then(setRememberedLocked);
  }, []);
  if (!snapshot || defaultDeck === undefined || rememberedShown === undefined || rememberedPositions === undefined || rememberedLocked === undefined) return <div className="app-loading">Loading…</div>;
  if (!snapshot.store.open) return <CannotOpen error={snapshot.store.error} />;
  return (
    <Editor
      store={snapshot.store.state}
      daemon={snapshot.daemon}
      defaultDeck={defaultDeck}
      rememberedShown={rememberedShown}
      rememberedPositions={rememberedPositions}
      rememberedLocked={rememberedLocked}
    />
  );
}

function CannotOpen({ error }: { error: string }) {
  return (
    <main className="cannot-open glass">
      <h1>config.json could not be opened</h1>
      <p>{error}</p>
      <button onClick={() => void window.deckhand.reopenConfig()}>Try again</button>
    </main>
  );
}

function Editor({
  store,
  daemon,
  defaultDeck,
  rememberedShown,
  rememberedPositions,
  rememberedLocked,
}: {
  store: StoreState;
  daemon: DaemonView;
  defaultDeck: string | null;
  rememberedShown: string[];
  rememberedPositions: DeckPositions;
  rememberedLocked: string[];
}) {
  const config = store.config;
  /**
   * Where each deck sits on the canvas. Written when a drag ends — every
   * shown deck as drawn, so one never dragged stays where it was seen rather
   * than being placed again below the lowest on the next opening.
   */
  const [positions, setPositions] = useState(rememberedPositions);
  const moveDecks = (moved: DeckPositions) => {
    const rounded = Object.fromEntries(Object.entries(moved).map(([serial, at]) => [serial, roundPosition(at)]));
    setPositions((current) => Object.entries(rounded).reduce((all, [serial, at]) => withPosition(all, serial, at), current));
    void window.deckhand.setDeckPositions(rounded);
  };
  /** Decks locked in place on the canvas: global, like the positions. */
  const [locked, setLocked] = useState(rememberedLocked);
  const lockDeck = (serial: string, lock: boolean, drawn: DeckPositions) => {
    // Locked where it is seen: the arrangement as drawn is saved with it.
    moveDecks(drawn);
    const next = lock ? [...locked.filter((s) => s !== serial), serial] : locked.filter((s) => s !== serial);
    setLocked(next);
    void window.deckhand.setLockedDecks(next);
  };
  // Only when the window opens: changing the setting later moves nothing until the next opening.
  const [selection, setSelection] = useState<Selection>(() => followDeck(config, daemon, reconcileSelection(config, daemon, null, defaultDeck)));
  // Switches sent to the daemon and not yet answered. While one is in flight
  // the breadcrumb shows what was chosen; state events from before the switch
  // would otherwise pull it back for a moment.
  const [inFlight, setInFlight] = useState(0);
  // The same count, read inside the follow effect's update: that effect can
  // be left pending by a daemon render and run just after a click, from a
  // render that saw nothing in flight. Reading the state it closed over, it
  // would put the breadcrumb back on the deck's page until the deck reported
  // the switch — a click ignored for a round trip (check:live, 1b).
  const inFlightNow = useRef(0);
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** The action last picked from the library, for the inspector to configure. */
  const [pick, setPick] = useState<Pick | null>(null);

  // Follow the decks: any change to the config or to what the
  // decks show moves the breadcrumb to match — unconditionally, mid-edit too.
  // The first time the daemon reports its decks, the decks remembered as
  // shown join the one the editor opened on (model.ts restoreShown).
  const restored = useRef(false);
  useEffect(() => {
    if (inFlight > 0) return;
    const restore = !restored.current && daemon.connected && daemon.decks !== null;
    if (restore) restored.current = true;
    setSelection((current) => (inFlightNow.current > 0 ? current : followDeck(config, daemon, restore ? restoreShown(config, daemon, current, rememberedShown) : current)));
  }, [config, daemon, inFlight]);

  // The latest daemon view, for code waiting inside a switch.
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;

  /**
   * Send a switch and hold the breadcrumb on the choice until the daemon's
   * state shows it. The daemon replies to a switch before its merged `state`
   * event arrives, so resuming on the reply would let the breadcrumb jump back
   * for a moment. At most a second, then follow whatever the deck reports.
   */
  const sendSwitch = async (call: () => Promise<DaemonResult>, shows: (view: DaemonView) => boolean) => {
    inFlightNow.current++;
    setInFlight((n) => n + 1);
    try {
      const result = await call();
      setSwitchError(result.ok ? null : `Could not switch the deck: ${result.error}`);
      if (result.ok) {
        const started = Date.now();
        while (!shows(daemonRef.current) && Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      // Back to following: if the switch failed, the breadcrumb returns to what the deck really shows.
      inFlightNow.current--;
      setInFlight((n) => n - 1);
    }
  };
  const deckShows = (serial: string, check: (deck: { profile?: string; page?: string }) => boolean) => (view: DaemonView) =>
    view.status?.decks.some((d) => d.serial === serial && check(d)) ?? false;

  const select = (change: Partial<Selection>) => {
    if (change.profile !== undefined && change.profile !== selection.profile) {
      // Live switching: choosing a profile makes it active on the decks.
      const profile = change.profile;
      const serial = deckForProfile(config, daemon, profile, selection.serial);
      const layout = layoutFor(config, profile, serial);
      setSelection(reconcileSelection(config, daemon, { profile, serial, page: layout ? startPageOf(layout) : '', key: null, keys: [], others: othersToStartPages(selection.others) }));
      if (daemon.connected) {
        void sendSwitch(
          () => window.deckhand.switchProfile(profile),
          (view) => view.status?.activeProfile?.id === profile,
        );
      }
      return;
    }
    if (change.serial !== undefined && change.serial !== selection.serial) {
      // Choosing a device opens whatever that deck is showing, alone; nothing is sent.
      setSelection(followDeck(config, daemon, { ...selection, serial: change.serial, key: null, keys: [], others: {} }));
      return;
    }
    if (change.page !== undefined && change.page !== selection.page) {
      // Live switching: choosing a page shows it on the deck being edited.
      const page = change.page;
      const serial = selection.serial;
      setSelection(reconcileSelection(config, daemon, { ...selection, page, key: null, keys: [] }));
      if (canSwitchDeck(daemon, serial)) {
        void sendSwitch(
          () => window.deckhand.showPage(serial, page),
          deckShows(serial, (d) => d.page === page),
        );
      }
    }
  };

  const editingBlocked = store.conflict !== null || store.fileError !== null;
  const layout = layoutFor(config, selection.profile, selection.serial);
  const page = layout?.pages[selection.page];
  const geometry = geometryFor(daemon, selection.serial);
  /** Why there is no grid, or null when there is one. */
  const nothing = emptyState(config, daemon, selection);
  /** The decks drawn. One is today's editor exactly: no panels, no headers. */
  const shown = shownDecks(config, daemon, selection);
  const several = shown.length > 1;
  /** A key on another shown deck: that deck takes the focus, with this key alone selected. */
  const focusKey = (serial: string, index: number) =>
    setSelection((s) => ({ ...focusDeck(s, serial), key: index, keys: [index] }));

  const selectKeys = (keys: number[]) =>
    setSelection((s) => ({ ...s, key: keys.length === 0 ? null : keys[keys.length - 1], keys }));
  const bulk = useBulk({ config, daemon, selection, layout, page, geometry, editingBlocked, selectKeys });
  const [keyMenu, setKeyMenu] = useState<{ x: number; y: number } | null>(null);
  /** The key under the pointer while a key is dragged, on whichever deck: drawn by that deck's grid. */
  const [keyDragOver, setKeyDragOver] = useState<KeyRef | null>(null);

  // An action dragged from the library onto a key: a new button there.
  // Written first, then the key is selected and its form shown — the
  // pick comes after the write so the inspector sees the new action.
  // On another shown deck, the drop focuses it and the new button is made there.
  const actionDrag = useActionDrag((type, { serial, index }) => {
    const pageId = pageOf(selection, serial);
    if (editingBlocked || pageId === null || !layoutFor(config, selection.profile, serial)?.pages[pageId]) return;
    const at = { profile: selection.profile, serial, page: pageId, index };
    if (serial === selection.serial) selectKeys([index]);
    else focusKey(serial, index);
    void window.deckhand.apply({ kind: 'assignAction', at, action: { type } }).then((result) => {
      if (!result.ok) {
        setSwitchError(`Could not put ${actionName(type)} on key ${index + 1}: ${result.error}`);
        return;
      }
      setSwitchError(null);
      setPick((current) => ({ type, token: (current?.token ?? 0) + 1, click: false }));
    });
  });
  useBulkShortcuts({
    enabled: page !== undefined && geometry !== null && !editingBlocked,
    hasSelection: selection.keys.length > 0,
    onCopy: bulk.copy,
    onPaste: () => void bulk.paste(),
    onDuplicate: () => void bulk.duplicate(),
    onClear: () => void bulk.clear(),
    onSelectAll: () => geometry && selectKeys(geometry.keys.map((k) => k.index)),
    onSelectNone: () => selectKeys([]),
  });

  // Pane widths: dragged by the dividers, and deliberately not persisted — a
  // fresh editor opens at the defaults.
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(DEFAULT_PANE_WIDTHS);
  const resizePane = (pane: PaneName, width: number) => setPaneWidths((current) => ({ ...current, [pane]: width }));

  const appIcons = appIconsOf(daemon.apps);

  // Icon files on this page are watched while it is shown, so a file renamed
  // away or put back reaches the grid. The stamp goes in
  // the icon URL; without it Chromium keeps the image it loaded first. Default
  // icons count: they are files too, in the app's assets/icons/.
  const [iconStamps, setIconStamps] = useState<Record<string, string>>({});
  // Both halves of a state pair the daemon reports per key (a toggle), so
  // the icon it flips to is stamped too rather than fetched unstamped.
  // Not `.map(faceIcon)`: that passes the array index as the second argument.
  // Every shown deck's page: with several shown, each grid draws its icons.
  const shownPages = shown.flatMap((serial) => {
    const shownPage = layoutFor(config, selection.profile, serial)?.pages[pageOf(selection, serial) ?? ''];
    return shownPage ? [shownPage] : [];
  });
  const pageIcons = [
    ...new Set(
      shownPages
        .flatMap((p) => Object.values(p.buttons))
        .flatMap((b) => [faceIcon(b, false, appIcons), faceIcon(b, true, appIcons)])
        .filter((i): i is string => i !== null),
    ),
  ];
  const iconsKey = pageIcons.join('\u0000');
  useEffect(() => {
    let alive = true;
    void window.deckhand.watchIconFiles(pageIcons).then((stamps) => alive && setIconStamps(stamps));
    const stop = window.deckhand.onIconStamps((stamps) => alive && setIconStamps(stamps));
    return () => {
      alive = false;
      stop();
    };
  }, [iconsKey]);


  const addPage = async (name: string): Promise<AddPageResult> => {
    const result = await window.deckhand.apply({ kind: 'addPage', profile: selection.profile, serial: selection.serial, name });
    return result.ok ? { ok: true, page: result.result.pageId! } : { ok: false, error: result.error };
  };

  // A new profile is empty, so its decks need somewhere to start: every layout
  // it creates gets one page. Selecting it afterwards is what switches the
  // decks — the ordinary breadcrumb path, not a special case.
  const addProfile = async (name: string, serials: string[]): Promise<AddProfileResult> => {
    const result = await window.deckhand.apply({ kind: 'addProfile', name, serials, pageName: 'Main' });
    return result.ok ? { ok: true, profile: result.result.profileId! } : { ok: false, error: result.error };
  };

  /**
   * Select a profile that was just created. It cannot go through select(),
   * which reads the `config` of the render it was made in — that copy does not
   * have the new profile, so reconcileSelection falls back to the active one
   * and nothing switches. Here the selection is set outright, and sendSwitch
   * holds it until the daemon reports the profile active; by then the reloaded
   * config has arrived and the follow effect reconciles it onto the right page.
   */
  const selectNewProfile = (profile: string) => {
    setSelection((current) => ({ ...current, profile, page: '', key: null, keys: [], others: othersToStartPages(current.others) }));
    if (daemon.connected) {
      void sendSwitch(
        () => window.deckhand.switchProfile(profile),
        (view) => view.status?.activeProfile?.id === profile,
      );
    }
  };

  const [addLayoutError, setAddLayoutError] = useState<string | null>(null);
  const addLayout = async (serial = selection.serial) => {
    const result = await window.deckhand.apply({
      kind: 'addLayout',
      profile: selection.profile,
      serial,
      pageName: 'Main',
    });
    setAddLayoutError(result.ok ? null : result.error);
  };

  // Deleting a page is confirmed here rather than in the toolbar, because the
  // confirmation has to name the keys it is about to clear.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const deletion = pendingDelete === null ? null : pageDeletion(config, selection.profile, selection.serial, pendingDelete);
  const confirmDelete = async () => {
    if (pendingDelete === null) return;
    const result = await window.deckhand.apply({
      kind: 'deletePage',
      profile: selection.profile,
      serial: selection.serial,
      page: pendingDelete,
    });
    setPendingDelete(null);
    if (!result.ok) setSwitchError(`Could not delete the page: ${result.error}`);
  };

  // Deleting a profile. The confirmation runs the same planning the
  // delete does (shared/profile-deletion.ts) on this config, so what it names
  // is what will happen. The card stays open afterwards to say where the
  // configuration it replaced was kept.
  const [pendingProfileDelete, setPendingProfileDelete] = useState<string | null>(null);
  const [profileDeleted, setProfileDeleted] = useState<{ name: string; backup: string | null } | null>(null);
  const [profileDeleteError, setProfileDeleteError] = useState<string | null>(null);
  const profileDeletion = (() => {
    if (pendingProfileDelete === null || !Object.prototype.hasOwnProperty.call(config.profiles, pendingProfileDelete)) return null;
    try {
      return { plan: planProfileDeletion(config, pendingProfileDelete), refusal: null };
    } catch (err) {
      return { plan: null, refusal: (err as Error).message };
    }
  })();
  const confirmProfileDelete = async () => {
    if (pendingProfileDelete === null) return;
    const name = profileLabel(config, pendingProfileDelete);
    const result = await window.deckhand.deleteProfile(pendingProfileDelete, 'Main');
    setPendingProfileDelete(null);
    if (result.ok) setProfileDeleted({ name, backup: result.backup });
    else setProfileDeleteError(result.error);
  };

  /** Another shown deck's Page ▾: that deck alone moves, on screen and on the deck, as a tab does for the focused one. */
  const showDeckPage = (serial: string, pageId: string) => {
    setSelection((s) => setDeckPage(s, serial, pageId));
    if (canSwitchDeck(daemon, serial)) {
      void sendSwitch(
        () => window.deckhand.showPage(serial, pageId),
        deckShows(serial, (d) => d.page === pageId),
      );
    }
  };

  /**
   * One deck's grid, or null when it has none to draw (no layout, geometry or
   * page). The focused deck's is the grid the editor has always drawn; a key
   * on any other shown deck focuses that deck first, and a key drag there
   * swaps on that deck.
   */
  const grid = (serial: string) => {
    const focused = serial === selection.serial;
    const pageId = pageOf(selection, serial) ?? '';
    const gridPage = layoutFor(config, selection.profile, serial)?.pages[pageId];
    const gridGeometry = geometryFor(daemon, serial);
    if (!gridPage || !gridGeometry) return null;
    const at = { profile: selection.profile, serial, page: pageId };
    return (
      <DeckGrid
        config={config}
        geometry={gridGeometry}
        page={gridPage}
        iconStamps={iconStamps}
        appIcons={appIcons}
        failedKeys={failedKeysOn(daemon, at)}
        latchedKeys={latchedKeysOn(daemon, at)}
        selectedKeys={focused ? selection.keys : []}
        onClickKey={(index, modifiers) =>
          focused ? setSelection((s) => ({ ...s, ...clickKeys(gridGeometry, s, index, modifiers) })) : focusKey(serial, index)
        }
        onMoveKey={
          editingBlocked
            ? null
            : focused
              ? (from, to) => void bulk.move(from, to)
              : (from, to) => {
                  focusKey(serial, to);
                  void bulk.move(from, to, { serial, page: pageId, def: gridPage });
                }
        }
        onCopyKey={
          editingBlocked || !several
            ? null
            : (from, to) => {
                const toPage = pageOf(selection, to.serial);
                if (toPage === null) return;
                // The copy is on screen, so its deck takes the focus with the copy selected, as a library drop does.
                focusKey(to.serial, to.index);
                void bulk.copyKey({ serial, page: pageId, def: gridPage, index: from }, { serial: to.serial, page: toPage, index: to.index });
              }
        }
        onKeyDragOver={setKeyDragOver}
        dropTarget={
          actionDrag.drag?.over?.serial === serial ? actionDrag.drag.over.index : keyDragOver?.serial === serial ? keyDragOver.index : null
        }
        onKeyMenu={(index, x, y) => {
          // Right-clicking a key outside the selection acts on that key alone, as a file manager does.
          if (!focused) focusKey(serial, index);
          else if (!selection.keys.includes(index)) selectKeys([index]);
          if (!editingBlocked) setKeyMenu({ x, y });
        }}
      />
    );
  };

  /** Why a deck has no grid (model.ts emptyState), and the way to give it one where there is. */
  const emptyCard = (why: ReturnType<typeof emptyState>, serial: string) => {
    if (!why) return null;
    return (
      <div className="no-layout" data-empty-state={why.kind}>
        <p className="empty-title">{why.title}</p>
        <p className="muted">{why.detail}</p>
        {why.canAddLayout && (
          <button className="primary" disabled={editingBlocked} onClick={() => void addLayout(serial)}>
            Add a layout for {deckLabel(config, daemon, serial)}
          </button>
        )}
        {addLayoutError && <p className="field-error">{addLayoutError}</p>}
      </div>
    );
  };

  return (
    <div className="app">
      <Toolbar
        config={config}
        daemon={daemon}
        selection={selection}
        editingBlocked={editingBlocked}
        onSelect={select}
        onAddPage={addPage}
        onAddProfile={addProfile}
        onProfileAdded={selectNewProfile}
        onRenameDeck={async (serial, name) => {
          const result = await window.deckhand.apply({ kind: 'renameDeck', serial, name });
          return result.ok ? null : result.error;
        }}
        onRenamePage={async (page, name) => {
          const result = await window.deckhand.apply({
            kind: 'renamePage',
            profile: selection.profile,
            serial: selection.serial,
            page,
            name,
          });
          return result.ok ? null : result.error;
        }}
        onRenameProfile={async (profile, name) => {
          const result = await window.deckhand.apply({ kind: 'renameProfile', profile, name });
          return result.ok ? null : result.error;
        }}
        onDeleteProfile={(profile) => {
          setProfileDeleted(null);
          setProfileDeleteError(null);
          setPendingProfileDelete(profile);
        }}
        onDeletePage={setPendingDelete}
        shown={shown}
        onShowOnly={(serial) => {
          select({ serial });
          void window.deckhand.setShownDecks([serial]);
        }}
        onSetShown={(serial, visible) => {
          const next = setShown(config, selection, serial, visible, shown);
          setSelection(next);
          void window.deckhand.setShownDecks(shownDecks(config, daemon, next));
        }}
      />
      <div className="panes" style={{ gridTemplateColumns: paneColumns(paneWidths) }}>
        <Library
          onPick={(type) => {
            if (actionDrag.takeSuppressedClick()) return;
            if (selection.keys.length === 1) setPick((current) => ({ type, token: (current?.token ?? 0) + 1, click: true }));
          }}
          onDragStart={editingBlocked || !page || !geometry ? null : actionDrag.start}
        />
        <PaneDivider pane="library" width={paneWidths.library} onResize={resizePane} label="Resize the action library" />
        <main className="stage glass">
          {/* Say it once: when the empty state below already explains that
              the daemon is not running, the banner would only repeat it. */}
          <Notices store={store} daemon={daemon} switchError={switchError} daemonSaidBelow={nothing?.kind === 'daemon-down'} />
          <div className={several ? 'well well-canvas' : 'well'}>
            {several ? (
              <DeckCanvas
                decks={shown.flatMap((serial): CanvasDeck[] => {
                  // A deck the daemon has not described yet is not drawn for that moment: its size is unknown.
                  const g = geometryFor(daemon, serial);
                  return g ? [{ serial, name: deckLabel(config, daemon, serial), size: { columns: g.columns, rows: g.rows } }] : [];
                })}
                positions={positions}
                onMove={moveDecks}
                locked={locked}
                onLock={lockDeck}
                panel={(serial, placement) => {
                  const layoutHere = layoutFor(config, selection.profile, serial);
                  return (
                    <DeckPanel
                      key={serial}
                      serial={serial}
                      name={deckLabel(config, daemon, serial)}
                      size={geometryFor(daemon, serial)}
                      focused={serial === selection.serial}
                      pages={layoutHere ? pageChoices(layoutHere) : []}
                      page={pageOf(selection, serial) ?? ''}
                      disabled={editingBlocked}
                      onFocus={() => setSelection((s) => focusDeck(s, serial))}
                      onPage={(pageId) => showDeckPage(serial, pageId)}
                      placement={placement}
                    >
                      {grid(serial) ?? emptyCard(emptyState(config, daemon, { profile: selection.profile, serial }), serial)}
                    </DeckPanel>
                  );
                }}
              />
            ) : (
              <>
                {/* One place says why there is no grid (model.ts emptyState). */}
                {nothing && emptyCard(nothing, selection.serial)}
                {grid(selection.serial)}
              </>
            )}
            {keyMenu && (
              <KeyMenu
                x={keyMenu.x}
                y={keyMenu.y}
                count={selection.keys.length}
                bulk={bulk}
                serial={selection.serial}
                otherPages={layout ? pageChoices(layout).filter((p) => p.id !== selection.page) : []}
                devices={deviceTargets(config, daemon, selection)}
                onClose={() => setKeyMenu(null)}
              />
            )}
            {(profileDeletion || profileDeleted || profileDeleteError) && (
              <DeleteProfile
                name={pendingProfileDelete === null ? (profileDeleted?.name ?? '') : profileLabel(config, pendingProfileDelete)}
                deletion={profileDeletion}
                done={profileDeleted}
                error={profileDeleteError}
                config={config}
                daemon={daemon}
                onConfirm={() => void confirmProfileDelete()}
                onClose={() => {
                  setPendingProfileDelete(null);
                  setProfileDeleted(null);
                  setProfileDeleteError(null);
                }}
              />
            )}
            {layout && deletion && pendingDelete !== null && (
              <DeletePage
                name={pageLabel(layout, pendingDelete)}
                deletion={deletion}
                pageName={(page: string) => pageLabel(layout, page)}
                onConfirm={() => void confirmDelete()}
                onCancel={() => setPendingDelete(null)}
              />
            )}
          </div>
          <BulkStatus bulk={bulk} />
        </main>
        <PaneDivider pane="inspector" width={paneWidths.inspector} onResize={resizePane} label="Resize the inspector" />
        <Inspector
          selectedCount={selection.keys.length}
          bulk={bulk}
          at={selection.key === null || !page ? null : { profile: selection.profile, serial: selection.serial, page: selection.page, index: selection.key }}
          button={selection.key === null ? undefined : page?.buttons[String(selection.key)]}
          editingBlocked={editingBlocked}
          pick={pick}
          pages={layout ? pageChoices(layout) : []}
          profiles={profileChoices(config)}
          coverage={(profile) => profileCoverage(config, daemon, profile)}
          labelDefaults={labelDefaults(config)}
          canPreview={canSwitchDeck(daemon, selection.serial)}
          audio={daemon.audio}
          apps={daemon.apps}
          apply={async (edit) => {
            const result = await window.deckhand.apply(edit);
            return result.ok ? null : result.error;
          }}
        />
      </div>
      {actionDrag.drag && <DragLabel drag={actionDrag.drag} />}
    </div>
  );
}

/**
 * What is being dragged, following the pointer. Rendered into document.body:
 * inside a glass pane, `backdrop-filter` makes the pane the containing block
 * for `position: fixed`.
 */
function DragLabel({ drag }: { drag: ActionDrag }) {
  const icon = libraryIcon(drag.type);
  return createPortal(
    <div className="action-drag" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
      {icon && <img src={iconUrl(builtinRef(icon))} alt="" draggable={false} />}
      {actionName(drag.type)}
    </div>,
    document.body,
  );
}

/**
 * Deleting a profile: what it will change, named before it happens —
 * every key that loses its switch, where Deckhand will start, a deck that
 * would otherwise be left with no layout, and any page left with no way off.
 * The plan comes from the same code the delete runs (shared/profile-deletion.ts).
 *
 * After it is done the card stays, to say where the configuration it replaced
 * was kept: a delete can take a deck's worth of keys with it, and the editor
 * has no undo.
 */
function DeleteProfile({
  name,
  deletion,
  done,
  error,
  config,
  daemon,
  onConfirm,
  onClose,
}: {
  name: string;
  deletion: { plan: ProfileDeletion | null; refusal: string | null } | null;
  done: { name: string; backup: string | null } | null;
  error: string | null;
  config: Config;
  daemon: DaemonView;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const label = "Delete profile";
  if (done) {
    return (
      <div className="confirm-card glass" role="alertdialog" aria-label={label}>
        <p>
          <strong>“{done.name}” is deleted.</strong>
        </p>
        {done.backup && <p className="muted small">Your configuration from before the delete is kept at {done.backup}. Restore it from Settings.</p>}
        <div className="button-row">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }
  if (error || deletion?.refusal) {
    return (
      <div className="confirm-card glass" role="alertdialog" aria-label={label}>
        <p>
          <strong>“{name}” cannot be deleted.</strong> {error ?? deletion?.refusal}
        </p>
        <div className="button-row">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }
  const plan = deletion?.plan;
  if (!plan) return null;
  return (
    <div className="confirm-card glass" role="alertdialog" aria-label={label}>
      <p>
        Delete <strong>“{name}”</strong>, its pages and everything on them?
      </p>
      {plan.links.length > 0 && (
        <>
          <p className="warning-text">
            {plan.links.length === 1 ? '1 key switches to it' : `${plan.links.length} keys switch to it`} and will lose that action. Their
            icons and labels stay.
          </p>
          <ul className="link-list">
            {plan.links.map((link) => (
              <li key={`${link.profile}/${link.serial}/${link.page}/${link.index}/${link.where}`}>
                {profileLabel(config, link.profile)} · {deckLabel(config, daemon, link.serial)} ·{' '}
                {pageLabelIn(config, link.profile, link.serial, link.page)} · key {link.index + 1}
                {link.where === 'onRelease' ? ' (on release)' : ''}
                {link.inMulti ? ' — one step of a multi action' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.freshLayouts.length > 0 && (
        <p className="warning-text">
          {plan.freshLayouts.map((serial) => `“${deckLabel(config, daemon, serial)}”`).join(' and ')}{' '}
          {plan.freshLayouts.length === 1 ? 'is in no other profile, so it gets an empty page' : 'are in no other profile, so they get an empty page each'} in “
          {profileLabel(config, plan.freshLayoutsIn)}” rather than going dark.
        </p>
      )}
      {plan.startProfileMovesTo && (
        <p className="muted small">Deckhand will start on “{profileLabel(config, plan.startProfileMovesTo)}”.</p>
      )}
      {plan.stranded.length > 0 && (
        <>
          <p className="warning-text">
            {plan.stranded.length === 1 ? '1 page will have' : `${plan.stranded.length} pages will have`} no key that leaves it, so there is
            no way off from the deck:
          </p>
          <ul className="link-list">
            {plan.stranded.map((page) => (
              <li key={`${page.profile}/${page.serial}/${page.page}`}>
                {profileLabel(config, page.profile)} · {deckLabel(config, daemon, page.serial)} ·{' '}
                {pageLabelIn(config, page.profile, page.serial, page.page)}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Your configuration is kept first, and can be restored from Settings.</p>
      <div className="button-row">
        <button onClick={onClose}>Cancel</button>
        <button className="danger" onClick={onConfirm}>
          Delete profile
        </button>
      </div>
    </div>
  );
}

/**
 * The delete confirmation. It names every key that navigates to this page,
 * because deleting clears those actions: the daemon logs and
 * does nothing for a page action whose target is gone, so leaving them would
 * leave keys that are dead without looking it. It also says where the deck will
 * start afterwards, which can change even when nothing pointed at the page.
 */
function DeletePage({
  name,
  deletion,
  pageName,
  onConfirm,
  onCancel,
}: {
  name: string;
  deletion: NonNullable<ReturnType<typeof pageDeletion>>;
  pageName: (page: string) => string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (deletion.refusal !== null) {
    return (
      <div className="confirm-card glass" role="alertdialog" aria-label="Delete page">
        <p>
          <strong>“{name}” cannot be deleted.</strong> {deletion.refusal}
        </p>
        <div className="button-row">
          <button onClick={onCancel}>Close</button>
        </div>
      </div>
    );
  }
  return (
    <div className="confirm-card glass" role="alertdialog" aria-label="Delete page">
      <p>
        Delete <strong>“{name}”</strong> and everything on it?
      </p>
      {deletion.links.length > 0 && (
        <>
          <p className="warning-text">
            {deletion.links.length === 1 ? '1 key navigates here' : `${deletion.links.length} keys navigate here`} and will lose that
            action. Their icons and labels stay.
          </p>
          <ul className="link-list">
            {deletion.links.map((link) => (
              <li key={`${link.page}/${link.index}/${link.where}`}>
                {pageName(link.page)} · key {link.index + 1}
                {link.where === 'onRelease' ? ' (on release)' : ''}
                {link.inMulti ? ' — one step of a multi action' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {deletion.startPageAfter !== null && (
        <p className="muted small">This deck will start on “{pageName(deletion.startPageAfter)}” instead.</p>
      )}
      <div className="button-row">
        <button className="danger" onClick={onConfirm}>
          Delete page
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Ctrl+C, Ctrl+V, Ctrl+D, Delete, Ctrl+A and Escape on the grid.
 *
 * Never while typing in a field — Ctrl+C there copies text — and never while
 * the hotkey inspector is recording, when Escape or Delete is the combo being
 * recorded. That is an explicit flag (key-capture.ts) rather than trust in
 * listener order, which differs for a key dispatched at `window` itself.
 */
function useBulkShortcuts(handlers: {
  enabled: boolean;
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onClear: () => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  // The latest handlers, so the listener is added once rather than every render.
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const h = latest.current;
      if (!h.enabled || keyCapture.active || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      let handled = true;
      if (ctrl && event.code === 'KeyV') h.onPaste();
      else if (ctrl && event.code === 'KeyA') h.onSelectAll();
      else if (!h.hasSelection) handled = false;
      else if (ctrl && event.code === 'KeyC') h.onCopy();
      else if (ctrl && event.code === 'KeyD') h.onDuplicate();
      else if (plain && event.code === 'Delete') h.onClear();
      else if (plain && event.code === 'Escape') h.onSelectNone();
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
