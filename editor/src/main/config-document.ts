import path from 'node:path';
import type { ButtonDef, Config, LayoutDef, PageDef } from '../../../src/types.js';
import type { ButtonLocation, Edit, EditResult } from '../shared/edits.js';

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

function layoutAt(config: Config, profile: string, serial: string): LayoutDef {
  const profileDef = Object.prototype.hasOwnProperty.call(config.profiles, profile) ? config.profiles[profile] : undefined;
  if (!profileDef) throw new EditError(`no profile with ID "${profile}"`);
  const layout = Object.prototype.hasOwnProperty.call(profileDef.layouts, serial) ? profileDef.layouts[serial] : undefined;
  if (!layout) throw new EditError(`profile "${profile}" has no layout for deck "${serial}"`);
  return layout;
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
      if (edit.icon === null) removeField(page, edit.at.index, 'icon');
      else buttonFor(page, edit.at.index).icon = toConfigPath(edit.icon, env.homeDir);
      return {};
    }
    case 'setLabel': {
      const page = pageAt(config, edit.at);
      if (edit.label === null || edit.label === '') removeField(page, edit.at.index, 'label');
      else buttonFor(page, edit.at.index).label = edit.label;
      return {};
    }
    case 'clearButton': {
      delete pageAt(config, edit.at).buttons[String(edit.at.index)];
      return {};
    }
    case 'addPage': {
      const layout = layoutAt(config, edit.profile, edit.serial);
      const name = edit.name.trim();
      if (name === '') throw new EditError('a new page needs a name');
      for (const [id, page] of Object.entries(layout.pages)) {
        if (page.name === name || id === name) throw new EditError(`this deck already has a page called "${name}"`);
      }
      let pageId: string;
      do {
        pageId = `pg_${env.randomHex(4)}`;
      } while (Object.prototype.hasOwnProperty.call(layout.pages, pageId) || Object.values(layout.pages).some((p) => p.name === pageId));
      layout.pages[pageId] = { name, buttons: {} };
      return { pageId };
    }
  }
}

/** The config file's text as the editor writes it: two-space JSON and a final newline, like the daemon's bootstrap. */
export function serializeConfig(config: Config): string {
  return JSON.stringify(config, null, 2) + '\n';
}
