/**
 * Templates (scope §7, "Templates", decided 2026-11-17; boards 20d–20g, 21g):
 * a layout and nothing more — each control's place, size and shape, at the
 * size of the screen it was saved on. No actions, art, labels or background.
 * Kept in config.json (`templates`, oldest first), so a backup and an export
 * carry them, and offered on every touchscreen. Pure, so the main process
 * (which applies the edits) and the window share one copy.
 */
import { CUSTOM_LAYOUT } from '../../../src/panel-presets.js';
import type { PanelControlDef, PanelDef, TemplateDef } from '../../../src/types.js';

/** A template's name: at most this many characters (src/config.ts holds the same). */
export const TEMPLATE_NAME_MAX = 64;

/** A control as a template keeps it: its place, size and shape, and Lock proportions — nothing it shows. */
function layoutOnly(c: PanelControlDef): PanelControlDef {
  const out: PanelControlDef = { id: c.id, x: c.x, y: c.y, w: c.w, h: c.h };
  if (c.shape !== undefined) out.shape = c.shape;
  if (c.radius !== undefined) out.radius = c.radius;
  if (c.keepRatio) out.keepRatio = true;
  return out;
}

/** The layout a template keeps of a page's panel: a custom layout of the same canvas, its controls' layout only. */
export function templateLayout(panel: PanelDef): PanelDef {
  return { size: { width: panel.size.width, height: panel.size.height }, controls: panel.controls.map(layoutOnly), preset: CUSTOM_LAYOUT };
}

/** The same name, ignoring case and the spaces around it. */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function templateNamed(templates: ReadonlyArray<TemplateDef> | undefined, name: string): TemplateDef | undefined {
  return (templates ?? []).find((t) => sameName(t.name, name));
}

/** Why a name cannot be used, or null: empty or too long. A name in use is the caller's question (replace, or refuse). */
export function badTemplateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A template needs a name.';
  if (trimmed.length > TEMPLATE_NAME_MAX) return `A template's name is at most ${TEMPLATE_NAME_MAX} characters.`;
  return null;
}

/**
 * Save as template: the list with this layout under this name, newest last.
 * A name in use replaces that template only when `replace` is set (21g: "a
 * name already in use offers to replace that template"); otherwise refused.
 */
export function withTemplate(templates: ReadonlyArray<TemplateDef> | undefined, name: string, panel: PanelDef, replace: boolean): TemplateDef[] {
  const bad = badTemplateName(name);
  if (bad) throw new Error(bad);
  if (panel.controls.length === 0) throw new Error('a layout with no controls is not saved as a template');
  const list = [...(templates ?? [])];
  const existing = list.findIndex((t) => sameName(t.name, name));
  if (existing >= 0 && !replace) throw new Error(`there is already a template called "${list[existing].name}"`);
  if (existing >= 0) list.splice(existing, 1);
  return [...list, { name: name.trim(), panel: templateLayout(panel) }];
}

/** Rename, in place: refused for a name another template has. */
export function renamedTemplate(templates: ReadonlyArray<TemplateDef> | undefined, name: string, to: string): TemplateDef[] {
  const list = [...(templates ?? [])];
  const i = list.findIndex((t) => sameName(t.name, name));
  if (i < 0) throw new Error(`no template called "${name}"`);
  const bad = badTemplateName(to);
  if (bad) throw new Error(bad);
  const clash = list.find((t, j) => j !== i && sameName(t.name, to));
  if (clash) throw new Error(`there is already a template called "${clash.name}"`);
  list[i] = { ...list[i], name: to.trim() };
  return list;
}

/** Delete: the pages made from it are not changed — they were never linked to it. */
export function withoutTemplate(templates: ReadonlyArray<TemplateDef> | undefined, name: string): TemplateDef[] {
  const list = [...(templates ?? [])];
  if (!list.some((t) => sameName(t.name, name))) throw new Error(`no template called "${name}"`);
  return list.filter((t) => !sameName(t.name, name));
}

/** A new page's layout from a template: a copy, not linked, its own canvas kept — the daemon scales it to fit the screen, centred. */
export function pagePanelFromTemplate(t: TemplateDef): PanelDef {
  return templateLayout(t.panel);
}

/** Templates as the picker lists them (20g): newest first. */
export function newestFirst(templates: ReadonlyArray<TemplateDef> | undefined): TemplateDef[] {
  return [...(templates ?? [])].reverse();
}

/** The one scale a layout is shown at on a screen: the largest that fits, centred, never re-flowed (24c). */
export function fitScale(layout: { width: number; height: number }, screen: { width: number; height: number }): number {
  return Math.min(screen.width / layout.width, screen.height / layout.height);
}

/** Whether a layout was made for another screen size than this one. */
export function madeForAnother(layout: { width: number; height: number }, screen: { width: number; height: number } | null | undefined): boolean {
  return !!screen && (layout.width !== screen.width || layout.height !== screen.height);
}

/**
 * The scale a layout is drawn at in a room on the editor's canvas: fitted to
 * the room — or, when it was made for another screen size, the screen fitted
 * to the room and the layout inside the screen, the one scale the deck uses.
 * Never the layout straight into the room: a frame its header widened is not
 * the screen's shape. Shared by the grid (DeckGrid) and Edit layout.
 */
export function layoutScale(size: { width: number; height: number }, room: { width: number; height: number }, screen?: { width: number; height: number } | null): number {
  if (!screen || !madeForAnother(size, screen)) return fitScale(size, room);
  return fitScale(screen, room) * fitScale(size, screen);
}

/** A positioned page's box in its deck's frame (DeckGrid), in pixels; `screen` is the deck's screen, when known. */
export function positionedBox(canvas: { width: number; height: number }, room: { width: number; height: number } | undefined, screen?: { width: number; height: number } | null): { width: number; height: number } | { width: string; aspectRatio: string } {
  if (!room) return { width: '100%', aspectRatio: `${canvas.width} / ${canvas.height}` };
  const scale = layoutScale(canvas, room, screen);
  return { width: Math.floor(canvas.width * scale), height: Math.floor(canvas.height * scale) };
}
