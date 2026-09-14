import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { CORSAIR_VENDOR_ID, VENDOR_ID } from '@elgato-stream-deck/node';

/**
 * Stream Deck hotplug. node-hid has no hotplug event, so this runs
 * `udevadm monitor` as a child process and reports when a hidraw device from a
 * Stream Deck vendor is added or removed. The daemon then rescans at once,
 * instead of finding out at the next poll.
 *
 * udevadm prints one line per event, for example
 *
 *   UDEV  [12345.678901] add      /devices/.../0003:0FD9:006C.0009/hidraw/hidraw8 (hidraw)
 *
 * The HID device's name in that path carries the USB vendor id, so matching
 * the vendor needs no extra lookups. Vendor ids come from the Stream Deck
 * library rather than being written out here.
 *
 * If udevadm is missing or keeps dying, nothing breaks: the daemon still has
 * its slow safety-net poll.
 */

export type HotplugAction = 'add' | 'remove';

function hex4(id: number): string {
  return id.toString(16).toUpperCase().padStart(4, '0');
}

const VENDOR_IN_PATH = new RegExp(`:(${[VENDOR_ID, CORSAIR_VENDOR_ID].map(hex4).join('|')}):`, 'i');
const EVENT_LINE = /^UDEV\s+\[[^\]]*\]\s+(add|remove)\s+(\S+)/;

/** Several devices appear per plug-in; they become one rescan this long after the last. */
const DEBOUNCE_MS = 500;
const RESTART_DELAY_MS = 5000;

export function watchHotplug(onChange: (action: HotplugAction, devpath: string) => void): () => void {
  let stopped = false;
  let proc: ChildProcess | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let lastEvent: { action: HotplugAction; devpath: string } | null = null;

  const start = () => {
    if (stopped) return;
    let failed = false;

    proc = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=hidraw'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        const match = EVENT_LINE.exec(line);
        if (!match || !VENDOR_IN_PATH.test(match[2])) return;
        lastEvent = { action: match[1] as HotplugAction, devpath: match[2] };
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (lastEvent && !stopped) onChange(lastEvent.action, lastEvent.devpath);
        }, DEBOUNCE_MS);
      });
    }

    proc.on('error', (err) => {
      // Typically udevadm not installed. Don't retry; the safety-net poll covers it.
      failed = true;
      console.error(`[hotplug] cannot run udevadm monitor (${err.message}); relying on the slow device poll`);
    });

    proc.on('exit', (code, signal) => {
      proc = null;
      if (stopped || failed) return;
      console.error(`[hotplug] udevadm monitor exited (code=${code} signal=${signal}); restarting in ${RESTART_DELAY_MS / 1000} s`);
      setTimeout(start, RESTART_DELAY_MS);
    });
  };

  start();

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    proc?.kill();
  };
}
