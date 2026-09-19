/**
 * Deleting a profile keeps the configuration first (M5, the maintainer 2026-09-19): a
 * delete can take a deck's worth of keys with it, the editor has no undo, and
 * the rolling backups can be five minutes behind (docs/scope.md §5). The copy
 * is `before-delete-<time>.json`, a name the rolling rotation never matches,
 * so it is never deleted.
 *
 * **Nothing is deleted unless that copy was written.** Its own module, not
 * main.ts, so that order is tested in plain Node (test/profile-delete.test.ts)
 * rather than only through the editor.
 */
import { promises as fs } from 'node:fs';
import type { Config } from '../../../src/types.js';
import type { ApplyResult, Edit } from '../shared/edits.js';
import type { DeleteProfileResult } from '../shared/bridge.js';
import { planProfileDeletion } from '../shared/profile-deletion.js';
import { keepConfigCopy } from './kept-configs.js';

/** What this needs of main.ts: the open store, where backups live, and how to shorten a path for a message. */
export interface DeleteDeps {
  store: {
    state(): { config: Config };
    /** Write any autosave still pending, so the copy is what was really there. */
    flush(): Promise<boolean>;
    apply(edit: Edit): ApplyResult;
  } | null;
  storeError?: string | null;
  backupDir: string;
  configPath: string;
  /** The full path of a kept copy, for the message that names it. */
  keptPath(file: string): string;
  tildePath(file: string): string;
}

export async function deleteProfileKeepingACopy(deps: DeleteDeps, profile: string, pageName: string): Promise<DeleteProfileResult> {
  const { store } = deps;
  if (!store) return { ok: false, error: deps.storeError ?? 'config.json is not open' };
  // Refused (the last profile, an unknown one) before anything is written, by
  // the same planning the confirmation showed.
  try {
    planProfileDeletion(store.state().config, profile);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let backup: string;
  try {
    // Edits not yet autosaved belong in the copy: it is what was there before.
    await store.flush();
    const text = await fs.readFile(deps.configPath, 'utf8');
    // Throws at the cap, so the delete stops rather than lose a kept copy.
    const kept = await keepConfigCopy(deps.backupDir, text, 'delete');
    backup = deps.tildePath(deps.keptPath(kept.file));
  } catch (err) {
    return { ok: false, error: `nothing was deleted: your configuration could not be kept first (${(err as Error).message})` };
  }
  const result = store.apply({ kind: 'deleteProfile', profile, pageName });
  return result.ok ? { ok: true, backup } : { ok: false, error: result.error };
}
