#!/usr/bin/env node
/**
 * udevadm for tests (DECKHAND_UDEVADM; src/services/hotplug.ts): `monitor`
 * stays up and says nothing, so a test never hears this machine's real device
 * events — a USB device plugged or unplugged during a run, or the GPU's drm
 * change events every few seconds, made checks counting rescans fail by
 * timing alone. FAKE_UDEVADM_LOG, if set, gets one line per start: the
 * arguments. Anything but `monitor` exits 0 and prints nothing.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_UDEVADM_LOG) fs.appendFileSync(process.env.FAKE_UDEVADM_LOG, args.join(' ') + '\n');
if (args[0] !== 'monitor') process.exit(0);
// Up until stopped, as the real monitor is; silent.
setInterval(() => {}, 1 << 30);
