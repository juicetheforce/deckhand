import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActionDef, ActionHandler, DisplayPatch } from '../types.js';

const run = promisify(execFile);

/**
 * command — run something.
 *
 *   { "type": "command", "command": "kate ~/notes.md" }        via sh -c
 *   { "type": "command", "exec": ["flatpak", "run", "com.x"] } no shell
 *   { "type": "command", "command": "systemctl --user restart x", "wait": true }
 *
 * By default the process is detached and the button returns immediately —
 * launching an app should never block the deck.
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
        spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
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
      spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
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
    await ctx.deck.goToPage(to);
  },
};

/**
 * profile — switch the active profile on every connected deck.
 *
 *   { "type": "profile", "to": "FFXIV" }     by profile ID or name
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
    return params.showLevel === false ? null : { label: `${ctx.deck.currentBrightness()}%` };
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
