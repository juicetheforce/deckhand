/**
 * The edits the editor can make to a config, as plain data. The renderer
 * builds them; the main process applies them (src/main/config-document.ts).
 *
 * Types only, importing nothing that touches Node: the renderer imports this.
 */
import type { ActionDef } from '../../../src/types.js';

export interface ButtonLocation {
  profile: string;
  serial: string;
  page: string;
  index: number;
}

export type Edit =
  /** Set the key's press action, keeping icon, label and anything else on it. */
  | { kind: 'setAction'; at: ButtonLocation; action: ActionDef }
  /** "Clear hotkey": remove the press action, keeping icon and label. */
  | { kind: 'removeAction'; at: ButtonLocation }
  /** Set or (null) remove the icon. Absolute paths under $HOME are stored as ~/... */
  | { kind: 'setIcon'; at: ButtonLocation; icon: string | null }
  /** Set or (null or "") remove the label. */
  | { kind: 'setLabel'; at: ButtonLocation; label: string | null }
  /** "Clear button": remove the whole key — an empty, dark slot. */
  | { kind: 'clearButton'; at: ButtonLocation }
  /** Bare "add page" (scope §7, phase A): a new, empty, named page in one layout. */
  | { kind: 'addPage'; profile: string; serial: string; name: string };

export type EditResult = { pageId?: string };

export type ApplyResult = { ok: true; result: EditResult } | { ok: false; error: string };
