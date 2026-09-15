/**
 * One-time conversion of config.json from the v0.1 format (pages directly
 * under each deck) to the v0.2 format (profiles above decks, docs/scope.md §5).
 *
 *   npm run build:ts
 *   node scripts/migrate-config.mjs            convert ~/.config/deckhand/config.json
 *   node scripts/migrate-config.mjs --dry-run  print the result, write nothing
 *
 * DECKHAND_CONFIG_DIR picks another config directory, the same as the daemon.
 *
 * What it does:
 *   - Every deck becomes a layout in one profile, "default" (named "Default"),
 *     which is also startProfile.
 *   - "name" and "brightness" stay under "decks"; "startPage" and "pages" move
 *     into the layout. Page keys are kept as page IDs, so an existing
 *     { "type": "page", "to": "games" } still resolves. Buttons are not touched.
 *   - The original is kept as config.v0.1.json next to it. If that file already
 *     exists, nothing is written.
 *   - The new file is checked by the daemon's own validation before it is
 *     written, and written to a temporary file then renamed into place.
 *
 * It refuses — writing nothing — if the config is already v0.2, is not v0.1,
 * or has keys it does not know how to move. Those need a human to look.
 *
 * Run it with the service stopped: the new daemon refuses a v0.1 config and
 * the old daemon cannot read a v0.2 one.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_PATH, validateConfig } from '../dist/config.js';

const BACKUP_PATH = path.join(CONFIG_DIR, 'config.v0.1.json');
const PROFILE_ID = 'default';
const KNOWN_TOP_LEVEL = new Set(['defaults', 'decks']);
const KNOWN_DECK_KEYS = new Set(['name', 'brightness', 'startPage', 'pages']);

function fail(message) {
  console.error(`migrate-config: ${message}`);
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

let raw;
try {
  raw = await fs.readFile(CONFIG_PATH, 'utf8');
} catch (err) {
  fail(`cannot read ${CONFIG_PATH}: ${err.message}`);
}

let old;
try {
  old = JSON.parse(raw);
} catch (err) {
  fail(`${CONFIG_PATH} is not valid JSON, so there is nothing safe to convert: ${err.message}`);
}

if (old && typeof old === 'object' && 'profiles' in old) {
  console.log(`migrate-config: ${CONFIG_PATH} already has "profiles" — nothing to do.`);
  process.exit(0);
}
if (!old || typeof old !== 'object' || typeof old.decks !== 'object' || old.decks === null) {
  fail(`${CONFIG_PATH} does not look like a v0.1 config (no "decks" object).`);
}

const unknownTop = Object.keys(old).filter((key) => !KNOWN_TOP_LEVEL.has(key));
if (unknownTop.length > 0) {
  fail(`unexpected top-level keys ${JSON.stringify(unknownTop)} — not converting.`);
}

const decks = {};
const layouts = {};
for (const [serial, deck] of Object.entries(old.decks)) {
  if (typeof deck !== 'object' || deck === null) fail(`deck "${serial}" is not an object — not converting.`);
  const unknown = Object.keys(deck).filter((key) => !KNOWN_DECK_KEYS.has(key));
  if (unknown.length > 0) {
    fail(`deck "${serial}" has unexpected keys ${JSON.stringify(unknown)} — not converting.`);
  }

  const hardware = {};
  if (deck.name !== undefined) hardware.name = deck.name;
  if (deck.brightness !== undefined) hardware.brightness = deck.brightness;
  decks[serial] = hardware;

  const layout = {};
  if (deck.startPage !== undefined) layout.startPage = deck.startPage;
  layout.pages = structuredClone(deck.pages);
  layouts[serial] = layout;
}

const next = {};
if (old.defaults !== undefined) next.defaults = structuredClone(old.defaults);
next.decks = decks;
next.profiles = { [PROFILE_ID]: { name: 'Default', layouts } };
next.startProfile = PROFILE_ID;

// The daemon's own validation, so the file written is one it will load.
try {
  validateConfig(structuredClone(next));
} catch (err) {
  fail(`the converted config does not validate, so nothing was written: ${err.message}`);
}

// Everything a deck showed must have come across unchanged, key order included.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!same(old.defaults, next.defaults)) fail('internal check failed: "defaults" changed.');
for (const [serial, deck] of Object.entries(old.decks)) {
  const layout = next.profiles[PROFILE_ID].layouts[serial];
  if (!same(deck.pages, layout.pages)) fail(`internal check failed: pages for deck "${serial}" changed.`);
  if (deck.startPage !== layout.startPage) fail(`internal check failed: startPage for deck "${serial}" changed.`);
  if (deck.name !== next.decks[serial].name || deck.brightness !== next.decks[serial].brightness) {
    fail(`internal check failed: hardware settings for deck "${serial}" changed.`);
  }
}

const output = JSON.stringify(next, null, 2) + '\n';

if (dryRun) {
  process.stdout.write(output);
  console.error('migrate-config: --dry-run, nothing written.');
  process.exit(0);
}

// Backup first, with 'wx' so an earlier backup is never overwritten.
try {
  await fs.writeFile(BACKUP_PATH, raw, { flag: 'wx' });
} catch (err) {
  if (err.code === 'EEXIST') {
    fail(`${BACKUP_PATH} already exists. Move it aside first; nothing was written.`);
  }
  fail(`cannot write backup ${BACKUP_PATH}: ${err.message}; nothing was written.`);
}

const tempPath = path.join(CONFIG_DIR, `.config.json.migrate-${process.pid}`);
try {
  await fs.writeFile(tempPath, output, { flag: 'wx' });
  await fs.rename(tempPath, CONFIG_PATH);
} catch (err) {
  await fs.rm(tempPath, { force: true });
  fail(`cannot write ${CONFIG_PATH}: ${err.message}. The original is unchanged; the backup is at ${BACKUP_PATH}.`);
}

const deckCount = Object.keys(layouts).length;
console.log(`migrate-config: converted ${CONFIG_PATH}`);
console.log(`  ${deckCount} deck(s) moved into profile "${PROFILE_ID}"; buttons unchanged.`);
console.log(`  original kept at ${BACKUP_PATH}`);
console.log('');
console.log('If the updated daemon does not start, or scripts/install.sh rolls back to the old one,');
console.log('the old daemon cannot read this file. Put the original back with:');
console.log(`  cp ${BACKUP_PATH} ${CONFIG_PATH}`);
console.log('  systemctl --user restart deckhand');
