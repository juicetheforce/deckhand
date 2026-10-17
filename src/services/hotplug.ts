import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { CORSAIR_VENDOR_ID, VENDOR_ID } from '@elgato-stream-deck/node';

/**
 * Hotplug. node-hid has no hotplug event, so this runs one `udevadm monitor`
 * as a child process, shared by every driver, and tells each when a device it
 * cares about is added, removed or changed. The daemon then rescans at once,
 * instead of finding out at the next poll.
 *
 * udevadm prints one line per event, for example
 *
 *   UDEV  [12345.678901] add      /devices/.../0003:0FD9:006C.0009/hidraw/hidraw8 (hidraw)
 *   UDEV  [12345.678901] change   /devices/pci0000:00/0000:00:02.0/drm/card1 (drm)
 *
 * Three subsystems: `hidraw` for Stream Decks (the HID device's name in the
 * path carries the USB vendor id, so matching needs no lookups; the ids come
 * from the Stream Deck library); `drm` for screens — a screen plugged in or
 * out is a `change` on its card — and `input` for touchscreens, for virtual
 * decks. The process runs only while some driver is watching.
 *
 * If udevadm is missing or keeps dying, nothing breaks: the daemon still has
 * its slow safety-net poll.
 */

export type HotplugAction = 'add' | 'remove' | 'change';

export interface UdevEvent {
  action: HotplugAction;
  devpath: string;
  subsystem: string;
}

function hex4(id: number): string {
  return id.toString(16).toUpperCase().padStart(4, '0');
}

const VENDOR_IN_PATH = new RegExp(`:(${[VENDOR_ID, CORSAIR_VENDOR_ID].map(hex4).join('|')}):`, 'i');
const EVENT_LINE = /^UDEV\s+\[[^\]]*\]\s+(add|remove|change)\s+(\S+)\s+\((\w+)\)/;

/** Several devices appear per plug-in; they become one rescan this long after the last. */
const DEBOUNCE_MS = 500;
const RESTART_DELAY_MS = 5000;

interface Watcher {
  match: (event: UdevEvent) => boolean;
  onChange: (event: UdevEvent) => void;
  debounce: NodeJS.Timeout | null;
}

const watchers = new Set<Watcher>();
let proc: ChildProcess | null = null;
let failed = false;

function start(): void {
  if (proc || failed || watchers.size === 0) return;
  const child = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=hidraw', '--subsystem-match=drm', '--subsystem-match=input'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  proc = child;

  if (child.stdout) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const match = EVENT_LINE.exec(line);
      if (!match) return;
      const event: UdevEvent = { action: match[1] as HotplugAction, devpath: match[2], subsystem: match[3] };
      for (const watcher of watchers) {
        if (!watcher.match(event)) continue;
        if (watcher.debounce) clearTimeout(watcher.debounce);
        watcher.debounce = setTimeout(() => {
          watcher.debounce = null;
          if (watchers.has(watcher)) watcher.onChange(event);
        }, DEBOUNCE_MS);
      }
    });
  }

  child.on('error', (err) => {
    // Typically udevadm not installed. Don't retry; the safety-net poll covers it.
    failed = true;
    console.error(`[hotplug] cannot run udevadm monitor (${err.message}); relying on the slow device poll`);
  });

  child.on('exit', (code, signal) => {
    if (proc === child) proc = null;
    if (failed || watchers.size === 0) return;
    console.error(`[hotplug] udevadm monitor exited (code=${code} signal=${signal}); restarting in ${RESTART_DELAY_MS / 1000} s`);
    setTimeout(start, RESTART_DELAY_MS);
  });
}

function watch(match: Watcher['match'], onChange: Watcher['onChange']): () => void {
  const watcher: Watcher = { match, onChange, debounce: null };
  watchers.add(watcher);
  start();
  return () => {
    if (watcher.debounce) clearTimeout(watcher.debounce);
    watchers.delete(watcher);
    if (watchers.size === 0) {
      proc?.kill();
      proc = null;
    }
  };
}

/** A Stream Deck's HID device added or removed. */
export function watchHotplug(onChange: (action: HotplugAction, devpath: string) => void): () => void {
  return watch(
    (e) => e.subsystem === 'hidraw' && e.action !== 'change' && VENDOR_IN_PATH.test(e.devpath),
    (e) => onChange(e.action, e.devpath),
  );
}

/** A screen connected or disconnected, or an evdev node (a touchscreen, perhaps) added or removed: for virtual decks. */
export function watchScreensAndTouch(onChange: (action: HotplugAction, devpath: string) => void): () => void {
  return watch(
    (e) => (e.subsystem === 'drm' && /\/card\d+$/.test(e.devpath)) || (e.subsystem === 'input' && e.action !== 'change' && /\/event\d+$/.test(e.devpath)),
    (e) => onChange(e.action, e.devpath),
  );
}
