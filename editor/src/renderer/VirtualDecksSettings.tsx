import { useEffect, useState } from 'react';
import type { PairReply, ScreensReply, TouchState } from '../../../src/control/protocol.js';
import { makePanel, type PanelSize, type ScreenSize } from '../../../src/panel-presets.js';
import { customOf, GridPicker } from './GridPicker.js';
import type { VirtualDeckRow, VirtualDecksView } from '../shared/bridge.js';
import { Banner, Divider, Group, InfoTip, Row, StatusDot } from './settings-ui.js';

/**
 * Settings › Decks › Virtual decks (`[decided]` Ryan, 2026-10-16): each
 * touchscreen used as a deck, with Tap again (after its USB cable moves) and
 * Remove (the pairing only — its layouts stay), and Add a virtual deck:
 * choose the screen, tap it, choose a grid size, which becomes the deck's
 * default — every page made for it automatically gets that grid. Sizes are
 * not listed here any more: every page has its own layout, changed on the
 * page with Change layout… (2026-11-17).
 */

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
            {add.pairing.name ?? add.pairing.screen}, paired with {add.pairing.touchName}. Grid size?
          </span>
          {add.error && <Banner kind="error">{add.error}</Banner>}
          <GridPicker
            screen={{ width: add.pairing.width, height: add.pairing.height, widthMm: add.pairing.widthMm, heightMm: add.pairing.heightMm }}
            size={add.size}
            rows={add.rows}
            columns={add.columns}
            onChange={(next) => setAdd({ ...add, ...next })}
          />
          <p className="muted small">
            This is the deck's default: its first page in “{view.activeProfile?.name ?? '…'}” has it, as does every page made for it automatically. Each page can be changed later, in the editor.
          </p>
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
