import { useEffect, useState } from 'react';
import type { Config, LayoutDef, PageDef } from '../../../src/types.js';
import type { DaemonView } from '../shared/bridge.js';
import {
  clearKeys,
  copyKeys,
  duplicateKeys,
  pasteAnchor,
  placeClipboard,
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
  /** Copy the selected keys to the same positions on another page, of this deck or another in this profile. */
  copyTo: (serial: string, page: string) => Promise<void>;
}

/**
 * The bulk operations of M4 phase B3 over the selected keys (scope §7, §10).
 * Where keys land is decided by src/shared/bulk.ts; this only gathers what it
 * needs, sends one `putButtons` edit, and says what happened.
 *
 * The clipboard is this renderer's memory: not the system clipboard, and not
 * saved, so it is gone when the editor closes (scope §10, "transient").
 */
export function useBulk({ config, daemon, selection, layout, page, geometry, editingBlocked, selectKeys }: BulkContext): Bulk {
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // A result about one page means nothing once another is shown.
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
      // becomes the selection (§2: duplicate-and-edit is the FFXIV workload).
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

    clear: async () => {
      if (!ready || selection.keys.length === 0) return;
      // No confirmation, however many (the maintainer, 2026-09-16); scope §5 records
      // what the undo net does and does not cover.
      const failure = await put(clearKeys(page, selection.keys));
      setMessage(failure === null ? null : `Could not clear: ${failure}`);
    },
  };
}
