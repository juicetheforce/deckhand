#!/usr/bin/env node
/**
 * A stand-in for gsettings, for offline tests: answers
 * `gsettings get org.gnome.desktop.interface icon-theme` with
 * FAKE_ICON_THEME, quoted as the real one quotes it, so a test never reads
 * the machine's own settings.
 */
const args = process.argv.slice(2).join(' ');
if (args === 'get org.gnome.desktop.interface icon-theme' && process.env.FAKE_ICON_THEME) {
  console.log(`'${process.env.FAKE_ICON_THEME}'`);
} else {
  process.exit(1);
}
