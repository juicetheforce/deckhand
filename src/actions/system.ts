import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

const run = promisify(execFile);

/**
 * Start a program that must outlive the daemon: an app launched from a deck.
 *
 * It runs in its own transient systemd scope, not as the daemon's child.
 * deckhand.service uses systemd's default KillMode=control-group, so anything
 * left in the service's cgroup is killed whenever the service stops — every
 * `install.sh update`, a crash restart, logging out. A detached spawn is not
 * enough: it gets its own session but stays in the cgroup. systemd-run
 * --scope moves itself into a new scope and then execs the program, which
 * inherits the daemon's environment as before.
 *
 * Not KillMode=process on the unit instead: that would leave the input
 * helper, `pactl subscribe` and `udevadm monitor` running after every stop.
 *
 * The press does not wait for the program, so it cannot learn whether it
 * started: a missing program fails inside systemd-run, after the press has
 * returned, and is not badged — as before this, when the failure arrived as
 * an error event after the press had returned. Only systemd-run itself being
 * missing is logged here.
 */
function launch(argv: string[]): void {
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', ...argv], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => console.error(`[command] cannot start systemd-run: ${err.message}`));
  child.unref();
}

/**
 * command — run something.
 *
 *   { "type": "command", "command": "kate ~/notes.md" }        via sh -c
 *   { "type": "command", "exec": ["flatpak", "run", "com.x"] } no shell
 *   { "type": "command", "command": "systemctl --user restart x", "wait": true }
 *
 * By default the program is launched (above) and the button returns
 * immediately — launching an app should never block the deck. With "wait"
 * it runs as the daemon's child, up to 15 s, and its failure marks the key.
 */
export const command: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const wait = params.wait === true;

    if (Array.isArray(params.exec)) {
      const [bin, ...args] = params.exec as string[];
      if (!bin) throw new Error('command action has an empty "exec" array');
      if (wait) {
        const { stdout } = await run(bin, args, { timeout: 15000 });
        if (stdout.trim()) ctx.log(stdout.trim());
      } else {
        launch([bin, ...args]);
      }
      return;
    }

    const cmd = params.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new Error('command action needs "command" or "exec"');
    }
    if (wait) {
      const { stdout } = await run('/bin/sh', ['-c', cmd], { timeout: 15000 });
      if (stdout.trim()) ctx.log(stdout.trim());
    } else {
      launch(['/bin/sh', '-c', cmd]);
    }
  },
};

/**
 * page — navigation. Pages can link to each other freely; "back" returns to
 * wherever you came from.
 *
 *   { "type": "page", "to": "games" }       by page ID or name, on this deck
 *   { "type": "page", "back": true }
 */
export const page: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    if (params.back === true) {
      await ctx.deck.goBack();
      return;
    }
    const to = params.to;
    if (typeof to !== 'string') throw new Error('page action needs "to" or "back": true');
    // A key that goes to a page this deck does not have has failed.
    // Only for a key: over the control socket, goToPage() logging and
    // returning is what the editor's showPage expects of a page just saved.
    if (ctx.source === 'deck' && !ctx.deck.hasPage(to)) throw new Error(`no page with ID or name "${to}" on this deck`);
    await ctx.deck.goToPage(to);
  },
};

/**
 * profile — switch the active profile on every connected deck.
 *
 *   { "type": "profile", "to": "Gaming" }    by profile ID or name
 *
 * Each deck the profile has a layout for goes to that layout's start page. A
 * deck it has no layout for keeps what it is showing.
 */
export const profile: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    const to = params.to;
    if (typeof to !== 'string') throw new Error('profile action needs "to"');
    await ctx.switchProfile(to);
  },
};

/**
 * brightness — set or nudge deck brightness.
 *
 *   { "type": "brightness", "value": 40 }
 *   { "type": "brightness", "delta": -10 }
 *
 * The current level lives on the deck the button belongs to, so each deck
 * nudges from its own level. The deck clamps the value to 5-100.
 *
 * A `delta` key draws `brightness-up` or `brightness-down`. The level is shown
 * only with `showLevel: true` — off by default, so a default key is not a
 * label drawn over an icon.
 */
export const brightness: ActionHandler = {
  async execute(ctx, params: ActionDef) {
    let next: number;
    if (typeof params.value === 'number') {
      next = params.value;
    } else if (typeof params.delta === 'number') {
      next = ctx.deck.currentBrightness() + params.delta;
    } else {
      throw new Error('brightness action needs "value" or "delta"');
    }
    await ctx.deck.setBrightness(next);
    ctx.invalidateByType(['brightness']);
  },

  async describe(ctx, params: ActionDef): Promise<DisplayPatch | null> {
    return params.showLevel === true ? { label: `${ctx.deck.currentBrightness()}%` } : null;
  },
};

/**
 * clock — a button that shows the time.
 *
 *   { "type": "clock", "format": "HH:mm" }
 */
export const clock: ActionHandler = {
  async describe(_ctx, params: ActionDef): Promise<DisplayPatch> {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const label =
      params.format === 'HH:mm:ss'
        ? `${hh}:${mm}:${String(now.getSeconds()).padStart(2, '0')}`
        : `${hh}:${mm}`;
    return { label };
  },
};

/** noop — a deliberately blank button, useful as a spacer. */
export const noop: ActionHandler = {};
