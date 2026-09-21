# Architecture

Why Deckhand is shaped the way it is. This is a page of decisions and their
reasons, not a tour of the code. Several of them look wrong until you know
what they were measured against, so read this before proposing a change to
one.

## Where it came from

Deckhand was built to replace StreamController, the closest thing to Elgato's
own software on Linux, after months of it being unreliable: severe UI lag,
failures that came and went, restarts that only sometimes helped. OpenDeck's
interface did not work for the maintainer either. The bar is **works
reliably**, not feature parity with Elgato.

Two hypotheses shaped the design. Neither was ever proven about
StreamController itself: much of that unreliability came from running
sandboxed (portals, D-Bus reach, USB access); and the rest came from one
process doing device I/O, rendering and UI on a single loop. Everything below
keeps those two things out of the path between a key press and a keystroke.

## The pieces

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

- **The daemon** (`src/`) owns the decks. It reads the config, draws the keys,
  runs the actions, and keeps audio and media state. It runs as a
  `systemd --user` service, as **plain Node, not inside Electron**. The daemon
  depends on native modules (`node-hid`, `sharp`), which would have to be
  rebuilt against Electron's ABI on every Electron update. The component that
  has to just work does not take that risk. A release carries its own Node for
  the daemon, as it carries its own Electron for the editor.
- **The input helper** (`helper/deckhand-input.c`, about 250 lines, no
  dependencies beyond libc and the kernel headers) is a resident process that
  owns one `uinput` virtual keyboard. It receives **numeric keycodes only** on
  stdin. Every human-readable key name lives in `src/keymap.ts`, so the C file
  does not change as key coverage grows. Its timing constants are floors,
  measured against real applications, not tuning knobs.
- **The editor** (`editor/`) is **strictly a config producer**. It writes
  `config.json` and talks to the daemon over the socket to learn deck
  geometry and state, preview keys and switch pages. It cannot start, stop or
  restart the daemon. A hung or crashed editor cannot stall a key press, and
  closing it changes nothing on the decks.
- **The `deckhand` command** is a thin client over the same socket. It is how
  a game's launch script or a desktop keyboard shortcut switches profiles.

## Decisions

**Keys are injected at the evdev layer, through `uinput`.** To the rest of
the system the virtual keyboard simply *is* a keyboard: the compositor and
every application receive its keys exactly as they receive a physical
keyboard's. No compositor API or permission is involved, so there is nothing
to grant and nothing that a compositor update can break. It works in games,
including games under Wine.

- **Not ydotool.** It was ruled out from experience with it.
- **Not xdg-desktop-portal**, for hotkeys or anything else. A portal puts a
  permission prompt and a compositor API between a key press and the
  application.
  Its absence is the point of the architecture.

**No per-app automatic profile switching.** It is the one feature that would
need a compositor-specific backend (a KWin script, and something else for
every other desktop). Profiles switch when you ask: a key on a deck, the
editor, or `deckhand profile <name>` from a launch script. A script switching
profiles is not automatic switching.

**Not a Flatpak.** Every capability the daemon exists to provide is either
impossible inside the sandbox or needs a hole that removes the sandbox's
point:

- there is no known way for a Flatpak to install udev rules;
- `/dev/uinput` and the decks' `hidraw` nodes need `--device=all`, which
  exposes every device on the machine;
- audio needs a PulseAudio socket hole, and media control needs D-Bus holes;
- there is no known way for it to install a host `systemd --user` unit, and
  autostarting through the background portal would bring a portal back.

A sandboxed daemon would also bring back the variable Deckhand was built to
remove. The editor only produces config, so it could be sandboxed later.

**Config is keyed by device serial, never by USB path.** A USB path changes
when a deck moves to another port or hub; the serial follows the deck. The
cost: a replaced deck is a new deck, and its layouts have to be moved to the
new serial by hand (see the README).

**The daemon owns all device knowledge, and hardcodes none of it.** Key count,
icon size and layout come from the Stream Deck library's control descriptions
at runtime. There is no per-model table and no guessed default. The editor
learns each deck's geometry from the daemon, so a model it has never heard of
draws correctly.

**Config reaches the daemon one way: `config.json` and its hot reload.** The
daemon never writes that file, except once to create a starter config on a
machine that has none. The editor is its only other writer, by temp file and
rename. A config that fails validation is refused, and the last good one stays
in use. Rolling backups (the newest 20) live in the state directory,
`~/.local/state/deckhand/backups/`, not next to the config, which people sync
or keep in dotfiles.

**Cost scales with what is on screen, not with what is in the config.** A page
of static hotkeys costs nothing at rest: no timers, no subprocesses, no USB
traffic. A live key (clock, now-playing, mic state) costs something only
while it is visible. Identical images are never rewritten to USB. "No timers
at rest" is a structural rule, not "no measurable cost", which would weaken as
hardware gets faster. Two recurring timers are accepted exceptions:

- a 60-second device scan, as insurance against a missed udev event;
- a 500 ms render tick per deck, which has no measurable cost.

Everything else is started by an event.

**Nothing may leave a key held.** A latched key or a pending release is let go
by every way off a page: a page switch, a profile switch, a layout change, an
unplugged deck, or a restarted helper. A key held down at the evdev layer with
nobody pressing it is the worst failure a keyboard can have.

**Icons are file paths.** The config holds a path to an image wherever it
already is, and nothing is ever copied or imported. Built-in icons are
referred to by name (`builtin:<name>`), never by a path into the install
directory, which is replaced on every update. An action with no icon set
draws its built-in default. That default is never written to the config.

**Audio follows one rule: you pick from the devices the system reports, and
Deckhand applies no logic to the list.** It does not categorise, rank or guess.
Network sinks are the one category left out, identified by the flag `pactl`
reports rather than by name.

## The control socket

Newline-delimited JSON over a stream socket at
`$XDG_RUNTIME_DIR/deckhand.sock`, mode `0600`. Clients send requests and get
replies, and can subscribe to `state`, `config` and `audio` events.

- **Nothing in the daemon waits on a client.** A slow reader is disconnected
  rather than buffered without limit.
- **Keystrokes sent over the socket run one at a time, daemon-wide.** They
  share the helper's queue with physical key presses, so a script flooding
  the socket cannot delay a press on the deck.
- **Keys held by a socket action are released when it finishes.**
- **The editor's previews are cleared when its connection closes**, so a
  crashed editor cannot leave a key showing something unsaved.

## Installation

Per user, under the XDG directories: the app in `~/.local/share/deckhand`, a
`systemd --user` unit, and the `deckhand` and `deckhand-editor` commands in
`~/.local/bin`. The only piece that needs root is a udev rule granting the
logged-in user access to the decks and to `/dev/uinput`. Uninstalling always
removes that rule, because it lets any of the user's processes synthesise
keystrokes.

**One install script, not a package per distribution.** `scripts/install.sh`
checks what a machine needs and names everything missing at once, and rolls
back if the new copy does not stay up. It installs two ways, sharing
everything after the app directory is staged:

- **A release** (what end users get): the script attached to a GitHub release
  downloads that release's prebuilt package, checks it against the release's
  `SHA256SUMS`, and proves its binaries load on the machine before touching
  anything installed. Nothing is compiled there, so a user needs no Node,
  npm or compiler. `scripts/release.sh` builds releases only from a clean,
  annotated tag, from `git archive` of it, so a release contains nothing that
  is not in a commit. The one binary Deckhand compiles, the input helper, is
  compiled on AlmaLinux 8 (glibc 2.28); every other native file is an upstream
  prebuild. Then every binary in the package is read, and the release is
  refused if any needs a newer glibc or libstdc++ than the floor — a failure on
  the maintainer's machine instead of a stranger's. Before publishing, the
  package is loaded in containers of the distributions it claims, installed
  the way a user installs it, and the tests are run against that install.
- **A developer install**: from a clean git checkout, built on the machine,
  so what runs can always be traced to a commit. Where the kernel
restricts unprivileged user namespaces (Ubuntu 24.04 and later), it adds an
AppArmor profile for the editor's own Electron rather than a setuid sandbox
helper. A setuid binary under a home directory silently does nothing on a
`nosuid` mount.
