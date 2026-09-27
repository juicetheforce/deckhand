import { useEffect, useState } from 'react';
import type { Config, LayoutDef, PageDef } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import {
  clearKeys,
  copyKeys,
  duplicateKeys,
  pasteAnchor,
  placeClipboard,
  swapKeys,
  type ButtonWrite,
  type Clipboard,
} from '../shared/bulk.js';
import { deckChoices, geometryFor, layoutFor, pageLabel, placementMessage, type DeckGeometryWithSerial, type Selection } from './model.js';

interface BulkContext {
  config: Config;
  daemon: DaemonView;
  selection: Selection;
  layout: LayoutDef | null;
  page: PageDef | undefined;
  geometry: DeckGeometryWithSerial | null;
  editingBlocked: boolean;
  /** Replace the selected keys on the page being edited. */
  selectKeys: (keys: number[]) => void;
}

export interface Bulk {
  clipboard: Clipboard | null;
  /** The last operation's result, for the status line. Transient: cleared by the next operation or a page change. */
  message: string | null;
  dismissMessage: () => void;
  emptyClipboard: () => void;
  copy: () => void;
  paste: () => Promise<void>;
  duplicate: () => Promise<void>;
  clear: () => Promise<void>;
  /**
   * Key onto key: move a button, swapping with whatever is at `to`; the moved
   * button becomes the selection. On the page being edited, or on `on`: another
   * shown deck's page, which the caller focuses.
   */
  move: (from: number, to: number, on?: { serial: string; page: string; def: PageDef }) => Promise<void>;
  /** Copy the selected keys to the same positions on another page, of this deck or another in this profile. */
  copyTo: (serial: string, page: string) => Promise<void>;
  /**
   * Key onto another deck's key: copy it there, replacing whatever is there,
   * and leave the original. `from` is any shown deck's page; `to` is where it
   * lands, on the page that deck shows. The caller focuses `to`'s deck first,
   * so the status line, set after the write, is about that deck's page.
   */
  copyKey: (from: { serial: string; page: string; def: PageDef; index: number }, to: { serial: string; page: string; index: number }) => Promise<void>;
}

/**
 * The bulk operations over the selected keys.
 * Where keys land is decided by src/shared/bulk.ts; this only gathers what it
 * needs, sends one `putButtons` edit, and says what happened.
 *
 * The clipboard is this renderer's memory: not the system clipboard, and not
 * saved, so it is gone when the editor closes.
 */
export function useBulk({ config, daemon, selection, layout, page, geometry, editingBlocked, selectKeys }: BulkContext): Bulk {
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // A result about one page means nothing once another is shown. A key
  // copied onto another deck focuses that deck at the drop, before the write:
  // the drop is a discrete event, so React commits the focus and runs this
  // before the write can return, and a lost link's warning, set after, stays.
  // Focusing after the write would clear it (check:multi-deck, 8c).
  useEffect(() => setMessage(null), [selection.profile, selection.serial, selection.page]);

  const ready = !editingBlocked && layout !== null && page !== undefined && geometry !== null;

  const put = async (writes: ButtonWrite[], serial = selection.serial, pageId = selection.page): Promise<string | null> => {
    if (writes.length === 0) return null;
    const result = await window.deckhand.apply({ kind: 'putButtons', profile: selection.profile, serial, page: pageId, writes });
    return result.ok ? null : result.error;
  };

  return {
    clipboard,
    message,
    dismissMessage: () => setMessage(null),
    emptyClipboard: () => setClipboard(null),

    copy: () => {
      if (!page || !geometry || selection.keys.length === 0) return;
      const clip = copyKeys(page, geometry, selection.keys);
      if (clip === null) {
        setMessage('Nothing copied: the selected keys are empty.');
        return;
      }
      setClipboard(clip);
      setMessage(null);
    },

    paste: async () => {
      if (!ready || clipboard === null) return;
      const placement = placeClipboard(clipboard, pasteAnchor(geometry, selection.keys, clipboard), geometry, layout);
      const failure = await put(placement.writes);
      if (failure !== null) {
        setMessage(`Could not paste: ${failure}`);
        return;
      }
      setMessage(placementMessage('Pasted', placement, `“${pageLabel(layout, selection.page)}”`));
      // Select what landed, so the next thing done acts on the pasted keys.
      if (placement.writes.length > 0) selectKeys(placement.writes.map((w) => w.index));
    },

    duplicate: async () => {
      if (!ready || selection.keys.length === 0) return;
      const duplication = duplicateKeys(page, geometry, selection.keys);
      if (!duplication.ok) {
        setMessage(duplication.error);
        return;
      }
      const failure = await put(duplication.writes);
      if (failure !== null) {
        setMessage(`Could not duplicate: ${failure}`);
        return;
      }
      setMessage(null);
      // The copy is what gets edited next — a new icon, a new keybind — so it
      // becomes the selection.
      selectKeys(duplication.created);
    },

    copyTo: async (serial, pageId) => {
      if (!ready || selection.keys.length === 0) return;
      const targetLayout = layoutFor(config, selection.profile, serial);
      const targetGeometry = geometryFor(daemon, serial);
      if (targetLayout === null || !Object.prototype.hasOwnProperty.call(targetLayout.pages, pageId)) return;
      if (targetGeometry === null) {
        setMessage('That deck is not connected, so where the keys would land cannot be worked out. Plug it in to copy to it.');
        return;
      }
      const clip = copyKeys(page, geometry, selection.keys);
      if (clip === null) {
        setMessage('Nothing copied: the selected keys are empty.');
        return;
      }
      // Same positions as the originals: this is not a paste, so there is no anchor.
      const placement = placeClipboard(clip, clip.origin, targetGeometry, targetLayout);
      const failure = await put(placement.writes, serial, pageId);
      if (failure !== null) {
        setMessage(`Could not copy: ${failure}`);
        return;
      }
      const pageName = `“${pageLabel(targetLayout, pageId)}”`;
      const deckName = deckChoices(config, selection.profile, daemon).find((d) => d.id === serial)?.label ?? serial;
      // The selection, the clipboard and the decks stay as they were: nothing here is shown until you go and look.
      setMessage(placementMessage('Copied', placement, serial === selection.serial ? pageName : `${deckName} › ${pageName}`));
    },

    copyKey: async (from, to) => {
      if (editingBlocked) return;
      const fromGeometry = geometryFor(daemon, from.serial);
      const toGeometry = geometryFor(daemon, to.serial);
      const toLayout = layoutFor(config, selection.profile, to.serial);
      const toPosition = toGeometry?.keys.find((k) => k.index === to.index);
      if (!fromGeometry || !toPosition || !toLayout || !Object.prototype.hasOwnProperty.call(toLayout.pages, to.page)) return;
      const clip = copyKeys(from.def, fromGeometry, [from.index]);
      if (clip === null) return;
      // Anchored on the key dropped on: one key always has a place there, so
      // nothing is skipped; a page key whose target is not on that deck loses the link.
      const placement = placeClipboard(clip, { row: toPosition.row, column: toPosition.column }, toGeometry!, toLayout);
      const failure = await put(placement.writes, to.serial, to.page);
      if (failure !== null) {
        setMessage(`Could not copy the key: ${failure}`);
        return;
      }
      const deckName = deckChoices(config, selection.profile, daemon).find((d) => d.id === to.serial)?.label ?? to.serial;
      setMessage(placementMessage('Copied', placement, `${deckName} › “${pageLabel(toLayout, to.page)}”`));
    },

    move: async (from, to, on) => {
      if (from === to || editingBlocked || (!on && !ready)) return;
      const failure = await put(swapKeys(on?.def ?? page!, from, to), on?.serial, on?.page);
      if (failure !== null) {
        setMessage(`Could not move the key: ${failure}`);
        return;
      }
      setMessage(null);
      // The inspector follows the button to where it now is.
      selectKeys([to]);
    },

    clear: async () => {
      if (!ready || selection.keys.length === 0) return;
      // No confirmation, however many keys. The only undo is the daemon's
      // rolling backups (src/backups.ts), taken at most every five minutes, so
      // restoring one can also lose other recent edits.
      const failure = await put(clearKeys(page, selection.keys));
      setMessage(failure === null ? null : `Could not clear: ${failure}`);
    },
  };
}
