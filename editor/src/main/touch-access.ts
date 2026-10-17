/**
 * Touchscreen access for virtual decks: the editor's side of pairing.
 *
 * No touchscreen is readable by the user until it is paired (Ryan's decision,
 * 2026-10-17; SECURITY.md, "Device access"): a rule granting a touchscreen
 * lets any program the user runs read its touches — on a touchscreen laptop,
 * its on-screen keyboard's typing — where Wayland would otherwise keep them
 * apart. So pairing runs the root helper (udev/deckhand-touch-access, installed
 * root-owned at /usr/local/libexec) through pkexec, which asks for the
 * password once: the helper gives temporary read access to the touchscreens
 * while the daemon waits for the tap, then writes a rule for the paired ones
 * only — a file ACL for this user, never the sticky uaccess tag — and drops
 * the temporary access. Removing a virtual deck rewrites the rule without it
 * and takes the ACL off, which needs the password again. Access belongs to
 * the user who paired the touchscreen, whoever is logged in.
 *
 * The editor runs it, not the daemon: pkexec asks through the desktop
 * session's polkit agent, and the daemon, a systemd user service, is outside
 * the session.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import type { Config } from '../../../src/types.js';

/** The installed helper, and pkexec; each overridable for tests only. */
const HELPER = process.env.DECKHAND_TOUCH_ACCESS ?? '/usr/local/libexec/deckhand-touch-access';
const PKEXEC = process.env.DECKHAND_PKEXEC ?? 'pkexec';

export class AccessError extends Error {
  constructor(
    readonly code: 'not_authorized' | 'not_installed' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface Touch {
  vendor: string;
  product: string;
  serial?: string;
}

/** A paired touchscreen as the helper's rule names it: its IDs, and its serial when it has one. */
export function entryFor(touch: Touch): string {
  return touch.serial ? `${touch.vendor}:${touch.product}:${touch.serial}` : `${touch.vendor}:${touch.product}`;
}

/**
 * Every paired touchscreen's entry, as the rule should have them: each virtual
 * deck's in the config, with one deck's changed (its new touchscreen) or
 * removed (null). Sorted and without repeats, so equal sets compare equal.
 */
export function entriesOf(config: Config | null, change?: { key: string; touch: Touch | null }): string[] {
  const entries = new Set<string>();
  for (const [key, deck] of Object.entries(config?.decks ?? {})) {
    if (!deck.virtual || (change && key === change.key)) continue;
    if (deck.virtual.touch) entries.add(entryFor(deck.virtual.touch));
  }
  if (change?.touch) entries.add(entryFor(change.touch));
  return [...entries].sort();
}

const NOT_INSTALLED = `Deckhand's touchscreen helper is not installed at ${HELPER}. Run the install line again: it adds it.`;
const NOT_AUTHORIZED = 'Pairing needs your password: it gives Deckhand access to the one touchscreen you tap, and to no other.';

function start(args: string[]): { proc: ChildProcessWithoutNullStreams; lines: AsyncIterator<string>; exited: Promise<number | null> } {
  const proc = spawn(PKEXEC, [HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
    proc.on('error', () => resolve(-1));
  });
  const lines = readline.createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  return { proc, lines, exited };
}

/** The next line, or why there is none: pkexec's 126 and 127 are a refused or dismissed password. */
async function nextLine(run: ReturnType<typeof start>): Promise<string> {
  const next = await Promise.race([run.lines.next(), run.exited.then((code) => ({ code }))]);
  if ('value' in next && typeof next.value === 'string') return next.value;
  const code = 'code' in next ? next.code : await run.exited;
  if (code === 126 || code === 127) throw new AccessError('not_authorized', NOT_AUTHORIZED);
  if (code === -1) throw new AccessError('failed', 'pkexec could not be started: is polkit installed?');
  throw new AccessError('failed', `the touchscreen helper stopped (${code})`);
}

/** A failure the helper itself reported ("error: …"), as an AccessError. */
function checked(line: string, want: string): void {
  if (line === want) return;
  throw new AccessError('failed', line.startsWith('error: ') ? line.slice(7) : `the touchscreen helper said: ${line}`);
}

export interface PairingAccess {
  /** Write the rule to exactly these entries and drop the temporary access. */
  commit(entries: string[]): Promise<void>;
  /** Drop the temporary access, writing nothing. Never waits. */
  cancel(): void;
}

/** Ask for the password and give temporary access to the touchscreens, for a pairing tap. */
export async function grantForPairing(): Promise<PairingAccess> {
  if (!existsSync(HELPER)) throw new AccessError('not_installed', NOT_INSTALLED);
  const run = start(['pair']);
  let open = true;
  const cancel = () => {
    if (!open) return;
    open = false;
    // End of input: the helper drops the access and exits.
    run.proc.stdin.end();
  };
  try {
    checked(await nextLine(run), 'granted');
  } catch (err) {
    cancel();
    throw err;
  }
  return {
    cancel,
    async commit(entries) {
      if (!open) throw new AccessError('failed', 'the pairing was cancelled');
      open = false;
      run.proc.stdin.end(`set ${entries.join(' ')}\n`);
      checked(await nextLine(run), 'done');
    },
  };
}

/** Rewrite the rule to exactly these entries (a virtual deck removed): asks for the password. */
export async function setAccess(entries: string[]): Promise<void> {
  if (!existsSync(HELPER)) throw new AccessError('not_installed', NOT_INSTALLED);
  const run = start(['set', ...entries]);
  run.proc.stdin.end();
  checked(await nextLine(run), 'done');
}
