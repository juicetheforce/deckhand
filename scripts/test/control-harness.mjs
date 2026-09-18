/**
 * Shared pieces for scripts/smoke-socket.mjs: fake decks, a daemon-shaped
 * setup (Profiles, sessions, a control server on a scratch socket, wired the
 * way src/index.ts wires them), and a socket client.
 *
 * Set DECKHAND_INPUT_BIN before importing this file if the input helper
 * should be the fake one: src/input.js reads it when first imported.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (file) => path.join(REPO, 'dist', file);

export const { DeckSession } = await import(dist('deck.js'));
export const { Profiles } = await import(dist('profiles.js'));
export const { validateConfig } = await import(dist('config.js'));
export const server = await import(dist('control/server.js'));
export const commands = await import(dist('control/commands.js'));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
export function check(name, condition) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}`);
  if (!condition) failures++;
}
export const failureCount = () => failures;

/** A scratch directory short enough for a socket path (Linux allows 107 bytes). */
export async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dh-'));
}

/** A fake deck with a grid of LCD keys, recording what is written to each key. */
export class FakeDeck {
  constructor({ columns = 8, rows = 4, pixels = 96, model = 'xl', productName = 'Fake XL' } = {}) {
    this.MODEL = model;
    this.PRODUCT_NAME = productName;
    this.CONTROLS = Array.from({ length: columns * rows }, (_, i) => ({
      type: 'button', index: i, hidIndex: i, row: Math.floor(i / columns), column: i % columns,
      feedbackType: 'lcd', pixelSize: { width: pixels, height: pixels },
    }));
    this.handlers = {};
    this.writes = new Map();
    this.images = new Map();
    this.brightness = null;
  }
  on(event, callback) { this.handlers[event] = callback; }
  press(index) { this.handlers.down?.({ type: 'button', index }); }
  release(index) { this.handlers.up?.({ type: 'button', index }); }
  async fillKeyBuffer(index, buffer) {
    this.writes.set(index, (this.writes.get(index) ?? 0) + 1);
    this.images.set(index, buffer);
  }
  async clearPanel() {}
  async setBrightness(value) { this.brightness = value; }
  async close() {}
}

/**
 * A daemon-shaped setup around a config. extraDeps fills in or overrides
 * ControlDeps (releaseSocketKeys, audioState) for tests that need them.
 */
export async function startDaemon(directory, config, extraDeps = {}) {
  const socket = path.join(directory, 'c.sock');
  const state = { config: validateConfig(structuredClone(config)), lastReload: { ok: true, at: 'start' } };
  const profiles = new Profiles(state.config);
  const sessions = new Map();
  const unattached = new Map();
  let events = null;
  profiles.setChangeListener(() => events?.state());

  const deps = {
    sessions,
    profiles: () => profiles,
    configPath: '/test/config.json',
    lastReload: () => state.lastReload,
    backups: () => ({ dir: '/test/backups', count: 0, newest: null }),
    unattachedDecks: () => unattached,
    releaseSocketKeys: async () => [],
    audioState: () => null,
    ...extraDeps,
  };
  const control = new server.ControlServer(commands.createHandlers(deps));
  events = commands.eventNotifiers(control, deps);
  if (!(await control.start(socket))) throw new Error('control server did not start');

  async function attach(serial, fake) {
    const id = profiles.chooseProfileFor(serial);
    const session = new DeckSession(fake, {
      serial,
      hardware: state.config.decks?.[serial] ?? {},
      layout: profiles.layoutFor(id, serial),
      defaults: {},
      switchProfile: async (ref) => { await profiles.switchTo(ref, sessions); },
      onStateChange: () => events?.state(),
    });
    await session.start();
    sessions.set(serial, session);
    profiles.markShown(serial, id);
    events.state();
    return session;
  }

  async function stop() {
    await control.stop();
    for (const session of sessions.values()) await session.close();
  }

  return { socket, control, events, profiles, sessions, unattached, state, deps, attach, stop };
}

/**
 * Reload config.json into a startDaemon() daemon whenever it changes, the way
 * src/index.ts reload() does and **in the same order**: record the reload,
 * apply it to the decks, then announce it with the `config` event. The editor
 * clears a preview on that event, so the order is what stops a key flashing
 * its old icon (Ship, 2026-09-18). This is the one copy the checks share; keep
 * it in step with reload().
 *
 * `applyDelayMs` holds the apply back, so a check sees what depends on the
 * order every run rather than by luck. `onReload(ok)` is told after each
 * reload, good or refused. Import only after DECKHAND_CONFIG_DIR is set:
 * dist/config.js reads it when first imported. Returns stop().
 */
export async function reloadLikeTheDaemon(daemon, { applyDelayMs = 0, onReload = () => undefined } = {}) {
  const { loadConfig, watchConfig } = await import(dist('config.js'));
  return watchConfig(async () => {
    try {
      const { config } = await loadConfig();
      daemon.state.config = config;
      daemon.state.lastReload = { ok: true, at: new Date().toISOString() };
      if (applyDelayMs > 0) await sleep(applyDelayMs);
      await daemon.profiles.applyReload(config, daemon.sessions);
      daemon.events.config();
      onReload(true);
    } catch (err) {
      daemon.state.lastReload = { ok: false, at: new Date().toISOString(), error: err.message };
      daemon.events.config();
      onReload(false);
    }
  });
}

let nextRequestId = 1;

/** A socket client: request() resolves with the reply; events collects events. */
export async function connect(socketPath) {
  const socket = net.connect(socketPath);
  const replies = new Map();
  const events = [];
  const lines = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      lines.push(message);
      if (message.event) events.push(message);
      else replies.get(message.id)?.(message);
    }
  });
  const closed = new Promise((resolve) => socket.on('close', resolve));
  await new Promise((resolve) => socket.once('connect', resolve));
  return {
    socket,
    events,
    lines,
    closed,
    request(cmd, args) {
      const id = nextRequestId++;
      return new Promise((resolve) => {
        replies.set(id, resolve);
        socket.write(JSON.stringify({ id, cmd, args }) + '\n');
      });
    },
    write(text) { socket.write(text); },
    close() { socket.destroy(); },
  };
}
