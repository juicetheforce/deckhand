import path from 'node:path';
import { resolvePage } from '../../../src/config-common.js';
import type { ActionDef, ButtonDef, Config, LayoutDef, PageDef, ProfileDef } from '../../../src/types.js';
import type { ButtonLocation, Edit, EditResult } from '../shared/edits.js';
import { BUILTIN_PREFIX, builtinName } from '../shared/icons.js';
import { multiSteps, pageLinks, targetsPage } from '../shared/links.js';

export type { ButtonLocation, Edit, EditResult };

/**
 * The pure functions that apply the editor's edits (their types are in
 * src/shared/edits.ts) to a config (docs/scope.md §10). The renderer sends an Edit;
 * the main process applies it to a copy of the config, validates the result
 * with the daemon's own validateConfig, and autosaves (config-store.ts).
 *
 * Every edit changes only what it names. Nothing here reorders, normalises
 * or fills in defaults, because the config diff after an editing session must
 * show only what was changed (M4 phase A exit).
 */

/** An edit that cannot apply: a location that does not exist, a clashing name. */
export class EditError extends Error {}

export interface EditEnvironment {
  /** Home directory, for storing icon paths as ~/... */
  homeDir: string;
  /** Random hex, for new page IDs. Injected so tests are repeatable. */
  randomHex: (length: number) => string;
}

/** Store an absolute path under the home directory as ~/..., so a config survives a new username. */
export function toConfigPath(filePath: string, homeDir: string): string {
  if (filePath === homeDir) return '~';
  const prefix = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
  if (filePath.startsWith(prefix)) return `~/${filePath.slice(prefix.length)}`;
  return filePath;
}

function profileAt(config: Config, profile: string): ProfileDef {
  const profileDef = Object.prototype.hasOwnProperty.call(config.profiles, profile) ? config.profiles[profile] : undefined;
  if (!profileDef) throw new EditError(`no profile with ID "${profile}"`);
  return profileDef;
}

function layoutAt(config: Config, profile: string, serial: string): LayoutDef {
  const profileDef = profileAt(config, profile);
  const layout = Object.prototype.hasOwnProperty.call(profileDef.layouts, serial) ? profileDef.layouts[serial] : undefined;
  if (!layout) throw new EditError(`profile "${profile}" has no layout for deck "${serial}"`);
  return layout;
}

/**
 * An ID that is neither an existing ID nor an existing name — a name equal to
 * another entry's ID is refused by validateConfig, since the ID would always
 * win and the name could never be reached (docs/scope.md §5).
 */
function freshId(prefix: string, entries: Record<string, { name?: string }>, env: EditEnvironment): string {
  let id: string;
  do {
    id = `${prefix}${env.randomHex(4)}`;
  } while (Object.prototype.hasOwnProperty.call(entries, id) || Object.values(entries).some((e) => e.name === id));
  return id;
}

/** Refuse a name already in use as another entry's name or ID, before validateConfig has to. */
function rejectNameClash(entries: Record<string, { name?: string }>, name: string, complaint: (name: string) => string): void {
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.name === name || id === name) throw new EditError(complaint(name));
  }
}

/**
 * A layout for a deck a profile has just started covering. validateLayout
 * refuses a layout with no pages, so it gets one, and `startPage` is written
 * rather than left implicit: which page a deck opens on should be visible in
 * the file, not a consequence of key order.
 */
function newLayout(pageName: string, env: EditEnvironment): LayoutDef {
  const name = pageName.trim();
  if (name === '') throw new EditError('a new layout needs a name for its first page');
  const pageId = `pg_${env.randomHex(4)}`;
  return { startPage: pageId, pages: { [pageId]: { name, buttons: {} } } };
}

function pageAt(config: Config, at: ButtonLocation): PageDef {
  const layout = layoutAt(config, at.profile, at.serial);
  const page = Object.prototype.hasOwnProperty.call(layout.pages, at.page) ? layout.pages[at.page] : undefined;
  if (!page) throw new EditError(`no page with ID "${at.page}" in profile "${at.profile}" for deck "${at.serial}"`);
  if (!Number.isInteger(at.index) || at.index < 0) throw new EditError(`key index ${at.index} is not a valid index`);
  return page;
}

/** Remove a key from a button; a button left with nothing on it is removed, since {} is an empty slot anyway. */
function removeField(page: PageDef, index: number, field: keyof ButtonDef): void {
  const key = String(index);
  const button = page.buttons[key];
  if (!button || !(field in button)) return;
  delete button[field];
  if (Object.keys(button).length === 0) delete page.buttons[key];
}

/** The button at a location, created empty if the slot is empty. */
function buttonFor(page: PageDef, index: number): ButtonDef {
  const key = String(index);
  page.buttons[key] ??= {};
  return page.buttons[key];
}

/**
 * Take the navigation to `pageId` off every key in this layout that has it,
 * keeping icon and label — the same shape as "Clear hotkey", so the key still
 * looks placed and the grid's "no action" mark shows on it. A multi action
 * loses only the step that pointed there, not the rest of the macro.
 */
function clearPageLinks(layout: LayoutDef, pageId: string): void {
  for (const link of pageLinks(layout, pageId)) {
    const page = layout.pages[link.page];
    const button = page.buttons[String(link.index)];
    const action = button?.[link.where];
    if (!action) continue;
    const steps = link.inMulti ? multiSteps(action) : null;
    if (steps) {
      const kept = steps.filter((step) => !targetsPage(step, layout, pageId));
      if (kept.length === 0) removeField(page, link.index, link.where);
      else action.steps = kept;
    } else {
      removeField(page, link.index, link.where);
    }
  }
}

/**
 * Point every link that reached this page **by name** at its ID instead, so a
 * rename cannot break it. Only links whose `to` is not already the ID are
 * touched, so a config that already uses IDs comes out unchanged.
 */
function pinNameLinksToId(layout: LayoutDef, pageId: string): void {
  const pin = (action: ActionDef | undefined): void => {
    if (!action) return;
    if (targetsPage(action, layout, pageId) && action.to !== pageId) {
      action.to = pageId;
      return;
    }
    for (const step of multiSteps(action) ?? []) pin(step);
  };
  for (const page of Object.values(layout.pages)) {
    for (const button of Object.values(page.buttons)) {
      pin(button.action);
      pin(button.onRelease);
    }
  }
  // startPage takes an ID or a name too, and an unresolvable one is refused.
  if (layout.startPage !== undefined && layout.startPage !== pageId && resolvePage(layout, layout.startPage) === pageId) {
    layout.startPage = pageId;
  }
}

/**
 * Apply one edit to a config, in place. The caller passes a copy and validates
 * the result. Throws EditError when the edit cannot apply.
 */
export function applyEdit(config: Config, edit: Edit, env: EditEnvironment): EditResult {
  switch (edit.kind) {
    case 'setAction': {
      buttonFor(pageAt(config, edit.at), edit.at.index).action = edit.action;
      return {};
    }
    case 'removeAction': {
      removeField(pageAt(config, edit.at), edit.at.index, 'action');
      return {};
    }
    case 'setIcon': {
      const page = pageAt(config, edit.at);
      switch (edit.icon.kind) {
        // Removing the key is what makes the action's default render (phase C).
        case 'default':
          removeField(page, edit.at.index, 'icon');
          break;
        // An explicit null, which the default resolution must not override.
        case 'none':
          buttonFor(page, edit.at.index).icon = null;
          break;
        case 'file':
          // A built-in is a name, never a path into the app directory (scope §3).
          if (edit.icon.path.startsWith(BUILTIN_PREFIX)) {
            if (builtinName(edit.icon.path) === null) throw new EditError(`"${edit.icon.path}" is not a built-in icon`);
            buttonFor(page, edit.at.index).icon = edit.icon.path;
          } else {
            buttonFor(page, edit.at.index).icon = toConfigPath(edit.icon.path, env.homeDir);
          }
          break;
      }
      return {};
    }
    case 'setLabel': {
      const page = pageAt(config, edit.at);
      if (edit.label === null || edit.label === '') removeField(page, edit.at.index, 'label');
      else buttonFor(page, edit.at.index).label = edit.label;
      return {};
    }
    case 'setLabelStyle': {
      const page = pageAt(config, edit.at);
      if (edit.value === null) {
        removeField(page, edit.at.index, edit.field);
        return {};
      }
      const button = buttonFor(page, edit.at.index);
      if (edit.field === 'labelSize') {
        if (typeof edit.value !== 'number' || !Number.isFinite(edit.value) || edit.value <= 0) {
          throw new EditError('label size must be a positive number of pixels');
        }
        button.labelSize = edit.value;
      } else if (edit.field === 'labelPosition') {
        if (edit.value !== 'top' && edit.value !== 'center' && edit.value !== 'bottom') {
          throw new EditError(`"${String(edit.value)}" is not a label position`);
        }
        button.labelPosition = edit.value;
      } else {
        if (typeof edit.value !== 'string' || edit.value.trim() === '') throw new EditError('label colour must be a colour');
        button.labelColor = edit.value;
      }
      return {};
    }
    case 'clearButton': {
      delete pageAt(config, edit.at).buttons[String(edit.at.index)];
      return {};
    }
    case 'putButtons': {
      const page = pageAt(config, { profile: edit.profile, serial: edit.serial, page: edit.page, index: 0 });
      const seen = new Set<number>();
      for (const { index, button } of edit.writes) {
        if (!Number.isInteger(index) || index < 0) throw new EditError(`key index ${index} is not a valid index`);
        // Two writes to one slot would make the result depend on their order.
        if (seen.has(index)) throw new EditError(`key ${index + 1} is written twice in one edit`);
        seen.add(index);
        // {} is an empty slot anyway, so it is written as one — as removeField does.
        if (button === null || Object.keys(button).length === 0) delete page.buttons[String(index)];
        else page.buttons[String(index)] = structuredClone(button);
      }
      return {};
    }
    case 'addPage': {
      const layout = layoutAt(config, edit.profile, edit.serial);
      const name = edit.name.trim();
      if (name === '') throw new EditError('a new page needs a name');
      rejectNameClash(layout.pages, name, (n) => `this deck already has a page called "${n}"`);
      const pageId = freshId('pg_', layout.pages, env);
      layout.pages[pageId] = { name, buttons: {} };
      return { pageId };
    }
    case 'addProfile': {
      const name = edit.name.trim();
      if (name === '') throw new EditError('a new profile needs a name');
      rejectNameClash(config.profiles, name, (n) => `there is already a profile called "${n}"`);
      // A profile covering no deck would show nothing and could never be seen.
      const serials = [...new Set(edit.serials)];
      if (serials.length === 0) throw new EditError('a new profile needs at least one deck');
      const profileId = freshId('prof_', config.profiles, env);
      const layouts: Record<string, LayoutDef> = {};
      for (const serial of serials) layouts[serial] = newLayout(edit.pageName, env);
      config.profiles[profileId] = { name, layouts };
      return { profileId };
    }
    case 'renamePage': {
      const layout = layoutAt(config, edit.profile, edit.serial);
      const page = Object.prototype.hasOwnProperty.call(layout.pages, edit.page) ? layout.pages[edit.page] : undefined;
      if (!page) throw new EditError(`no page with ID "${edit.page}" in profile "${edit.profile}" for deck "${edit.serial}"`);
      const name = edit.name.trim();
      if (name === '') throw new EditError('a page needs a name');
      for (const [id, other] of Object.entries(layout.pages)) {
        if (id === edit.page) continue;
        if (other.name === name || id === name) throw new EditError(`this deck already has a page called "${name}"`);
      }
      if (page.name === name) return {};
      // Before the name changes, while the old one still resolves.
      pinNameLinksToId(layout, edit.page);
      page.name = name;
      return {};
    }
    case 'deletePage': {
      const layout = layoutAt(config, edit.profile, edit.serial);
      if (!Object.prototype.hasOwnProperty.call(layout.pages, edit.page)) {
        throw new EditError(`no page with ID "${edit.page}" in profile "${edit.profile}" for deck "${edit.serial}"`);
      }
      const remaining = Object.keys(layout.pages).filter((id) => id !== edit.page);
      if (remaining.length === 0) {
        throw new EditError("a deck's layout must keep at least one page, so this one cannot be deleted");
      }
      // Before the delete: a link written as the page's name stops resolving once it is gone.
      clearPageLinks(layout, edit.page);
      delete layout.pages[edit.page];
      // An explicit startPage that no longer resolves makes the daemon refuse
      // the whole config, so it moves rather than the delete failing.
      if (layout.startPage !== undefined && resolvePage(layout, layout.startPage) === null) {
        layout.startPage = remaining[0];
      }
      return {};
    }
    case 'renameDeck': {
      const name = edit.name === null ? '' : edit.name.trim();
      config.decks ??= {};
      if (name === '') {
        // Back to the model name. An entry left with nothing on it goes too, so
        // clearing a name does not leave `"<serial>": {}` behind.
        const deck = config.decks[edit.serial];
        if (deck) {
          delete deck.name;
          if (Object.keys(deck).length === 0) delete config.decks[edit.serial];
        }
        if (Object.keys(config.decks).length === 0) delete config.decks;
        return {};
      }
      (config.decks[edit.serial] ??= {}).name = name;
      return {};
    }
    case 'addLayout': {
      const profile = profileAt(config, edit.profile);
      if (Object.prototype.hasOwnProperty.call(profile.layouts, edit.serial)) {
        throw new EditError(`this profile already has a layout for deck "${edit.serial}"`);
      }
      profile.layouts[edit.serial] = newLayout(edit.pageName, env);
      return {};
    }
  }
}

/** The config file's text as the editor writes it: two-space JSON and a final newline, like the daemon's bootstrap. */
export function serializeConfig(config: Config): string {
  return JSON.stringify(config, null, 2) + '\n';
}
