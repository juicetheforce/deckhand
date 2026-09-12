import { promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Defaults } from './types.js';

export const CONFIG_DIR =
  process.env.DECKHAND_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'deckhand');

export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS: Required<Defaults> = {
  background: '#101014',
  labelColor: '#ffffff',
  labelSize: 14,
  labelPosition: 'bottom',
  iconFit: 'cover',
  brightness: 70,
  refreshMs: 1000,
};

/** Expand a leading ~ so icon paths can be written the way you'd type them. */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function validate(config: unknown): Config {
  if (typeof config !== 'object' || config === null) {
    throw new Error('config must be a JSON object');
  }
  const c = config as Partial<Config>;
  if (typeof c.decks !== 'object' || c.decks === null) {
    throw new Error('config is missing a "decks" object');
  }

  for (const [serial, deck] of Object.entries(c.decks)) {
    if (typeof deck.pages !== 'object' || deck.pages === null) {
      throw new Error(`deck "${serial}" is missing a "pages" object`);
    }
    if (Object.keys(deck.pages).length === 0) {
      throw new Error(`deck "${serial}" has no pages defined`);
    }
    const start = deck.startPage ?? Object.keys(deck.pages)[0];
    if (!deck.pages[start]) {
      throw new Error(`deck "${serial}" startPage "${start}" does not exist`);
    }
    for (const [pageName, page] of Object.entries(deck.pages)) {
      if (typeof page.buttons !== 'object' || page.buttons === null) {
        throw new Error(`page "${pageName}" on deck "${serial}" is missing "buttons"`);
      }
      for (const key of Object.keys(page.buttons)) {
        if (!/^\d+$/.test(key)) {
          throw new Error(
            `button key "${key}" on page "${pageName}" must be a numeric index`,
          );
        }
      }
    }
  }
  return c as Config;
}

export async function loadConfig(): Promise<Config> {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  return validate(parsed);
}

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

/**
 * Watch the config file and call back on change. Editors that write via
 * rename (most of them) can briefly remove the file, so this debounces and
 * re-establishes the watch rather than trusting a single event.
 */
export function watchConfig(onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let stopped = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };

  const attach = () => {
    if (stopped) return;
    try {
      watcher = watch(CONFIG_DIR, (_event, filename) => {
        if (!filename || filename.toString() === 'config.json') schedule();
      });
      watcher.on('error', () => {
        watcher?.close();
        setTimeout(attach, 1000);
      });
    } catch {
      setTimeout(attach, 1000);
    }
  };

  attach();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
