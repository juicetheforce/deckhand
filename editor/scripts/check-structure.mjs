// M4 phase B, B1: profiles and pages, end to end in real Electron against two
// fake decks. The four things the maintainer checks on the real decks are checked here
// first: opening switches nothing, a profile moves both decks, a page change
// from elsewhere moves the breadcrumb, and closing changes nothing.
//
// Two decks is the point. check:live has one, and one deck cannot show the
// difference between "the profile switched this deck" and "the profile
// switched every deck it covers".
//
// Usage: npm run check:structure   (builds first)

import assert from 'node:assert/strict';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-structure-'));
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);
process.env.DECKHAND_CONFIG_DIR = configDir;
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, reloadLikeTheDaemon } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const A = 'STRUCT-XL';
const B = 'STRUCT-V2';
// A deck in config that no profile but "Doomed" covers, so deleting that
// profile has to give it a layout rather than leave it dark (M5).
const C = 'STRUCT-SPARE';
// "Second" holds a key that navigates to Main, so deleting it has something to clear.
const CONFIG = {
  decks: { [A]: { name: 'Big deck' }, [B]: { name: 'Little deck' }, [C]: { name: 'Spare deck' } },
  startProfile: 'default',
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [A]: {
          startPage: 'main',
          pages: {
            main: { name: 'Main', buttons: { 0: { label: 'To second', action: { type: 'page', to: 'second' } } } },
            second: { name: 'Second', buttons: { 1: { label: 'Home', action: { type: 'page', to: 'Main' } } } },
            // Hand-written links by name, for the renames (M5): they must follow.
            third: { name: 'Third', buttons: { 2: { label: 'Back to main', action: { type: 'page', to: 'Main' } } } },
            // A key that switches to the profile deleted below, by name (M5).
            fourth: { name: 'Fourth', buttons: { 3: { label: 'To Doomed', action: { type: 'profile', to: 'Doomed' } }, 4: { action: { type: 'page', to: 'main' } } } },
          },
        },
        [B]: { startPage: 'main', pages: { main: { name: 'Main', buttons: {} } } },
      },
    },
    other: {
      name: 'Other',
      layouts: {
        [A]: {
          startPage: 'hotbar',
          pages: {
            hotbar: { name: 'Hotbar', buttons: { 3: { label: 'Default', action: { type: 'profile', to: 'Default' } } } },
            // Its only way off is a switch to the profile deleted below (M5).
            raid: { name: 'Raid', buttons: { 5: { action: { type: 'profile', to: 'doomed' } } } },
          },
        },
        [B]: { startPage: 'hotbar', pages: { hotbar: { name: 'Hotbar', buttons: { 4: { action: { type: 'profile', to: 'default' } } } } } },
      },
    },
    doomed: {
      name: 'Doomed',
      layouts: {
        [A]: { startPage: 'dm', pages: { dm: { name: 'Doom', buttons: {} } } },
        [C]: { startPage: 'cm', pages: { cm: { name: 'Spare', buttons: {} } } },
      },
    },
  },
};
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n');

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(A, new FakeDeck());
await daemon.attach(B, new FakeDeck());

// Reload as src/index.ts does (the harness's reloadLikeTheDaemon).
const stopWatching = await reloadLikeTheDaemon(daemon);

// Before the editor starts: put deck A somewhere that is NOT its start page,
// so "opens on what the decks show" means something.
await daemon.sessions.get(A).goToPage('second');
const openedWith = { a: daemon.sessions.get(A).currentPage(), b: daemon.sessions.get(B).currentPage() };

// Stand in for a deck press: when the renderer signals with a preview on key 0, move deck A to Main.
let pressed = false;
const presser = setInterval(() => {
  const session = daemon.sessions.get(A);
  if (!pressed && session.previewKeys().includes(0)) {
    pressed = true;
    void session.goToPage('main');
  }
}, 25);

const output = await runElectronCheck('structure', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 90_000);
clearInterval(presser);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});

if (r && !r.error) {
  check('opening the editor switches nothing, and opens on what the decks show', () => {
    assert.equal(openedWith.a, 'second', 'the deck was not moved before the editor started');
    assert.equal(r.opensOn.tab, 'Second', 'the breadcrumb did not open on the page the deck was showing');
    assert.equal(r.opensOn.profile, 'default');
    const a = r.opensOn.decks.find((d) => d.serial === A);
    const b = r.opensOn.decks.find((d) => d.serial === B);
    assert.equal(a.page, 'second', 'opening moved deck A');
    assert.equal(b.page, openedWith.b, 'opening moved deck B');
  });

  check('the new-profile control offers every deck, connected ones ticked', () => {
    assert.deepEqual(r.ticksShown, ['Big deck', 'Little deck', 'Spare deck — not connected'], 'names come from config');
    assert.deepEqual(r.ticksCheckedByDefault, [true, true, false], 'connected decks start ticked, and only those');
  });

  check('creating a profile covering both decks switches BOTH of them', () => {
    assert.equal(r.bothDecksSwitched, true, 'both decks did not move to the new profile');
    const ids = new Set(r.afterCreate.map((d) => d.profile));
    assert.equal(ids.size, 1, `the decks landed on different profiles: ${[...ids].join(', ')}`);
    assert.match([...ids][0], /^prof_[0-9a-f]{4}$/);
    assert.equal(r.profileAfterCreate, [...ids][0], 'the breadcrumb is not on the profile it created');
  });

  check('switching back returns both decks, each to its own start page', () => {
    assert.equal(r.bothDecksReturned, true);
  });

  check('when a deck moves by itself, the breadcrumb follows', () => {
    assert.equal(r.onSecond, true, 'the deck was not on Second first, so following proves nothing');
    assert.equal(r.tabBeforePress, 'Second');
    assert.equal(pressed, true, 'the stand-in press never happened');
    assert.equal(r.followsDeck, true);
  });

  check('deleting a page names the key that navigates to it, and clears it', () => {
    assert.match(String(r.confirmText), /1 key navigates here/);
    assert.match(String(r.confirmText), /Main · key 1/, 'the confirmation did not name the key');
    assert.equal(r.pageGone, true, 'the tab is still there');
  });
}

const finalText = await fs.readFile(path.join(configDir, 'config.json'), 'utf8');
const finalConfig = JSON.parse(finalText);

check('the saved config has the new profile, covering both decks with one page each', () => {
  const created = Object.entries(finalConfig.profiles).find(([id]) => id.startsWith('prof_'));
  assert.ok(created, 'no new profile was saved');
  const [, profile] = created;
  assert.equal(profile.name, 'Hardware test');
  assert.deepEqual(Object.keys(profile.layouts).sort(), [A, B].sort(), 'it does not cover both decks');
  for (const [serial, layout] of Object.entries(profile.layouts)) {
    const pages = Object.keys(layout.pages);
    assert.equal(pages.length, 1, `${serial} has ${pages.length} pages`);
    assert.equal(layout.startPage, pages[0], `${serial} startPage`);
    assert.deepEqual(layout.pages[pages[0]], { name: 'Main', buttons: {} });
  }
});

check('the deleted page is gone, and the key that pointed at it kept its label but lost the action', () => {
  const layout = finalConfig.profiles.default.layouts[A];
  assert.equal(layout.pages.second, undefined, 'the page is still in the file');
  assert.deepEqual(layout.pages.main.buttons['0'], { label: 'To second' }, 'the pointing key was not cleared cleanly');
  assert.equal(layout.startPage, 'main', 'startPage should not have needed to move');
});

check('rename is a visible pencil for profile, device and page, with no note and no right-click', () => {
  assert.deepEqual(
    r?.pencils?.map((l) => l.replace(/"[^"]*"/, '"…"')),
    ['Rename profile "…"', 'Rename "…"', 'Rename page "…"'],
    'expected one pencil each for profile, device and the selected page',
  );
  assert.deepEqual(r?.profileMenuOnRightClick, ['Delete profile…'], 'the Profile dropdown right-click should offer Delete alone: rename is the pencil');
  assert.equal(r?.profileFieldStartsWith, 'Default');
  assert.equal(r?.profileRenameExtras, '', 'something besides the field is shown while renaming a profile');
  assert.equal(r?.profileClashError, 'there is already a profile called "Other"');
  assert.equal(r?.profileRenamed, true, 'the dropdown never showed the new name, or the field stayed open');
  assert.equal(r?.profileStillShown, 'default', 'renaming moved the breadcrumb to another profile');
  assert.deepEqual(r?.pagePencils, ['Rename page "Main"'], 'a page pencil should be on the selected tab only');
  assert.deepEqual(r?.tabMenu, ['Delete page…'], 'the tab menu should hold Delete only');
});

check('the renamed profile: name links follow it, ID links are untouched, the daemon accepted the file', () => {
  assert.equal(finalConfig.profiles.default.name, 'Home');
  assert.deepEqual(finalConfig.profiles.other.layouts[A].pages.hotbar.buttons['3'], { label: 'Default', action: { type: 'profile', to: 'Home' } }, 'the name link did not follow (the label is not a link and stays)');
  assert.deepEqual(finalConfig.profiles.other.layouts[B].pages.hotbar.buttons['4'].action, { type: 'profile', to: 'default' }, 'an ID link was rewritten');
  assert.equal(finalConfig.startProfile, 'default', 'startProfile by ID was rewritten');
  assert.equal(daemon.profiles.profileName('default'), 'Home', 'the daemon never loaded the renamed profile');
});

check('the renamed page: a name link on another page follows it', () => {
  assert.equal(r?.pageRenamed, true, 'the tab never showed the new name');
  const layout = finalConfig.profiles.default.layouts[A];
  assert.equal(layout.pages.main.name, 'Start');
  assert.deepEqual(layout.pages.third.buttons['2'].action, { type: 'page', to: 'Start' });
  assert.equal(layout.startPage, 'main', 'startPage by ID was rewritten');
});

check('deleting a profile names what it changes, and Cancel changes nothing', () => {
  assert.deepEqual(r?.profileMenu, ['Delete profile…'], 'the Profile dropdown should offer Delete only');
  const text = String(r?.deleteProfileText);
  assert.match(text, /Delete\s*“Doomed”/, 'the confirmation does not name the profile');
  assert.deepEqual(
    r?.deleteProfileLinks,
    ['Home · Big deck · Fourth · key 4', 'Other · Big deck · Raid · key 6'],
    'the keys losing their switch are not named, by profile, deck, page and key',
  );
  assert.match(text, /“Spare deck” is in no other profile, so it gets an empty page in “Home”/, 'the uncovered deck is not named');
  assert.match(text, /1 page will have no key that leaves it/, 'the page left with no way off is not named');
  assert.equal(r?.deleteProfileLists, 2, 'the keys and the stranded pages should be two lists');
  assert.match(text, /Other · Big deck · Raid/, 'the stranded page is not named');
  assert.doesNotMatch(text, /Hotbar/, 'a page that already had no way off should not be reported as newly stranded');
  assert.equal(r?.cancelledProfileDelete, true, 'Cancel closed onto a different profile, or left the card open');
});

check('the profile is deleted, the configuration is kept first, and the decks do not go dark', () => {
  assert.match(String(r?.profileDeletedText), /“Doomed” is deleted/);
  assert.match(String(r?.profileDeletedText), /kept at .*before-delete-.*\.json/, 'the card does not say where the copy went');
  assert.deepEqual(r?.profilesAfterDelete, ['Home', 'Other', 'Hardware test'], 'the deleted profile is still in the dropdown');
  assert.equal(finalConfig.profiles.doomed, undefined, 'the profile is still in the file');
  // The key that switched to it by name: label kept, switch gone.
  assert.deepEqual(finalConfig.profiles.default.layouts[A].pages.fourth.buttons['3'], { label: 'To Doomed' });
  assert.deepEqual(finalConfig.profiles.other.layouts[A].pages.raid.buttons, {}, 'the ID link was not cleared');
  // The deck only Doomed covered gets a layout in the start profile.
  const spare = finalConfig.profiles[finalConfig.startProfile ?? 'default'].layouts[C];
  assert.ok(spare, 'the spare deck is in no profile: it would go dark');
  assert.deepEqual(Object.values(spare.pages), [{ name: 'Main', buttons: {} }]);
  assert.equal(finalConfig.startProfile, 'default', 'startProfile moved when it did not have to');
});

check('the configuration from before the delete is kept where the card says, and still holds the profile', () => {
  const dir = path.join(scratch, 'state', 'backups');
  const kept = readdirSync(dir).filter((f) => f.startsWith('before-delete-'));
  assert.equal(kept.length, 1, `expected one kept copy in ${dir}, found ${JSON.stringify(readdirSync(dir))}`);
  const before = JSON.parse(readFileSync(path.join(dir, kept[0]), 'utf8'));
  assert.ok(before.profiles.doomed, 'the kept copy does not hold the deleted profile');
  assert.ok(before.profiles.default.layouts[A].pages.fourth.buttons['3'].action, 'the kept copy is missing the key that was cleared');
});

check('closing the editor left both decks where they were, not on the start profile', () => {
  assert.equal(r?.leftOnOther, true);
  assert.equal(daemon.profiles.activeProfile(), 'other');
  assert.equal(daemon.sessions.get(A).currentPage(), 'hotbar');
  assert.equal(daemon.sessions.get(B).currentPage(), 'hotbar', 'deck B did not follow the profile switch');
});

stopWatching();
await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
if (failures > 0) console.log(`\nrenderer report:\n${JSON.stringify(r, null, 2)}`);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
