// M4 phase A, step 4: the hotkey inspector end to end in real Electron.
//
// The renderer drives the inspector through the UI (src/renderer/checks.ts,
// "hotkey"). A fake busctl on PATH answers KDE's shortcut lookup: ctrl+f1 is a
// KWin shortcut, nothing else is. Afterwards this script checks the saved
// config.json against exactly the changes the UI made.
//
// Usage: npm run check:hotkey   (builds first)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runElectronCheck } from './lib/run-electron-check.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..');
process.env.DECKHAND_INPUT_BIN = path.join(repoRoot, 'scripts/test/fake-input-helper.mjs');
const { FakeDeck, startDaemon, scratchDir } = await import(pathToFileURL(path.join(repoRoot, 'scripts/test/control-harness.mjs')).href);

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

const scratch = await scratchDir();
const configDir = path.join(scratch, 'config');
await fs.mkdir(configDir);

// A fake busctl: ctrl+f1 (Qt ControlModifier | Key_F1) is KWin's; everything else is unbound.
const bin = path.join(scratch, 'bin');
await fs.mkdir(bin);
const CTRL_F1 = 0x04000000 | 0x01000030;
await fs.writeFile(
  path.join(bin, 'busctl'),
  `#!${process.execPath}
const code = Number(process.argv[process.argv.length - 1]);
const hit = code === ${CTRL_F1} ? [['Switch to Desktop 1', 'Switch to Desktop 1', 'kwin', 'KWin', 'default', 'Default Context', [code], [code]]] : [];
process.stdout.write(JSON.stringify({ type: 'a(ssssssaiai)', data: [hit] }));
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

const SERIAL = 'HOTKEY-XL';
const BUTTONS = {
  '0': { label: 'Media', action: { type: 'media.control', method: 'next' } },
  '1': { action: { type: 'hotkey', keys: ['ctrl+c', 'ctrl+v'] } },
  '2': { label: 'Keep', icon: '~/Pictures/icons/ffxiv.png' },
};
const CONFIG = { profiles: { default: { name: 'Default', layouts: { [SERIAL]: { pages: { main: { name: 'Main', buttons: BUTTONS } } } } } } };
const original = JSON.stringify(CONFIG, null, 2) + '\n';
await fs.writeFile(path.join(configDir, 'config.json'), original);

const daemon = await startDaemon(scratch, CONFIG);
await daemon.attach(SERIAL, new FakeDeck());

const output = await runElectronCheck('hotkey', { configDir, stateDir: path.join(scratch, 'state'), socket: daemon.socket }, 90_000);
const r = output.report?.renderer;

check('electron ran the check', () => {
  assert.equal(output.code, 0, `exit code ${output.code}\nstderr:\n${output.stderr}`);
  assert.ok(r, `no report\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  assert.equal(r.error, undefined, r.error);
});
if (r && !r.error) {
  check('recording: listening shown, held Ctrl shown, ctrl+1 saved, and the key events swallowed', () => {
    assert.deepEqual([r.listeningShown, r.heldShown, r.recorded, r.swallowed], [true, true, true, true]);
  });
  check('Cancel stops listening and changes nothing; Esc is recorded as a hotkey (and swallowed)', () => {
    assert.deepEqual([r.cancelChangesNothing, r.escRecorded, r.escSwallowed], [true, true, true]);
  });
  check('a KDE shortcut asks first, with the generic wording and the component', () => {
    assert.equal(r.confirmShown, true);
    assert.equal(r.confirmText, 'Ctrl+F1 is a system shortcut (KWin). Use it anyway?');
  });
  check('"Choose another" saves nothing; "Use it anyway" saves; the saved key keeps the warning', () => {
    assert.deepEqual([r.chooseAnotherSavedNothing, r.useAnywaySaved, r.savedWarningShown], [true, true, true]);
  });
  check('Type manually refuses "ctrl++" with the reason, saves "Control + F13" as ctrl+f13, with the layout note', () => {
    assert.match(String(r.typedRefusal), /missing between/);
    assert.deepEqual([r.typedSaved, r.remapNoteShown], [true, true]);
  });
  check('a key with no name says so', () => assert.equal(r.unknownKeyMessage, true));
  check('label saves; Clear hotkey keeps the label', () => assert.deepEqual([r.labelSaved, r.clearHotkeyKeepsLabel], [true, true]));
  check("the library's Hotkey entry starts listening", () => assert.equal(r.libraryStartsListening, true));
  check('leaving the Key tab stops listening — a key there is neither swallowed nor recorded — and coming back does not listen again; the library still starts it', () => {
    assert.deepEqual([r.iconTabNotSwallowed, r.iconTabNotRecorded, r.backOnKeyTabNotListening, r.libraryListensAgain], [true, true, true, true]);
  });
  check('media and sequence keys are read-only; the media key label still saves', () => {
    assert.deepEqual([r.mediaReadOnly, r.mediaLabelSaved, r.sequenceReadOnly], [true, true, true]);
  });
  check('Clear button removes the whole key', () => assert.equal(r.clearButtonRemoves, true));
}

const saved = await fs.readFile(path.join(configDir, 'config.json'), 'utf8');
const expected = structuredClone(CONFIG);
const b = expected.profiles.default.layouts[SERIAL].pages.main.buttons;
b['0'].label = 'Next track';
delete b['2'];
b['3'] = { label: 'Bolt' };
check('config.json holds exactly the changes the UI made, in the editor format', () => {
  assert.equal(saved, JSON.stringify(expected, null, 2) + '\n');
  assert.deepEqual(JSON.parse(saved).profiles.default.layouts[SERIAL].pages.main.buttons['1'], BUTTONS['1'], 'the sequence key was touched');
});

await daemon.stop();
await fs.rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
