import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULTS, startPageOf } from '../../../src/config-common.js';
import type { ButtonDef, Config, PageBackgroundDef, PageDef, PanelDef } from '../../../src/types.js';
import { defaultPanelOf, isCustomLayout, pagePanelIn } from '../../../src/panel-presets.js';
import { geometryOfPanel } from '../../../src/geometry.js';
import { addControl, blankPanel, buttonsFor, controlNames, duplicateControls, layoutChanges } from '../shared/layout-edit.js';
import { NEEDS_VALUE, takesValue, type ControlKind } from '../../../src/value-controls.js';
import { DEFAULT_GUIDES, nudge, type Guides } from '../shared/layout-arrange.js';
import { ControlsPalette, DeleteControl, DiscardChanges, GuidesBar, LayoutCanvas, LayoutInspector, ModeBar } from './LayoutEditor.js';
import { useVirtualScreen } from './GridPicker.js';
import { GAP_PX, PAD_X_PX, PITCH_PX, type DeckSize } from './canvas.js';
import { BackgroundPanel } from './BackgroundPanel.js';
import { ChangeLayout } from './ChangeLayout.js';
import { MadeForChip, SaveAsTemplate } from './Templates.js';
import { madeForAnother, templateNamed } from '../shared/templates.js';
import { planProfileDeletion, type ProfileDeletion } from '../shared/profile-deletion.js';
import type { DaemonResult, DaemonView, StoreState } from '../shared/bridge.js';
import { DeckGrid } from './DeckGrid.js';
import { DeckCanvas, type CanvasDeck } from './DeckCanvas.js';
import { DeckPanel } from './DeckPanel.js';
import { roundPosition } from './canvas.js';
import { keyKind } from './model.js';
import { withPosition, type DeckPositions } from '../shared/deck-positions.js';
import { Inspector, type Pick } from './Inspector.js';
import { Library } from './Library.js';
import { actionName, libraryIcon } from './catalogue.js';
import { builtinRef, iconUrl, keyStates } from '../shared/icons.js';
import { useActionDrag, type ActionDrag } from './useActionDrag.js';
import type { KeyRef } from './keyUnder.js';
import {
  canSwitchDeck,
  keyBoxOf,
  clickKeys,
  deckForProfile,
  deviceTargets,
  emptyState,
  failedKeysOn,
  notSetUp,
  notSetUpText,
  settingsSectionOf,
  latchedKeysOn,
  liveFacesOn,
  valuesOn,
  focusDeck,
  followDeck,
  othersToStartPages,
  pageOf,
  restoreShown,
  setDeckPage,
  setShown,
  shownDecks,
  geometryFor,
  pageGeometry,
  layoutFor,
  labelDefaults,
  pageChoices,
  pageDeletion,
  pageLabel,
  pageLabelIn,
  profileLabel,
  deckLabel,
  profileChoices,
  knownDecks,
  virtualDeckChoices,
  profileCoverage,
  reconcileSelection,
  faceIcon,
  watchedImages,
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
import { keyNumber } from '../shared/bulk.js';
import { useEditor } from './useEditor.js';
import type { Edit } from '../shared/edits.js';

/**
 * Edit layout, while it is open (round 2a): the deck, profile and page being
 * edited; the page as the mode found it (`entry`: what Discard changes and an
 * emptied layout put back, deleted controls with their keys); and whether the
 * layout is shown empty — Blank before its first control, or after its last
 * was deleted — which is never saved (Ryan, 2026-11-18). `seenOnDeck`: the
 * deck has shown this page since the mode opened, so it moving off means a
 * deck key changed page or profile, which acts as Done.
 */
interface LayoutMode {
  serial: string;
  profile: string;
  page: string;
  entry: PageDef & { panel: PanelDef };
  blank: boolean;
  startedBlank: boolean;
  seenOnDeck: boolean;
}

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

  /** Edit layout, while open (round 2a): see LayoutMode. */
  const [mode, setMode] = useState<LayoutMode | null>(null);
  /** The mode's warnings: deleting controls with keys, Discard changes. */
  const [modeCard, setModeCard] = useState<{ kind: 'delete'; ids: string[] } | { kind: 'discard' } | null>(null);
  /** Edit layout's Grid, its pitch, and Snap (22g): editor preferences, the same for every deck. */
  const [guides, setGuidesState] = useState<Guides>(DEFAULT_GUIDES);
  useEffect(() => {
    void window.deckhand.layoutGuides().then(setGuidesState);
  }, []);
  const setGuides = (next: Guides) => {
    setGuidesState(next);
    void window.deckhand.setLayoutGuides(next);
  };
  /** The mode asked for on a page not in this config yet (just made from Blank): opened once it arrives. */
  const [pendingEnter, setPendingEnter] = useState<{ serial: string; profile: string; page: string; blank: boolean;  } | null>(null);
  /** A layout just saved, drawn until the saved config comes back, so a released drag does not jump back for a moment. */
  const [optimistic, setOptimistic] = useState<{ panel: PanelDef; blank: boolean } | null>(null);
  useEffect(() => setOptimistic(null), [config]);
  /** Each virtual deck's header width, as it reports it: its frame is never narrower (Ryan, 2026-11-18). */
  const [headerNeeds, setHeaderNeeds] = useState<Record<string, number>>({});
  const noteHeaderNeed = (serial: string, px: number) => setHeaderNeeds((h) => (h[serial] === px ? h : { ...h, [serial]: px }));

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
  const geometry = pageGeometry(config, daemon, selection.serial, selection.profile, selection.page);
  /** Why there is no grid, or null when there is one. */
  const nothing = emptyState(config, daemon, selection);

  // ---- Edit layout (round 2a) ----
  const modePage = mode ? layoutFor(config, mode.profile, mode.serial)?.pages[mode.page] : undefined;
  /** A virtual deck's screen, as the editor knows it: its default panel's canvas (main.ts virtualScreenSize). */
  const screenOf = (serial: string) => defaultPanelOf(config, serial)?.size;
  // Shown empty while blank. A page not custom (yet) is one whose first control's save is still on its way
  // back: until it arrives, whatever was just saved is drawn (optimistic, below), else the empty layout.
  const savedPanel: PanelDef | null =
    !mode || !modePage
      ? null
      : !mode.blank && isCustomLayout(modePage.panel)
        ? (modePage.panel ?? null)
        : blankPanel(screenOf(mode.serial) ?? mode.entry.panel.size);
  /** The layout as the mode draws it: what was just saved, until the config catches up. */
  const modePanel = optimistic && mode ? optimistic.panel : savedPanel;
  const modeBlank = optimistic && mode ? optimistic.blank : (mode?.blank ?? false);
  const modeScreen = useVirtualScreen(mode?.serial ?? null);
  /** The keys the page had when the mode opened: a new control's id is never one of them, so Discard never meets a reused id. */
  const entryIds = mode ? [...mode.entry.panel.controls.map((c) => c.id), ...Object.keys(mode.entry.buttons)] : [];
  const modeChanges = mode && modePanel ? layoutChanges(mode.startedBlank ? blankPanel(modePanel.size) : mode.entry.panel, modePanel) : null;
  const modeChanged = modeChanges !== null && (modeChanges.added + modeChanges.moved + modeChanges.deleted > 0 || modeChanges.reordered);

  const leaveMode = () => {
    setMode(null);
    setModeCard(null);
    setOptimistic(null);
    setSelection((s) => ({ ...s, key: null, keys: [] }));
  };

  /** Open Edit layout on a page of a virtual deck: that deck focused, that page shown, on the deck too. */
  const enterMode = (serial: string, pageId: string, blank: boolean, pageDef: PageDef) => {
    const profile = selection.profile;
    const panel = pageDef.panel ?? pagePanelIn(config, profile, serial, pageId);
    if (!panel) return;
    setPendingDelete(null);
    setChangingLayout(null);
    setKeyMenu(null);
    setSelection((s) => ({ ...(s.serial === serial ? s : focusDeck(s, serial)), page: pageId, key: null, keys: [] }));
    const deck = daemon.status?.decks.find((d) => d.serial === serial);
    if (canSwitchDeck(daemon, serial) && deck?.page !== pageId) {
      void sendSwitch(() => window.deckhand.showPage(serial, pageId), deckShows(serial, (d) => d.page === pageId));
    }
    setMode({ serial, profile, page: pageId, entry: { ...structuredClone(pageDef), panel: structuredClone(panel) }, blank, startedBlank: blank, seenOnDeck: false });
  };

  useEffect(() => {
    if (!pendingEnter) return;
    const p = layoutFor(config, pendingEnter.profile, pendingEnter.serial)?.pages[pendingEnter.page];
    if (!p) return;
    setPendingEnter(null);
    if (pendingEnter.profile === selection.profile) enterMode(pendingEnter.serial, pendingEnter.page, pendingEnter.blank, p);
  }, [config, pendingEnter]);

  // Every way of leaving acts as Done (2026-11-17, 2026-11-18): another
  // profile, a deck key that changes the page or the profile, the page or the
  // deck gone. Nothing needs saving: every change is saved as it is made, and
  // an empty layout is never saved — the page is already as it will stay.
  useEffect(() => {
    if (!mode) return;
    if (selection.profile !== mode.profile || !modePage || geometryFor(daemon, mode.serial) === null) {
      leaveMode();
      return;
    }
    const deck = daemon.status?.decks.find((d) => d.serial === mode.serial);
    const onPage = deck?.profile === mode.profile && deck?.page === mode.page;
    if (onPage && !mode.seenOnDeck) setMode({ ...mode, seenOnDeck: true });
    else if (deck && !onPage && mode.seenOnDeck) leaveMode();
  });

  /** Save a layout change, as it is made. A layout with no controls is never saved: the page goes back as the mode found it, and is shown empty. */
  const saveLayout = (panel: PanelDef, extra: Record<string, ButtonDef> = {}) => {
    if (!mode || !modePage) return;
    const at = { profile: mode.profile, serial: mode.serial, page: mode.page };
    let edit: Edit;
    if (panel.controls.length === 0) {
      setMode({ ...mode, blank: true });
      edit = { kind: 'restorePage', ...at, panel: mode.entry.panel, buttons: mode.entry.buttons };
    } else {
      // From Blank, or after every control went: the page's old keys go with its old layout.
      const buttons = buttonsFor(modeBlank ? { buttons: {} } : modePage, panel, extra);
      if (mode.blank) setMode({ ...mode, blank: false });
      edit = { kind: 'setLayout', ...at, panel, buttons };
    }
    setOptimistic({ panel: panel.controls.length === 0 ? blankPanel(panel.size) : panel, blank: panel.controls.length === 0 });
    void window.deckhand.apply(edit).then((result) => {
      if (result.ok) setSwitchError(null);
      else {
        setOptimistic(null);
        setSwitchError(`Could not save the layout: ${result.error}`);
      }
    });
  };

  /** The controls selected in the mode, in the order they were selected (22c): Ctrl-click and the marquee add to it. */
  const selectedControls = mode && modePanel ? selection.keys.filter((id) => modePanel.controls.some((c) => c.id === id)) : [];
  const addControlAt = (kind: ControlKind, clientX: number, clientY: number) => {
    if (!mode || !modePanel) return;
    const el = document.querySelector(`[data-layout-box="${CSS.escape(mode.serial)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
    const at = { x: ((clientX - r.left) / r.width) * modePanel.size.width, y: ((clientY - r.top) / r.height) * modePanel.size.height };
    const added = addControl(modePanel, kind, at, modeScreen, entryIds);
    saveLayout(added.panel);
    selectKeys([added.id]);
  };
  const addControlInMiddle = (kind: ControlKind) => {
    if (!mode || !modePanel) return;
    const added = addControl(modePanel, kind, { x: modePanel.size.width / 2, y: modePanel.size.height / 2 }, modeScreen, entryIds);
    saveLayout(added.panel);
    selectKeys([added.id]);
  };
  /** Duplicate: a copy of each selected control with its key, one grid step on (22h); the copies selected. */
  const duplicateSelected = () => {
    if (!mode || !modePanel || !modePage || selectedControls.length === 0) return;
    const copy = duplicateControls(modePanel, modeBlank ? { buttons: {} } : modePage, selectedControls, entryIds, guides.pitch);
    if (copy.ids.length === 0) return;
    saveLayout(copy.panel, copy.buttons);
    selectKeys(copy.ids);
  };
  /** Delete warns and names the keys lost; empty controls go at once (23a). */
  const deleteSelected = (ids: string[], confirmed: boolean) => {
    if (!mode || !modePanel || !modePage || ids.length === 0) return;
    if (!confirmed && !modeBlank && ids.some((id) => keyKind(modePage.buttons[id]) !== 'empty')) {
      setModeCard({ kind: 'delete', ids });
      return;
    }
    setModeCard(null);
    const gone = new Set(ids);
    saveLayout({ ...modePanel, controls: modePanel.controls.filter((c) => !gone.has(c.id)) });
    selectKeys([]);
  };
  /** The arrow keys: 1 px, or one grid step with the grid on; several together (22h). */
  const nudgeSelected = (dx: number, dy: number) => {
    if (!modePanel || selectedControls.length === 0) return;
    const moved = nudge(modePanel, selectedControls, dx, dy, guides);
    if (moved !== modePanel) saveLayout(moved);
  };
  /** Discard changes: the layout put back as the mode found it — deleted controls with their keys — then the mode closes. */
  const discardChanges = () => {
    if (!mode) return;
    const at = { profile: mode.profile, serial: mode.serial, page: mode.page };
    void window.deckhand.apply({ kind: 'restorePage', ...at, panel: mode.entry.panel, buttons: mode.entry.buttons }).then((result) => {
      if (!result.ok) setSwitchError(`Could not discard the changes: ${result.error}`);
    });
    leaveMode();
  };
  useModeShortcuts({
    enabled: mode !== null && modeCard === null,
    selected: selectedControls.length > 0,
    onDelete: () => deleteSelected(selectedControls, false),
    onDuplicate: duplicateSelected,
    onNudge: nudgeSelected,
    onSelectAll: () => modePanel && selectKeys(modePanel.controls.map((c) => c.id)),
    onSelectNone: () => selectKeys([]),
  });
  // The window's title names the mode while it is open (21a).
  useEffect(() => {
    const before = document.title;
    if (mode) document.title = `Edit layout — ${deckLabel(config, daemon, mode.serial)}`;
    return () => {
      document.title = before;
    };
  }, [mode?.serial]);

  /** The decks drawn, each in its frame with its header; the controls for arranging them only with two or more. In Edit layout, only the deck being edited (21a). */
  const shown = mode ? [mode.serial] : shownDecks(config, daemon, selection);
  const several = shown.length > 1;

  /**
   * A deck's frame on the canvas, in key units. A virtual deck's custom page
   * has no rows or columns: it is drawn at the height its deck's default grid
   * would take, so the frame does not jump from page to page (Ryan,
   * 2026-11-18), and as wide as its screen's proportions make that. A virtual
   * deck's frame is never narrower than its header needs.
   */
  const frameSize = (serial: string, g: { columns: number; rows: number }, pageId: string): DeckSize => {
    if (!config.decks?.[serial]?.virtual) return { columns: g.columns, rows: g.rows };
    const panel = mode && serial === mode.serial && modePanel ? modePanel : pagePanelIn(config, selection.profile, serial, pageId);
    let size: DeckSize = { columns: g.columns, rows: g.rows };
    if (panel && isCustomLayout(panel)) {
      const rows = Math.max(1, geometryOfPanel(defaultPanelOf(config, serial), '').rows || g.rows);
      const height = rows * PITCH_PX - GAP_PX;
      // The screen's proportions: a layout made for another size sits inside, scaled to fit and centred, as on the deck.
      const area = screenOf(serial) ?? panel.size;
      size = { rows, columns: Math.max(1, Math.round(((height * area.width) / area.height + GAP_PX) / PITCH_PX)) };
    }
    const need = headerNeeds[serial];
    if (need) size = { ...size, columns: Math.max(size.columns, Math.ceil((need - 2 * PAD_X_PX + GAP_PX) / PITCH_PX)) };
    return size;
  };
  /** The room a deck's keys have in its frame, in pixels at 100%. */
  const roomOf = (size: DeckSize) => ({ width: size.columns * PITCH_PX - GAP_PX, height: size.rows * PITCH_PX - GAP_PX });
  /** The shown decks the canvas can draw: a deck the daemon has not described yet is not drawn for that moment — its size is unknown. */
  const canvasDecks = shown.flatMap((serial): CanvasDeck[] => {
    const pageId = pageOf(selection, serial) ?? '';
    const g = pageGeometry(config, daemon, serial, selection.profile, pageId);
    return g ? [{ serial, name: deckLabel(config, daemon, serial), size: frameSize(serial, g, pageId) }] : [];
  });
  /** The header's size: columns × rows, or a virtual deck's screen resolution on a custom page (Ryan, 2026-11-18). */
  const sizeText = (serial: string, pageId: string): string | null => {
    const g = pageGeometry(config, daemon, serial, selection.profile, pageId);
    if (!g) return null;
    const panel = mode && serial === mode.serial && modePanel ? modePanel : pagePanelIn(config, selection.profile, serial, pageId);
    if (config.decks?.[serial]?.virtual && panel && isCustomLayout(panel)) {
      const screen = screenOf(serial) ?? panel.size;
      return `${screen.width} × ${screen.height}`;
    }
    return `${g.columns} × ${g.rows}`;
  };
  /** A key on another shown deck: that deck takes the focus, with this key alone selected. */
  const focusKey = (serial: string, key: string) =>
    setSelection((s) => ({ ...focusDeck(s, serial), key, keys: [key] }));

  const selectKeys = (keys: string[]) =>
    setSelection((s) => ({ ...s, key: keys.length === 0 ? null : keys[keys.length - 1], keys }));
  const bulk = useBulk({ config, daemon, selection, layout, page, geometry, editingBlocked, selectKeys });
  const [keyMenu, setKeyMenu] = useState<{ x: number; y: number } | null>(null);
  /** The background panel (24a): which virtual deck's, for the page it shows, and where its icon was. */
  const [backgroundOpen, setBackgroundOpen] = useState<{ serial: string; anchor: DOMRect } | null>(null);
  /** A background being changed in its panel and not saved yet (the opacity while it moves): drawn on that page only. */
  const [groundPreview, setGroundPreview] = useState<{ serial: string; page: string; background: PageBackgroundDef } | null>(null);
  // A saved change arrives as a new config: the preview has done its job.
  useEffect(() => setGroundPreview(null), [config]);
  // Edit layout dims the icon (19b), and a deck no longer shown has nothing to open it on.
  useEffect(() => {
    if (backgroundOpen && (mode !== null || !shownDecks(config, daemon, selection).includes(backgroundOpen.serial))) setBackgroundOpen(null);
  }, [mode, backgroundOpen, config, daemon, selection]);
  /** The key under the pointer while a key is dragged, on whichever deck: drawn by that deck's grid. */
  const [keyDragOver, setKeyDragOver] = useState<(KeyRef & { refused?: string | null }) | null>(null);

  // An action dragged from the library onto a key: a new button there.
  // Written first, then the key is selected and its form shown — the
  // pick comes after the write so the inspector sees the new action.
  // On another shown deck, the drop focuses it and the new button is made there.
  /** A control's kind on the page a deck shows: a slider or dial takes only an action carrying a value (round 5). */
  const kindAt = (serial: string, key: string): ControlKind | undefined => {
    const pageId = pageOf(selection, serial);
    return pageId === null ? undefined : (pageGeometry(config, daemon, serial, selection.profile, pageId)?.keys.find((k) => k.id === key)?.kind ?? 'button');
  };
  /** Whether an action may be dropped on a control: never a button-only one on a slider or dial (26e). */
  const refusesAction = (type: string, serial: string, key: string) => {
    const kind = kindAt(serial, key);
    return (kind === 'slider' || kind === 'dial') && !takesValue(type);
  };
  const actionDrag = useActionDrag((type, { serial, key }) => {
    const pageId = pageOf(selection, serial);
    if (editingBlocked || pageId === null || !layoutFor(config, selection.profile, serial)?.pages[pageId]) return;
    // Refused while still in the air (26e): letting go drops nothing and changes nothing.
    if (refusesAction(type, serial, key)) return;
    const at = { profile: selection.profile, serial, page: pageId, key };
    if (serial === selection.serial) selectKeys([key]);
    else focusKey(serial, key);
    void window.deckhand.apply({ kind: 'assignAction', at, action: { type } }).then((result) => {
      if (!result.ok) {
        setSwitchError(`Could not put ${actionName(type)} on key ${keyNumber(key, pageGeometry(config, daemon, serial, selection.profile, pageId) ?? undefined)}: ${result.error}`);
        return;
      }
      setSwitchError(null);
      setPick((current) => ({ type, token: (current?.token ?? 0) + 1, click: false }));
    });
  });
  useBulkShortcuts({
    // In Edit layout the keys act on controls (useModeShortcuts).
    enabled: page !== undefined && geometry !== null && !editingBlocked && mode === null,
    hasSelection: selection.keys.length > 0,
    onCopy: bulk.copy,
    onPaste: () => void bulk.paste(),
    onDuplicate: () => void bulk.duplicate(),
    onClear: () => void bulk.clear(),
    onSelectAll: () => geometry && selectKeys(geometry.keys.map((k) => k.id)),
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
  // Both faces of a key with states — its default and its active state's,
  // which the daemon's live state flips it to — so the icon it flips to is
  // stamped too rather than fetched unstamped.
  // Not `.map(faceIcon)`: that passes the array index as the second argument.
  // Every shown deck's page: with several shown, each grid draws its icons.
  const shownPages = shown.flatMap((serial) => {
    const shownPage = layoutFor(config, selection.profile, serial)?.pages[pageOf(selection, serial) ?? ''];
    return shownPage ? [shownPage] : [];
  });
  const pageIcons = watchedImages(shownPages, appIcons);
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


  const addPage = async (name: string, panel?: PanelDef): Promise<AddPageResult> => {
    const result = await window.deckhand.apply(panel ? { kind: 'addPage', profile: selection.profile, serial: selection.serial, name, panel } : { kind: 'addPage', profile: selection.profile, serial: selection.serial, name });
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
    // A virtual deck's page made here gets the deck's default grid, copied
    // from no other profile (2026-11-18); any page can then be changed with
    // Change layout….
    const result = await window.deckhand.apply({ kind: 'addLayout', profile: selection.profile, serial, pageName: 'Main' });
    setAddLayoutError(result.ok ? null : result.error);
  };

  // Every connected deck shown in a profile with no keys for it gets a blank
  // page there at once — a Stream Deck and a virtual deck alike — so it can be
  // edited straight away, with no "add a layout" step. The deck then shows that
  // blank page too, as the editor does, once it is the active profile. One
  // request per deck and profile at a time; the config's change ends it.
  const creatingLayouts = useRef(new Set<string>());
  useEffect(() => {
    if (editingBlocked || !Object.prototype.hasOwnProperty.call(config.profiles, selection.profile)) return;
    for (const serial of [selection.serial, ...Object.keys(selection.others)]) {
      if (serial === '' || geometryFor(daemon, serial) === null || layoutFor(config, selection.profile, serial) !== null) continue;
      const slot = `${selection.profile}:${serial}`;
      if (creatingLayouts.current.has(slot)) continue;
      creatingLayouts.current.add(slot);
      void addLayout(serial).finally(() => creatingLayouts.current.delete(slot));
    }
  });

  // Deleting a page is confirmed here rather than in the toolbar, because the
  // confirmation has to name the keys it is about to clear.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** The page whose layout is being changed (a virtual deck's), with the deck and profile it belongs to, or null. */
  const [changingAt, setChangingLayout] = useState<{ serial: string; profile: string; page: string } | null>(null);
  // The card is for one page of one deck in one profile: another deck or profile closes it. A deck's
  // header button focuses its deck and names it, so the focus it moves does not close the card it opens.
  const changingHere = changingAt !== null && changingAt.serial === selection.serial && changingAt.profile === selection.profile;
  useEffect(() => {
    if (!changingHere) setChangingLayout(null);
  }, [changingHere]);
  const changingLayout = changingHere ? changingAt.page : null;
  const changing = changingLayout === null || isCustomLayout(pagePanelIn(config, selection.profile, selection.serial, changingLayout)) ? undefined : layout?.pages[changingLayout];
  /** Change layout… for a page of a shown deck: from its tab's menu, or the header's button on any shown deck. */
  const changeLayout = (serial: string, pageId: string) => {
    // A grid page's only: a custom page is changed in Edit layout alone (Ryan, 2026-11-20).
    if (isCustomLayout(pagePanelIn(config, selection.profile, serial, pageId))) return;
    setPendingDelete(null);
    if (serial !== selection.serial) setSelection((s) => focusDeck(s, serial));
    setChangingLayout({ serial, profile: selection.profile, page: pageId });
  };
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
  const grid = (serial: string, room?: { width: number; height: number }) => {
    const focused = serial === selection.serial;
    const pageId = pageOf(selection, serial) ?? '';
    const gridPage = layoutFor(config, selection.profile, serial)?.pages[pageId];
    const gridGeometry = pageGeometry(config, daemon, serial, selection.profile, pageId);
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
        liveFaces={liveFacesOn(daemon, at)}
        values={valuesOn(daemon, at)}
        notSetUp={(type) => notSetUp(daemon, type)}
        selectedKeys={focused ? selection.keys : []}
        onClickKey={(key, modifiers) =>
          focused ? setSelection((s) => ({ ...s, ...clickKeys(gridGeometry, s, key, modifiers) })) : focusKey(serial, key)
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
                focusKey(to.serial, to.key);
                void bulk.copyKey({ serial, page: pageId, def: gridPage, key: from }, { serial: to.serial, page: toPage, key: to.key });
              }
        }
        onKeyDragOver={setKeyDragOver}
        box={room}
        screen={config.decks?.[serial]?.virtual ? screenOf(serial) : null}
        background={groundPreview?.serial === serial && groundPreview.page === pageId ? groundPreview.background : undefined}
        dropTarget={
          actionDrag.drag?.over?.serial === serial ? actionDrag.drag.over.key : keyDragOver?.serial === serial ? keyDragOver.key : null
        }
        dropRefused={
          actionDrag.drag?.over?.serial === serial && refusesAction(actionDrag.drag.type, serial, actionDrag.drag.over.key)
            ? NEEDS_VALUE
            : keyDragOver?.serial === serial && keyDragOver.refused
              ? keyDragOver.refused
              : null
        }
        onKeyMenu={(key, x, y) => {
          // Right-clicking a key outside the selection acts on that key alone, as a file manager does.
          if (!focused) focusKey(serial, key);
          else if (!selection.keys.includes(key)) selectKeys([key]);
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
        modeBar={
          mode && modePanel ? (
            <ModeBar
              deck={deckLabel(config, daemon, mode.serial)}
              size={sizeText(mode.serial, mode.page) ?? ''}
              profile={profileLabel(config, mode.profile)}
              page={layoutFor(config, mode.profile, mode.serial) ? pageLabel(layoutFor(config, mode.profile, mode.serial)!, mode.page) : mode.page}
            >
              <SaveAsTemplate
                hasControls={modePanel.controls.length > 0}
                existing={(name) => templateNamed(config.templates, name)?.name ?? null}
                onSave={async (name, replace) => {
                  // The layout only, as it is now; not linked to this page, and not undone by Discard changes (21g).
                  const result = await window.deckhand.apply({ kind: 'saveTemplate', name, panel: modePanel, replace });
                  return result.ok ? null : result.error;
                }}
              />
            </ModeBar>
          ) : undefined
        }
        onBlankPage={(pageId) => setPendingEnter({ serial: selection.serial, profile: selection.profile, page: pageId, blank: true })}
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
        onChangeLayout={(pageId) => changeLayout(selection.serial, pageId)}
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
        {mode ? (
          <ControlsPalette onDrop={addControlAt} onAdd={addControlInMiddle} />
        ) : (
        <Library
          onPick={(type) => {
            if (actionDrag.takeSuppressedClick()) return;
            if (selection.keys.length !== 1) return;
            const kind = selection.key === null ? undefined : geometry?.keys.find((k) => k.id === selection.key)?.kind;
            // A slider or dial: a click on an action with a value puts it there at once, keeping the art and the label.
            if ((kind === 'slider' || kind === 'dial') && selection.key !== null && page) {
              if (!takesValue(type) || editingBlocked) return;
              const at = { profile: selection.profile, serial: selection.serial, page: selection.page, key: selection.key };
              void window.deckhand.apply({ kind: 'setAction', at, action: { type } }).then((result) => setSwitchError(result.ok ? null : `Could not set the ${kind}: ${result.error}`));
              return;
            }
            setPick((current) => ({ type, token: (current?.token ?? 0) + 1, click: true }));
          }}
          dimmed={(type) => {
            const kind = selection.keys.length === 1 && selection.key !== null ? geometry?.keys.find((k) => k.id === selection.key)?.kind : undefined;
            return (kind === 'slider' || kind === 'dial') && !takesValue(type) ? `${NEEDS_VALUE}: a ${kind} takes Volume, Brightness or User volume` : null;
          }}
          onDragStart={editingBlocked || !page || !geometry ? null : actionDrag.start}
          notSetUp={(type) => {
            const text = notSetUpText(daemon, type);
            // "Click to set it up" only where a click can: an integration with a Settings section.
            return text && settingsSectionOf(type) ? `${text} Click to set it up.` : text;
          }}
          onSetUp={(type) => {
            const section = settingsSectionOf(type);
            if (section) void window.deckhand.openSettings(section);
          }}
        />
        )}
        <PaneDivider pane="library" width={paneWidths.library} onResize={resizePane} label="Resize the action library" />
        <main className="stage glass">
          {/* Say it once: when the empty state below already explains that
              the daemon is not running, the banner would only repeat it. */}
          <Notices store={store} daemon={daemon} switchError={switchError} daemonSaidBelow={nothing?.kind === 'daemon-down'} />
          <div className={canvasDecks.length > 0 ? 'well well-canvas' : 'well'}>
            {canvasDecks.length > 0 ? (
              <DeckCanvas
                decks={canvasDecks}
                several={several}
                editing={mode !== null}
                positions={positions}
                onMove={moveDecks}
                locked={locked}
                onLock={lockDeck}
                panel={(serial, placement) => {
                  const layoutHere = layoutFor(config, selection.profile, serial);
                  const pageHere = pageOf(selection, serial) ?? '';
                  const pageDef = layoutHere?.pages[pageHere];
                  const focused = serial === selection.serial;
                  const virtual = config.decks?.[serial]?.virtual !== undefined;
                  const panelHere = virtual && pageDef ? pagePanelIn(config, selection.profile, serial, pageHere) : undefined;
                  const editing = mode !== null && mode.serial === serial;
                  const room = roomOf(canvasDecks.find((d) => d.serial === serial)?.size ?? { columns: 1, rows: 1 });
                  return (
                    <DeckPanel
                      key={serial}
                      serial={serial}
                      name={deckLabel(config, daemon, serial)}
                      size={sizeText(serial, pageHere)}
                      editLayout={
                        // Only on a custom page: a page is a grid or custom for its whole life (Ryan, 2026-11-20).
                        // While open, always: a new page started from Blank is the deck's default grid on disk until its first control.
                        virtual && pageDef && panelHere && (editing || isCustomLayout(panelHere))
                          ? {
                              open: editing,
                              changed: editing && modeChanged,
                              onOpen: () => enterMode(serial, pageHere, false, pageDef),
                              onDiscard: () => setModeCard({ kind: 'discard' }),
                              onDone: leaveMode,
                            }
                          : undefined
                      }
                      background={
                        virtual && pageDef
                          ? {
                              open: backgroundOpen?.serial === serial,
                              dimmed: mode !== null,
                              onToggle: (anchor) => {
                                // As Change layout… does: a deck not being edited takes the focus first.
                                if (!focused) setSelection((s) => focusDeck(s, serial));
                                setBackgroundOpen((open) => (open?.serial === serial ? null : { serial, anchor }));
                              },
                            }
                          : undefined
                      }
                      pageLocked={mode !== null}
                      onHeaderNeed={virtual ? (px) => noteHeaderNeed(serial, px) : undefined}
                      focused={focused}
                      pages={layoutHere ? pageChoices(layoutHere) : []}
                      page={pageHere}
                      disabled={editingBlocked}
                      onFocus={() => setSelection((s) => focusDeck(s, serial))}
                      // The focused deck's Page ▾ is its tabs in another place; another deck's moves that deck alone.
                      onPage={(pageId) => (focused ? select({ page: pageId }) : showDeckPage(serial, pageId))}
                      onChangeLayout={virtual && pageDef && panelHere && !isCustomLayout(panelHere) && !editing ? () => changeLayout(serial, pageHere) : undefined}
                      placement={placement}
                    >
                      {editing && modePanel && modePage ? (
                        <LayoutCanvas
                          config={config}
                          serial={serial}
                          panel={modePanel}
                          page={modeBlank ? { buttons: {} } : modePage}
                          box={room}
                          screen={screenOf(serial)}
                          selected={selectedControls}
                          guides={guides}
                          iconStamps={iconStamps}
                          appIcons={appIcons}
                          onSelect={selectKeys}
                          onChange={(panel) => saveLayout(panel)}
                          background={modeBlank ? undefined : modePage.background}
                        />
                      ) : (
                        (grid(serial, virtual ? room : undefined) ?? emptyCard(emptyState(config, daemon, { profile: selection.profile, serial }), serial))
                      )}
                    </DeckPanel>
                  );
                }}
              />
            ) : (
              <>
                {/* No deck to draw: one place says why (model.ts emptyState). */}
                {nothing && emptyCard(nothing, selection.serial)}
                {grid(selection.serial)}
              </>
            )}
            {mode && canvasDecks.length > 0 && <GuidesBar guides={guides} onChange={setGuides} />}
            {mode && modePanel && canvasDecks.length > 0 && madeForAnother(modePanel.size, screenOf(mode.serial)) && <MadeForChip layout={modePanel.size} screen={screenOf(mode.serial)!} />}
            {backgroundOpen &&
              (() => {
                const serial = backgroundOpen.serial;
                const pageId = pageOf(selection, serial) ?? '';
                const def = layoutFor(config, selection.profile, serial)?.pages[pageId];
                if (!def) return null;
                return (
                  <BackgroundPanel
                    anchor={backgroundOpen.anchor}
                    pageName={def.name ?? pageId}
                    // The saved background, never the preview: the slider saves what it moved to only against
                    // the value it started from, and the next change made here must not carry an unsaved one.
                    background={def.background}
                    iconStamps={iconStamps}
                    fullscreenWindow={daemon.status?.decks.find((d) => d.serial === serial)?.surface === 'fullscreen-window'}
                    disabled={editingBlocked}
                    onPreview={(background) => setGroundPreview(background ? { serial, page: pageId, background } : null)}
                    onChange={(background) => void window.deckhand.apply({ kind: 'setPageBackground', profile: selection.profile, serial, page: pageId, background })}
                    onClose={() => {
                      setBackgroundOpen(null);
                      setGroundPreview(null);
                    }}
                  />
                );
              })()}
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
            {layout && changing && changingLayout !== null && (
              <ChangeLayout
                key={`${selection.serial}/${changingLayout}`}
                deckKey={selection.serial}
                pageName={pageLabel(layout, changingLayout)}
                page={changing}
                current={pagePanelIn(config, selection.profile, selection.serial, changingLayout)}
                onApply={async (panel, choice) => {
                  const result = await window.deckhand.apply({ kind: 'setPagePanel', profile: selection.profile, serial: selection.serial, page: changingLayout, panel });
                  if (!result.ok) return result.error;
                  void window.deckhand.setLastGrid(selection.serial, choice);
                  setChangingLayout(null);
                  return null;
                }}
                onCancel={() => setChangingLayout(null)}
              />
            )}
            {mode && modePanel && modePage && modeCard?.kind === 'delete' && (
              <DeleteControl
                keys={modeCard.ids.flatMap((id) => (keyKind(modePage.buttons[id]) === 'empty' ? [] : [{ name: controlNames(modePanel).get(id) ?? id, button: modePage.buttons[id] }]))}
                count={modeCard.ids.length}
                onConfirm={() => deleteSelected(modeCard.ids, true)}
                onCancel={() => setModeCard(null)}
              />
            )}
            {mode && modeChanges && modeCard?.kind === 'discard' && (
              <DiscardChanges
                page={layoutFor(config, mode.profile, mode.serial) ? pageLabel(layoutFor(config, mode.profile, mode.serial)!, mode.page) : mode.page}
                changes={modeChanges}
                onConfirm={discardChanges}
                onCancel={() => setModeCard(null)}
              />
            )}
            {layout && deletion && pendingDelete !== null && (
              <DeletePage
                name={pageLabel(layout, pendingDelete)}
                deletion={deletion}
                pageName={(page: string) => pageLabel(layout, page)}
                keyNumberOf={(key: string, onPage: string) => keyNumber(key, pageGeometry(config, daemon, selection.serial, selection.profile, onPage) ?? undefined)}
                onConfirm={() => void confirmDelete()}
                onCancel={() => setPendingDelete(null)}
              />
            )}
          </div>
          <BulkStatus bulk={bulk} />
        </main>
        <PaneDivider pane="inspector" width={paneWidths.inspector} onResize={resizePane} label="Resize the inspector" />
        {mode && modePanel && modePage ? (
          <LayoutInspector
            deckName={deckLabel(config, daemon, mode.serial)}
            panel={modePanel}
            page={modeBlank ? { buttons: {} } : modePage}
            selected={selectedControls}
            screen={modeScreen}
            onChange={(panel) => saveLayout(panel)}
            onDuplicate={duplicateSelected}
            onDelete={() => deleteSelected(selectedControls, false)}
          />
        ) : (
        <Inspector
          selectedCount={selection.keys.length}
          bulk={bulk}
          at={selection.key === null || !page ? null : { profile: selection.profile, serial: selection.serial, page: selection.page, key: selection.key }}
          keyNumber={selection.key === null ? '' : keyNumber(selection.key, geometry ?? undefined)}
          button={selection.key === null ? undefined : page?.buttons[selection.key]}
          failure={selection.key === null ? undefined : failedKeysOn(daemon, { profile: selection.profile, serial: selection.serial, page: selection.page })[selection.key]}
          notSetUp={selection.key !== null && notSetUp(daemon, page?.buttons[selection.key]?.action?.type)}
          editingBlocked={editingBlocked}
          pick={pick}
          pages={layout ? pageChoices(layout) : []}
          profiles={profileChoices(config)}
          virtualDecks={virtualDeckChoices(config)}
          decks={knownDecks(config, daemon)}
          coverage={(profile) => profileCoverage(config, daemon, profile)}
          labelDefaults={labelDefaults(config)}
          keyColorDefault={config.defaults?.background ?? DEFAULTS.background}
          builtinIconSize={config.defaults?.builtinIconSize ?? DEFAULTS.builtinIconSize}
          keyBox={selection.key === null ? null : keyBoxOf(geometry, selection.key)}
          canPreview={canSwitchDeck(daemon, selection.serial)}
          audio={daemon.audio}
          apps={daemon.apps}
          controlKind={selection.key === null ? undefined : geometry?.keys.find((k) => k.id === selection.key)?.kind}
          config={config}
          apply={async (edit) => {
            const result = await window.deckhand.apply(edit);
            return result.ok ? null : result.error;
          }}
        />
        )}
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
              <li key={`${link.profile}/${link.serial}/${link.page}/${link.key}/${link.where}`}>
                {profileLabel(config, link.profile)} · {deckLabel(config, daemon, link.serial)} ·{' '}
                {pageLabelIn(config, link.profile, link.serial, link.page)} · key {keyNumber(link.key, pageGeometry(config, daemon, link.serial, link.profile, link.page) ?? undefined)}
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
  keyNumberOf,
  onConfirm,
  onCancel,
}: {
  name: string;
  deletion: NonNullable<ReturnType<typeof pageDeletion>>;
  pageName: (page: string) => string;
  /** A key's number on its page, as people count them ("key 5"): a virtual deck's pages can each have another grid. */
  keyNumberOf: (key: string, page: string) => string;
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
              <li key={`${link.page}/${link.key}/${link.where}`}>
                {pageName(link.page)} · key {keyNumberOf(link.key, link.page)}
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
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      // Keys pressed in a dropdown are the dropdown's, open or closed: they must not reach the selected keys.
      // The same for a virtual deck's grid pickers (New page, Change layout…), whose buttons can hold focus.
      if (target?.closest?.('[data-dropdown], [data-dropdown-menu], [data-add-page], [data-change-layout]')) return;
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

/**
 * Edit layout's keys (rounds 2a, 2b): Delete deletes the selected controls
 * (and warns if any has a key), Ctrl+D duplicates them, the arrow keys nudge
 * them a pixel or a grid step, Ctrl+A selects every control, Escape selects
 * nothing — on controls, never keys, while the mode is
 * open (Ryan, 2026-11-18). Never while typing in a field or in a dropdown,
 * as the grid's shortcuts.
 */
function useModeShortcuts(handlers: {
  enabled: boolean;
  /** Something is selected. */
  selected: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onNudge: (dx: number, dy: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const h = latest.current;
      if (!h.enabled || keyCapture.active || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (target?.closest?.('[data-dropdown], [data-dropdown-menu], [data-add-page], [data-change-layout]')) return;
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      let handled = true;
      if (ctrl && event.code === 'KeyA') h.onSelectAll();
      else if (!h.selected) handled = false;
      else if (plain && event.code === 'Delete' && !event.repeat) h.onDelete();
      else if (ctrl && event.code === 'KeyD' && !event.repeat) h.onDuplicate();
      else if (plain && arrows[event.key]) h.onNudge(...arrows[event.key]);
      else if (plain && event.code === 'Escape') h.onSelectNone();
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
