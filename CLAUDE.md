# Deckhand

A Stream Deck daemon and editor for Linux. What it is and how to install it:
`README.md`. Why it is shaped the way it is: **`ARCHITECTURE.md` — read it
before proposing anything.** Several of its decisions look wrong until you know
what they were measured against, and you will be tempted to re-suggest a thing
that was already tried and rejected.

---

## Hard rules

These are not preferences.

1. **Never propose ydotool.** Key injection goes through the resident C helper
   (`helper/deckhand-input.c`) owning a `uinput` virtual keyboard.
2. **Never propose xdg-desktop-portal**, for hotkeys or anything else.
   Injecting at the evdev layer means there is no portal in the picture at all.
   Avoiding the portal is the entire point of the architecture.
3. **Never propose per-app profile auto-switching.** It is the one feature
   that needs a compositor-specific backend (a KWin script). Deferred, and out
   of scope until the maintainer raises it.
4. **Justify features by use, not by hypothetical users.** Making Deckhand
   install and run on other machines is a goal; "other users will want this"
   is still not a reason to add a feature.
5. **Never install from a dirty checkout.** `scripts/install.sh update`
   refuses one so that what runs on the decks can be traced to a commit.
   `--dirty` is not the way around that: commit first, or ask.

## Verification discipline

Code written here is maintained by one person who is not a full-time
developer, so a confident wrong answer costs more than an honest uncertain one.

- **Compile and run what you write.** Do not describe code as working because
  it looks correct. The C helper must build under `gcc -O2 -Wall -Wextra`.
  TypeScript must pass `tsc --noEmit` against the actually-installed libraries,
  not against remembered API shapes.
- **Read `node_modules` rather than recalling an API.** This has already caught
  real things — `CONTROLS` carrying `row`/`column`, `getFirmwareVersion()`
  existing, `dbus-next` supporting `NameOwnerChanged`.
- **Say what is verified, and how.** Keep "checked against reality" (name the
  method: compiled, ran the check, read the installed source, seen on the
  decks) apart from "my reasoning, not checked". That distinction matters more
  than anything else you report. Do not blur it to sound more certain.
- **Estimates are estimates.** If you say "about six lines" and it turns out to
  be forty, say so rather than quietly building it.
- **Push back.** If a request conflicts with a decision, an earlier
  measurement, or reality, say so plainly and give the reasoning. Agreeing with
  something wrong is worse than an argument.
- **Real hardware does not make a thing verified.** A key landing in a text
  field says nothing about a game under Wine, and `pactl` output describes
  whatever audio devices are attached today, not a permanent list. When a
  check needs someone's eyes or hands — pressing a deck key, watching a game —
  say exactly what to do and what to report back.

## Testing

Offline testing, which should still be preferred over guessing: `npm run
smoke` drives fake decks, and `scripts/smoke-socket.mjs` (part of it) drives the
control socket over a real socket with `scripts/test/fake-input-helper.mjs`
(the helper's protocol and timing, no uinput) and `scripts/test/fake-pactl.mjs`
on `PATH` (with `FAKE_PACTL_STATE` it remembers presses, mutes and absent
devices), and `scripts/test/fake-mpris-player.mjs` puts a fake player on a
private bus (`scripts/smoke-mpris.mjs` re-runs itself under `dbus-run-session`).
`scripts/test/no-decks.mjs` and `scripts/test/fake-decks.mjs` give a child
process no decks, or a set of decks a test can plug and unplug while the daemon
runs. These have found defects before any hardware was touched more than once.

**When a test passes first time, break the code on purpose and check it
fails.** That has caught weak checks many times. **Before its failures mean
anything, run the break runner on unbroken source and see it pass** — not as
caution, as the step. A runner that cannot resolve the test's imports, or
builds the wrong file, prints nothing and exits non-zero, and "no failures"
then reads exactly like a passing break. A break runner is itself untested
code.

The checks, all offline. Root: `npm run smoke`. In `editor/`: `npm test`, and
`npm run check:shared`, `check:bridge`, `check:live`, `check:hotkey`,
`check:icons`, `check:panes`, `check:structure`, `check:navigate`,
`check:bulk`, `check:forms`, `check:tray`, `check:settings`, `check:titlebar`,
`check:failures`, `check:backup`, `check:empty` — real Electron against a test
harness for the control socket. `bash scripts/test/desktop-entry.test.sh`
tests the installer's desktop entry and icon against a scratch HOME;
`bash scripts/test/preflight.test.sh` its preflight against stub commands;
`bash scripts/test/apparmor-profile.test.sh` its AppArmor profile;
`bash scripts/test/upgrade.test.sh` its `upgrade` against a local origin;
`bash scripts/test/uninstaller.test.sh` the `deckhand-uninstall` it leaves;
`bash scripts/test/pipe.test.sh` the script piped into bash, as `curl … | bash`
runs it, with a terminal and without one.
`bash scripts/test/release-install.test.sh` a release's download, checksum
and unpack against a fake package, every way it can be wrong.
`bash scripts/test/release-glibc.test.sh` the release build's glibc check,
which refuses a package with any binary newer than the floor.
`bash scripts/test/release-ships.sh <version>` tests a built release before it
is published — loads it in containers of the target distributions, pipes its
installer, **installs it on this machine**, and runs the suites against that
install.
`scripts/install.sh check` runs the preflight for real and changes nothing.

For looking rather than checking: `node editor/scripts/screenshot.mjs --out
x.png` renders the editor to a PNG, and `node editor/scripts/empty-state.mjs
--state <name>` opens a real editor window in any of the five states of
"nothing to show" (`daemon-down`, `never-configured`, `all-unplugged`,
`no-layout`, `deck-unplugged`), plus `normal` as the control case, against a
scratch config, state directory and socket — so those states can be seen
without unplugging a deck. Ctrl-C to finish: it closes to the tray like the
installed one. `node editor/scripts/demo.mjs` opens the real editor on an
invented setup — fake decks, layout, audio devices, player, icon folders and
bookmarks, under its own `HOME` and a private session bus — for the README's
screenshots; nothing in it is anyone's real configuration. Ctrl-C to finish.

Traps in the checks themselves, each hit more than once:

- **Judge a run by its exit code, never by the tail of its output.** Editor
  `npm test` runs several files; the last one printing "all checks passed" has
  hidden failures in an earlier one. And **run `tsc` first**: it emits output
  despite type errors, so a green smoke run after a failed `tsc` proves nothing.
- **After a deliberate break, rebuild before the next clean run.** A break
  runner that restores the source leaves `dist/` built from the break, so the
  next check tests broken code. A break that fails to build is not a pass
  either.
- **An `async` function passed to a synchronous `check()` can never fail the
  run.** The helper gets a Promise back and prints PASS; the assertions run
  later, detached. Either make the helper `async` and `await` the function, or
  keep the check body synchronous.
- **A hidden check window has no focus, and React listens for `focusout`.**
  `focus()` and `blur()` on an element dispatch nothing there, so a check that
  drives a field's "saves when you leave it" path with them tests nothing.
  Dispatch `focusin` / `focusout` instead.
- **Hidden windows deliver no `ResizeObserver` callbacks, never finish lazy
  `<img>` loads, and cache icon URLs.** A check that depends on any of them
  passes or fails for the wrong reason.
- **Editor checks must never touch an installed daemon or the real session
  bus.** They point `DECKHAND_SOCKET`, `DECKHAND_CONFIG_DIR` and
  `DECKHAND_STATE_DIR` at scratch paths. Electron's startup asks the session
  bus for the desktop portal, starting services that outlive the run, which is
  why `screenshot.mjs` uses a bus config with no service directories.

## Environment traps

- **A shell inside VS Code has `ELECTRON_RUN_AS_NODE=1`**, which makes the
  Electron binary plain Node with no `BrowserWindow`. `npm start` and
  `editor/scripts/lib/run-electron-check.mjs` clear it; any new way of
  launching Electron must too.
- **On a machine that restricts user namespaces, a green editor check says
  nothing about whether the editor starts there.** Ubuntu 24.04+ sets
  `kernel.apparmor_restrict_unprivileged_userns = 1`, and Electron aborts
  without a namespace (`FATAL:setuid_sandbox_host.cc:166`). **But a shell
  inside VS Code carries VS Code's AppArmor profile, which grants one** — so
  `npm start` and every `check:*` pass there while the same command from a
  plain terminal, or from the user manager, fails. Check
  `/proc/<pid>/attr/current` before believing any Electron launch on such a
  machine, or run it through `systemd-run --user --wait --collect --pipe` to
  get an unconfined one. The installed editor is covered by
  `apparmor/deckhand-editor`; **the checkout's `editor/node_modules/electron`
  deliberately is not**, so development on such a machine does not work and is
  not meant to.
- **Never pipe the daemon's output into `head`** (or anything that exits
  early). When the reader goes away, the next `console.log` throws `EPIPE`,
  the `uncaughtException` handler in `src/index.ts` logs it to the same broken
  pipe, and it recurses: 100% of a core, and `SIGTERM` will not stop it
  because `shutdown()` starts with a `console.log`. It looks exactly like a
  spin bug in the daemon and is not one. Redirect to a file and read that.
  Under systemd stdout is the journal, so this cannot happen to the installed
  service.

## Architecture in brief

```
deckhand daemon (Node, systemd --user)  ──stdin/keycodes──▶  deckhand-input (C)
   │                                                            │
   │ USB HID                                                    ▼
   ▼                                                    uinput virtual kbd
Stream Decks                                                    │
   ▲                                                            ▼
   │ unix socket ◀── deckhand CLI, editor                  evdev ──▶ games
editor (Electron/React) — config producer only
```

The daemon is plain Node, not inside Electron; the editor cannot restart or
control it; the daemon owns all device knowledge and the editor hardcodes
nothing about any Stream Deck model. The reasons are in `ARCHITECTURE.md`.

**The design rule: cost scales with what is on screen, not with what is in the
config.** A page of static hotkeys costs nothing at rest: no timers, no
subprocesses, no USB traffic. A live button (clock, now-playing, mic state)
costs something only while visible. "No timers at rest" is structural and
stays as written — not "no measurable cost", which would weaken as hardware
gets faster.

The recurring timers that run at rest today, so the rule is never broken
silently (keep this list, and `ARCHITECTURE.md`, in step with the code):

- **Exception:** the 60 s safety-net device poll (`SAFETY_SCAN_INTERVAL_MS`,
  `src/index.ts`) — insurance against a missed udev event.
- **Exception:** the 500 ms render tick (`TICK_MS`, `src/deck.ts`), one per
  deck — no measured cost, so no justification to remove it.
- The only `setInterval` calls in `src/` are those two — check with grep
  before adding one. MPRIS players are discovered from `NameOwnerChanged`, not
  a rescan.
- **Not a recurring timer, noted so a grep does not mislead:** after the
  session bus is lost, `src/services/mpris.ts` retries once with a single
  2 s `setTimeout`; further retries ride the 60 s safety-net scan. Nothing
  runs while the bus is fine.

Any new recurring timer is a breach until the maintainer accepts it.

## Running it while developing

- **The daemon runs as an installed `systemd --user` service** from
  `~/.local/share/deckhand`, put there by `scripts/install.sh`. **It does not
  run from the checkout.** Code changes reach it only through
  `scripts/install.sh update`, which refuses a dirty checkout and rolls back
  if the new copy does not stay up. `systemctl --user start|stop|status
  deckhand`; logs with `journalctl --user -u deckhand -f`. **Do not run `npm
  start` while the service is up** — two daemons fight over the decks.
- **The editor is installed with the daemon**, in
  `~/.local/share/deckhand/editor/` with its own Electron, launched by
  `~/.local/bin/deckhand-editor`. It sits in the tray when closed. It is its
  own package in `editor/`, with its own `package.json`. For development it
  runs from the checkout: `cd editor && npm start`. **Quit the installed
  editor from its tray menu first**: both use the same state directory and so
  the same single-instance lock.
- **Config reaches the daemon one way: `config.json` and its hot reload.** The
  daemon never writes that file (bar the first-run bootstrap); the editor is
  its only other writer, by temp file and rename. Nothing the daemon writes
  ever goes next to it.

## Before touching

Each of these looks arbitrary and is not.

| Before touching | The invariant |
| --- | --- |
| `helper/deckhand-input.c` | combo timing (`TAP_DELAY_US`, `COMBO_GAP_US`, …) is a tested floor, not a tuning knob |
| `src/control/` | nothing may block or await a client; socket actions are serialised daemon-wide |
| `src/services/audio.ts`, any audio `describe()` | key faces read a cache; spawning `pactl` from a render feeds itself |
| `src/render.ts`, `src/builtin-icons.ts` | built-ins are resolved by name; a default is never written to `config.json`, and a chosen built-in is written as `builtin:<name>`, never as a path into the app directory |
| `src/default-icons.ts` | pure so the editor can import it; an icon not drawn yet maps to no default, never to `missing`. `BUILTIN_ICONS` = `assets/icons/`, held by `scripts/smoke-defaults.mjs` |
| `src/deck.ts`'s `heldRelease` / `latched`, or anything that changes the page, profile, layout or connection | **nothing may leave a key held at the evdev layer** — every path off a page fires pending releases and releases latches |
| `src/key-failures.ts`, `DeckSession.dispatch()` | a failed key clears only on a successful press or an edit — never a timer or a page switch; marks cost nothing at rest and notify only on change |
| `src/failed-badge.ts` | the one drawing of the failed-key badge, shared by the deck and the editor's grid; import-free so the editor can import it |
| `src/services/mpris.ts`, any media `describe()` / `iconState()` | key faces read the player state cache; no D-Bus call in a render |
| `src/index.ts`'s `scan()` / `unattached` / `reevaluateUnattached` | a deck with no layout is left alone until a **reload** re-evaluates it; skipping `unattached` unconditionally strands a deck that has just been given one, until it is replugged |
| `editor/src/renderer/model.ts`'s `emptyState()` / `connectionPill()` | the **order** is the content: "nothing is connected at all" is tested before anything per-deck, and before the layout, or one deck gets named while every deck is missing; both use the same order so the card and the pill cannot disagree |
| `followDeck()` | it must **reconcile first, then follow the deck it settled on** — following the previous serial misses the deck's real page whenever the selection named no deck, which is every time the window opens before the daemon has reported |
| `deckChoices()` / `knownDecks()` / `deckOptions()` | **a deck that is not plugged in is not listed, anywhere.** The editor's device lists derive from the first two, and Settings' Default deck list (`deckOptions()`, `editor/src/shared/settings.ts`) follows the same rule separately. The *stored* default may still name an absent deck. Accepted cost: unplugging the deck being edited moves the editor off it |
| the config watcher, or anything written near `config.json` | it is safe only because it is non-recursive and filters on the file name |
| a toggle's or any other paired icon field | one list, `PAIR_ICON_FIELDS`, held by `editor/test/pair-icons.test.ts` |
| `src/actions/system.ts`'s `launch()`, or anything that starts a program from a deck | **nothing launched from a deck may be the daemon's child.** It goes through `launch()` (`systemd-run --user --scope`); a plain or detached spawn stays in `deckhand.service`'s cgroup, and every stop of the service — each update, a crash restart, logging out — kills it. Not `KillMode=process`: that leaves the helper, `pactl subscribe` and `udevadm monitor` behind |

## Style

Boring and legible beats clever — one person maintains this, long after the
session that wrote it. Prefer explicit over concise. Keep human-readable key
naming in `src/keymap.ts` so the C helper never has to change.
