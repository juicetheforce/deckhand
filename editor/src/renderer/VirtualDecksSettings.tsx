import { useEffect, useState } from 'react';
import type { PairReply, ScreensReply, TouchState } from '../../../src/control/protocol.js';
import { gridFor, makePanel, MAX_CUSTOM_COLUMNS, MAX_CUSTOM_ROWS, PRESET_SIZES, type Grid, type PanelSize, type ScreenSize } from '../../../src/panel-presets.js';
import type { VirtualDeckRow, VirtualDecksView } from '../shared/bridge.js';
import { Banner, Divider, Group, InfoTip, Row, StatusDot } from './settings-ui.js';

/**
 * Settings › Decks › Virtual decks (`[decided]` Ryan, 2026-10-16): each
 * touchscreen used as a deck, with Tap again (after its USB cable moves) and
 * Remove (the pairing only — its layouts stay), its size in each profile, and
 * Add a virtual deck: choose the screen, tap it, choose a size. A new deck
 * gets a layout in the profile the decks show now; the others get one from
 * the editor's "Add a layout" card.
 */

const SIZE_NAMES: Record<PanelSize, string> = { small: 'Small', medium: 'Medium', large: 'Large', custom: 'Custom' };

/** How a deck's touch is, in words, as `deckhand status` says it. */
const TOUCH_WORDS: Record<TouchState, string> = {
  ready: 'touch works',
  'not-paired': 'not paired with a touchscreen: Tap again',
  missing: 'its touchscreen is not connected',
  opening: 'opening its touchscreen',
  failed: 'touch is not available: Tap again restores access',
  locked: 'touch is off while the session is locked',
  inactive: 'touch is off while another session is active',
  unknown: 'touch is off: the lock state cannot be read',
};

/** "3 × 8 keys, about 26 mm" — a size as the picker offers it. */
function describeGrid(grid: Grid): string {
  const keys = `${grid.rows} × ${grid.columns} keys`;
  return grid.keyMm !== null ? `${keys}, about ${Math.round(grid.keyMm)} mm` : `${keys}, ${grid.keyPx} px`;
}

/** The size picker: Small, Medium, Large with what each gives on this screen, or Custom rows (and, optionally, columns). */
function SizePicker({ screen, size, rows, columns, onChange }: {
  screen: ScreenSize;
  size: PanelSize;
  rows: string;
  columns: string;
  onChange: (next: { size?: PanelSize; rows?: string; columns?: string }) => void;
}) {
  const custom = customOf(rows, columns);
  const grid = gridFor(screen, size, custom);
  return (
    <div className="vd-sizes" role="radiogroup" aria-label="Key size">
      {[...PRESET_SIZES, 'custom' as const].map((s) => (
        <label key={s} className="vd-size" data-vd-size={s}>
          <input
            type="radio"
            name="vd-size"
            checked={size === s}
            // Custom starts from the size picked before it, so its fields are never empty.
            onChange={() => onChange(s === 'custom' ? { size: s, rows: String(grid.rows), columns: String(grid.columns) } : { size: s })}
          />
          <span className="vd-size-name">{SIZE_NAMES[s]}</span>
          <span className="muted small">{s === 'custom' ? 'set the rows and columns' : describeGrid(gridFor(screen, s))}</span>
        </label>
      ))}
      {size === 'custom' && (
        <div className="sp-fields">
          <label className="sp-field sp-field-port">
            <span className="sp-field-label">Rows</span>
            <input className="sp-input" type="number" min={1} max={MAX_CUSTOM_ROWS} value={rows} onChange={(e) => onChange({ rows: e.target.value })} data-vd-field="rows" />
          </label>
          <label className="sp-field sp-field-port">
            <span className="sp-field-label">Columns</span>
            <input className="sp-input" type="number" min={1} max={MAX_CUSTOM_COLUMNS} value={columns} onChange={(e) => onChange({ columns: e.target.value })} data-vd-field="columns" />
          </label>
          <span className="muted small vd-custom-result">
            {describeGrid(grid)} · at most {MAX_CUSTOM_ROWS} × {MAX_CUSTOM_COLUMNS}
          </span>
        </div>
      )}
      {grid.verySmall && (
        <p className="muted small vd-warning" data-vd-warning="small">
          These keys are very small, and may be hard to press. You can still use them.
        </p>
      )}
    </div>
  );
}

/** Custom's rows and columns from their fields: whole numbers, from 1 to the maximum (panel-presets clamps). */
function customOf(rows: string, columns: string): { rows: number; columns: number } {
  return { rows: Math.max(1, Math.floor(Number(rows)) || 1), columns: Math.max(1, Math.floor(Number(columns)) || 1) };
}

/** "10.3″ · 1920 × 720 · DP-4": what tells screens apart in the list. */
function describeScreen(s: ScreensReply['screens'][number]): string {
  const parts: string[] = [];
  if (s.widthMm && s.heightMm) parts.push(`${(Math.hypot(s.widthMm, s.heightMm) / 25.4).toFixed(1)}″`);
  if (s.width && s.height) parts.push(`${s.width} × ${s.height}`);
  parts.push(s.connector);
  return parts.join(' · ');
}

/** The daemon's "nothing was tapped", in words that say what to do. */
function pairingError(error: string, screen: string): string {
  return /nothing was tapped/.test(error) ? `No touch was detected on ${screen}. It may not be the screen with the touchscreen: choose another.` : error;
}

type AddStep =
  | { step: 'closed' }
  | { step: 'screen'; screens: ScreensReply | null; error: string | null }
  | { step: 'tap'; connector: string }
  | { step: 'size'; pairing: PairReply; size: PanelSize; rows: string; columns: string; error: string | null };

export function VirtualDecks() {
  const [view, setView] = useState<VirtualDecksView>({ decks: [], keptLayouts: [], activeProfile: null });
  const [add, setAdd] = useState<AddStep>({ step: 'closed' });
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [tapping, setTapping] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Whether any touchscreen is connected: no Add without one. Null while asked. */
  const [touchFound, setTouchFound] = useState<boolean | null>(null);

  const lookForTouch = async () => {
    setTouchFound(null);
    const reply = await window.deckhand.virtualScreens();
    setTouchFound(reply.ok ? reply.result.touchscreens.length > 0 : false);
  };
  useEffect(() => {
    void window.deckhand.virtualDecks().then(setView);
    void lookForTouch();
    return window.deckhand.onVirtualDecks(setView);
  }, []);

  const openAdd = async () => {
    setNotice(null);
    setAdd({ step: 'screen', screens: null, error: null });
    const reply = await window.deckhand.virtualScreens();
    setAdd(reply.ok ? { step: 'screen', screens: reply.result, error: null } : { step: 'screen', screens: null, error: reply.error });
  };

  const tap = async (connector: string, name: string) => {
    setAdd({ step: 'tap', connector });
    const reply = await window.deckhand.pairScreen(connector);
    if (!reply.ok) {
      if (reply.code === 'cancelled') setAdd({ step: 'closed' });
      else setAdd({ step: 'screen', screens: (await window.deckhand.virtualScreens().then((r) => (r.ok ? r.result : null))) ?? null, error: pairingError(reply.error, name) });
      return;
    }
    const sizeStep = { step: 'size' as const, pairing: reply.result, size: 'medium' as PanelSize, rows: '3', columns: '8', error: null };
    // Set up before and removed: its layout is kept and used as it is, so no size is asked.
    if (view.keptLayouts.includes(reply.result.screen)) void finishAdd(sizeStep, true);
    else setAdd(sizeStep);
  };

  const finishAdd = async (step: Extract<AddStep, { step: 'size' }>, kept = false) => {
    const profile = view.activeProfile;
    if (!profile) {
      setAdd({ ...step, error: 'The daemon is not reporting which profile is active, so there is nowhere to put the new layout. Is it running?' });
      return;
    }
    const p = step.pairing;
    const screen: ScreenSize = { width: p.width, height: p.height, widthMm: p.widthMm, heightMm: p.heightMm };
    const panel = makePanel(screen, step.size, step.size === 'custom' ? customOf(step.rows, step.columns) : undefined);
    const result = await window.deckhand.virtualDeckEdit({ kind: 'addVirtualDeck', key: p.screen, output: p.connector, touch: p.touch, profile: profile.id, panel, pageName: 'Main' });
    if (!result.ok) {
      setAdd({ ...step, error: result.error });
      return;
    }
    setAdd({ step: 'closed' });
    setNotice({
      kind: 'ok',
      text: kept
        ? `${p.name ?? p.screen} is a virtual deck again, paired with ${p.touchName}. Its previous layout in “${profile.name}” is kept, at the size it had.`
        : `${p.name ?? p.screen} is a virtual deck, paired with ${p.touchName}. Its keys are in the editor, in “${profile.name}”.`,
    });
  };

  const tapAgain = async (deck: VirtualDeckRow) => {
    setNotice(null);
    setTapping(deck.key);
    const reply = await window.deckhand.pairScreen(deck.output);
    setTapping(null);
    if (!reply.ok) {
      if (reply.code !== 'cancelled') setNotice({ kind: 'error', text: pairingError(reply.error, deck.label) });
      return;
    }
    if (reply.result.screen !== deck.key) {
      void window.deckhand.cancelPairing();
      setNotice({ kind: 'error', text: `The screen on ${deck.output} is another screen now (${reply.result.name ?? reply.result.screen}). Add it as a virtual deck of its own instead.` });
      return;
    }
    const result = await window.deckhand.virtualDeckEdit({ kind: 'repairVirtualDeck', key: deck.key, output: reply.result.connector, touch: reply.result.touch });
    setNotice(result.ok ? { kind: 'ok', text: `${deck.label} is paired with ${reply.result.touchName}.` } : { kind: 'error', text: result.error });
  };

  const remove = async (deck: VirtualDeckRow) => {
    setRemoving(null);
    const result = await window.deckhand.virtualDeckEdit({ kind: 'removeVirtualDeck', key: deck.key });
    setNotice(result.ok ? { kind: 'ok', text: `${deck.label} is no longer a virtual deck. Its layouts are kept: set the same screen up again and they are used.` } : { kind: 'error', text: result.error });
  };

  const power = async (deck: VirtualDeckRow, on: boolean) => {
    const result = await window.deckhand.virtualPower(deck.key, on);
    if (!result.ok) setNotice({ kind: 'error', text: result.error });
  };

  return (
    <Group heading="Virtual decks" data-settings-group="virtual-decks" extra={<InfoTip text="A touchscreen used as a deck: its keys are pressed by touch, as a Stream Deck's are. Its keys are edited in the editor, never on the screen." />}>
      {notice && (
        <Banner kind={notice.kind} data-vd-notice={notice.kind}>
          {notice.text}
        </Banner>
      )}
      {view.decks.map((deck, i) => (
        <div key={deck.key} data-vd-deck={deck.key}>
          {i > 0 && <Divider />}
          <Row
            title={
              <>
                <StatusDot dot={deck.connected ? (deck.touch === 'ready' ? 'ok' : 'waiting') : 'unset'} /> {deck.label}
              </>
            }
            detail={`${deck.output} · ${deck.off ? 'turned off: its screen and touchscreen are the desktop\'s until it is turned on' : deck.connected ? TOUCH_WORDS[deck.touch ?? 'unknown'] : 'not connected'}`}
          >
            {removing === deck.key ? (
              <span className="vd-confirm" data-vd-confirm="remove">
                <span className="settings-note settings-note-ask">Remove it? Its layouts stay.</span>
                <button className="sp-button sp-button-danger-solid" onClick={() => void remove(deck)} data-vd="confirm-remove">
                  Remove
                </button>
                <button className="sp-button sp-button-quiet" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
              </span>
            ) : tapping === deck.key ? (
              <span className="vd-confirm">
                <span className="settings-note">Tap the screen that says “Tap this screen”…</span>
                <button className="sp-button sp-button-quiet" onClick={() => void window.deckhand.cancelPairing()} data-vd="cancel-tap">
                  Cancel
                </button>
              </span>
            ) : (
              <span className="vd-actions">
                <button
                  className="sp-button"
                  disabled={(!deck.connected && !deck.off) || tapping !== null}
                  title={deck.off ? 'Show its panel again, where it was' : 'Hide its panel and give its screen and touchscreen back to the desktop, until it is turned on'}
                  onClick={() => void power(deck, deck.off)}
                  data-vd="power"
                >
                  {deck.off ? 'Turn on' : 'Turn off'}
                </button>
                <button className="sp-button" disabled={!deck.connected || tapping !== null || add.step === 'tap'} title={deck.connected ? 'Pair it with its touchscreen again: after its USB cable moves to another port, say' : 'Its screen is not connected'} onClick={() => void tapAgain(deck)} data-vd="tap-again">
                  Tap again
                </button>
                <button className="sp-button sp-button-danger" onClick={() => setRemoving(deck.key)} data-vd="remove">
                  Remove
                </button>
              </span>
            )}
          </Row>
          {deck.defaultSize && <DeckSize deck={deck} layout={{ profile: null, profileName: null, own: true, ...deck.defaultSize }} onNotice={setNotice} />}
          {deck.layouts.map((layout) => (
            <DeckSize key={layout.profile} deck={deck} layout={layout} onNotice={setNotice} />
          ))}
        </div>
      ))}
      {view.decks.length > 0 && <Divider />}
      {add.step === 'closed' && touchFound === false && (
        <Row title="No touchscreen was found" detail="A virtual deck needs a touchscreen. Plug one in (its USB cable too, for a USB touch monitor), then look again.">
          <button className="sp-button" onClick={() => void lookForTouch()} data-vd="look-again">
            Look again
          </button>
        </Row>
      )}
      {add.step === 'closed' && touchFound === true && (
        <Row title="Add a virtual deck" detail="Use a touchscreen as a deck: choose it, tap it, choose a key size.">
          <button className="sp-button sp-button-primary" onClick={() => void openAdd()} data-vd="add">
            Add a virtual deck…
          </button>
        </Row>
      )}
      {add.step === 'screen' && (
        <div className="vd-add" data-vd-step="screen">
          <span className="sp-row-title">Which screen?</span>
          {add.error && <Banner kind="error">{add.error}</Banner>}
          {add.screens === null && !add.error && <p className="muted small">Asking the daemon…</p>}
          {add.screens && add.screens.touchscreens.length === 0 && <p className="muted small">No touchscreen was found. Plug one in (its USB cable too, for a USB touch monitor), then try again.</p>}
          {add.screens && add.screens.touchscreens.length > 0 && (() => {
            // Deckhand cannot tell which screens have touch until one is
            // tapped, so every screen is offered — but not one that is a
            // virtual deck already. Judged from the editor's own list, not
            // the daemon's flag: the daemon learns of a Remove only after
            // the autosave and its reload, a moment later.
            const free = add.screens.screens.filter((s) => !view.decks.some((d) => d.key === s.key));
            if (free.length === 0) return <p className="muted small">Every connected screen is a virtual deck already.</p>;
            return (
              <>
                <p className="muted small">Deckhand can tell which screen has the touchscreen only once it is tapped. Choose the one you will tap; pairing asks for your password.</p>
                <ul className="vd-screens">
                  {free.map((s) => (
                    <li key={s.connector} data-vd-screen={s.connector}>
                      <button className="sp-button" onClick={() => void tap(s.connector, s.name ?? s.key)}>
                        {s.name ?? s.key}
                      </button>
                      <span className="muted small" data-vd-screen-detail>
                        {s.builtIn ? 'Built-in screen · ' : ''}
                        {describeScreen(s)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}
          <div className="button-row">
            <button className="sp-button sp-button-quiet" onClick={() => setAdd({ step: 'closed' })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {add.step === 'tap' && (
        <div className="vd-add" data-vd-step="tap">
          <span className="sp-row-title">Tap the screen that says “Tap this screen”</span>
          <p className="muted small">
            Enter your password first if asked: until you tap, Deckhand can read every touchscreen; after, only the one you tapped. You have
            30 seconds from when the screen says to tap.
          </p>
          <div className="button-row">
            <button className="sp-button sp-button-quiet" onClick={() => void window.deckhand.cancelPairing()} data-vd="cancel-tap">
              Cancel
            </button>
          </div>
        </div>
      )}
      {add.step === 'size' && (
        <div className="vd-add" data-vd-step="size">
          <span className="sp-row-title">
            {add.pairing.name ?? add.pairing.screen}, paired with {add.pairing.touchName}. Key size?
          </span>
          {add.error && <Banner kind="error">{add.error}</Banner>}
          <SizePicker
            screen={{ width: add.pairing.width, height: add.pairing.height, widthMm: add.pairing.widthMm, heightMm: add.pairing.heightMm }}
            size={add.size}
            rows={add.rows}
            columns={add.columns}
            onChange={(next) => setAdd({ ...add, ...next })}
          />
          <p className="muted small">Its layout goes in “{view.activeProfile?.name ?? '…'}”. Other profiles get one from the editor.</p>
          <div className="button-row">
            <button className="sp-button sp-button-primary" onClick={() => void finishAdd(add)} data-vd="finish-add">
              Add
            </button>
            <button
              className="sp-button sp-button-quiet"
              onClick={() => {
                // Nothing is written; the touchscreens' temporary access goes.
                void window.deckhand.cancelPairing();
                setAdd({ step: 'closed' });
              }}
              data-vd="cancel-size"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Group>
  );
}

/**
 * A deck's default size (profile null), which every profile without one of
 * its own follows, or its size in one profile; and changing it: keys keep
 * their row and column; any with no place are named, and dropped only once
 * confirmed.
 */
function DeckSize({ deck, layout, onNotice }: {
  deck: VirtualDeckRow;
  layout: Omit<VirtualDeckRow['layouts'][number], 'profile' | 'profileName'> & { profile: string | null; profileName: string | null };
  onNotice: (notice: { kind: 'ok' | 'error'; text: string } | null) => void;
}) {
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [editing, setEditing] = useState<{ size: PanelSize; rows: string; columns: string; dropped: string[] | null } | null>(null);
  useEffect(() => {
    if (editing && !screen) void window.deckhand.virtualScreenSize(deck.key).then(setScreen);
  }, [editing, screen, deck.key]);

  const current = layout.preset && layout.preset in SIZE_NAMES ? SIZE_NAMES[layout.preset as PanelSize] : 'Custom';
  const panelFor = (e: NonNullable<typeof editing>) => (screen ? makePanel(screen, e.size, e.size === 'custom' ? customOf(e.rows, e.columns) : undefined) : null);

  const apply = async (e: NonNullable<typeof editing>) => {
    const panel = panelFor(e);
    if (!panel) return;
    if (e.dropped === null) {
      const dropped = (await window.deckhand.virtualPanelPreview(layout.profile, deck.key, panel)) ?? [];
      if (dropped.length > 0) {
        setEditing({ ...e, dropped });
        return;
      }
    }
    const result = await window.deckhand.virtualDeckEdit(
      layout.profile === null ? { kind: 'setDefaultPanel', key: deck.key, panel } : { kind: 'setPanel', profile: layout.profile, serial: deck.key, panel },
    );
    setEditing(null);
    onNotice(
      result.ok
        ? {
            kind: 'ok',
            text:
              layout.profile === null
                ? `${deck.label}'s default size is ${SIZE_NAMES[e.size]} now, in every profile without a size of its own.`
                : `${deck.label} in “${layout.profileName}” is ${SIZE_NAMES[e.size]} now.`,
          }
        : { kind: 'error', text: result.error },
    );
  };

  return (
    <div className="vd-layout" data-vd-layout={layout.profile ?? undefined} data-vd-default={layout.profile === null ? '' : undefined}>
      <Row
        title={layout.profile === null ? 'Default size' : `Size in “${layout.profileName}”`}
        detail={
          layout.profile === null
            ? `${current}, ${layout.rows} × ${layout.columns} keys — every profile without a size of its own`
            : `${current}, ${layout.rows} × ${layout.columns} keys${layout.own ? '' : ' (the default)'}`
        }
      >
        {!editing && (
          <button className="sp-button" onClick={() => setEditing({ size: (layout.preset as PanelSize) ?? 'medium', rows: String(layout.rows), columns: '', dropped: null })} data-vd="resize">
            Change…
          </button>
        )}
      </Row>
      {editing && (
        <div className="vd-add">
          {screen === null ? (
            <p className="muted small">Asking the daemon for the screen's size…</p>
          ) : (
            <SizePicker screen={screen} size={editing.size} rows={editing.rows} columns={editing.columns} onChange={(next) => setEditing({ ...editing, ...next, dropped: null })} />
          )}
          {editing.dropped && editing.dropped.length > 0 && (
            <p className="warning-text" data-vd-dropped={editing.dropped.length}>
              {editing.dropped.length === 1 ? '1 key has' : `${editing.dropped.length} keys have`} no place at that size and will be removed: {editing.dropped.slice(0, 4).join(', ')}
              {editing.dropped.length > 4 ? ` and ${editing.dropped.length - 4} more` : ''}.
            </p>
          )}
          <div className="button-row">
            <button className="sp-button sp-button-primary" disabled={screen === null} onClick={() => void apply(editing)} data-vd="apply-size">
              {editing.dropped && editing.dropped.length > 0 ? 'Remove them and resize' : 'Resize'}
            </button>
            <button className="sp-button sp-button-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
