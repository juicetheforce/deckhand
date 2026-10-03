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

- a 60-second device scan (`SAFETY_SCAN_INTERVAL_MS`, `src/index.ts`), as
  insurance against a missed udev event;
- a 500 ms render tick per deck (`TICK_MS`, `src/deck.ts`), which has no
  measurable cost.

Everything else is started by an event. Those two are the only `setInterval`
calls in `src/`; check with grep before adding one, and a new recurring timer
needs a reason good enough to join this list. Media players are discovered
from D-Bus's `NameOwnerChanged`, not by rescanning. One `setTimeout` a grep
will find is not a recurring timer: after the session bus is lost,
`src/services/mpris.ts` retries once, 2 s later, and further retries ride the
60-second scan. **OBS is connected only while a page a deck shows has an OBS
key**, or a press is waiting on it; if OBS is not running, the next try rides
the same 60-second scan — it has no timer of its own. The `setTimeout`s in
`src/services/obs-client.ts` are one-shot deadlines for a handshake or a
request, not recurring timers. **VTube Studio is connected the same way** —
only while a shown page has a VTS key, retries riding the 60-second scan.
VTS also announces itself over UDP every few seconds; **that broadcast is
listened to only inside Settings' Connect**, for a few seconds when the
connection fails, to say why — never at rest.

**Secrets live in one owner-only file, never in the config.** Credentials for
the services Deckhand is a client of — OBS's WebSocket password, VTube
Studio's token — are kept in
`~/.local/state/deckhand/credentials.json`, mode 0600, outside the config
directory people sync, and outside everything that copies the config: an
export bundles `config.json` and its icons, and the rolling backups copy
`config.json`. The control socket sets them and reports only whether one is
set. Not the desktop keyring: that is a different backend on every desktop,
can be locked when the daemon starts at login, and does not separate one
user's programs from each other — Deckhand's udev rule already lets any of
them type keystrokes. OBS's WebSocket server listens on every network
interface with its password as the only protection, so that password should
be a strong one.

**VTube Studio is asked for access only when you click Connect.** VTS gives
a plugin a token when the person allows it in a window inside VTS; Deckhand
asks for one from Settings' Connect and nowhere else — no key, scan or
reconnect does — so that window never appears by itself in the middle of
someone's stream. A token VTS has since revoked is refused, as a wrong OBS
password is, and never retried until Connect. **The name and developer
Deckhand gives VTS — "Deckhand" and "Open-source contributors" — are
permanent**: VTS refuses a saved token if either changes, so changing them
would silently disconnect everyone. Its window shows them as a title over a
subtitle, naming no person.

**VTube Studio is reached by a WebSocket client of Deckhand's own**
(`src/services/text-socket.ts`), not Node's built-in one. VTS's server
compresses its messages, and Node's client (undici, as Node 24.18 bundles it)
decodes the first compressed message and gives every later one as an empty
string; it cannot be told not to ask for compression. Deckhand's client asks
for none. OBS still uses Node's client, which works only because
obs-websocket does not compress — if a future OBS does, its keys would fail
the same way, and the fix is this client.

**A key that needs you to do something says so on the desktop.** Every
failed press is badged on its key. A failure whose message tells the person
what to do — hold Stream to stop it, start OBS, nothing is recording — is
also sent as a desktop notification through `org.freedesktop.Notifications`
on the session bus: the ordinary notification service, not a portal. Once
per message, one per key: a key's next notification closes its last one and
shows a new one, rather than stacking — and rather than replacing it in
place, which KDE Plasma does without showing anything once the old one has
timed out, so a key's second failure went unseen. So the desktop's history
keeps one per key too, the latest. Each names Deckhand's desktop entry, so
the desktop files it under Deckhand, history included. Every notification
shown is logged. Nothing is connected until the first one. Turned off with
`"notifications": false` in `config.json` (the editor's Settings), because the
daemon is what sends them.

**Nothing may leave a key held.** A latched key or a pending release is let go
by every way off a page: a page switch, a profile switch, a layout change, an
unplugged deck, or a restarted helper. A key held down at the evdev layer with
nobody pressing it is the worst failure a keyboard can have.

**Icons are file paths.** The config holds a path to an image wherever it
already is, and nothing is ever copied or imported. Built-in icons are
referred to by name (`builtin:<name>`), never by a path into the install
directory, which is replaced on every update. An action with no icon set
draws its built-in default. That default is never written to the config.
An app key with no icon draws its app's own icon, found through the
desktop's icon theme when the key is drawn — the daemon does that lookup
itself, having neither GTK nor Qt — and never written to the config either.

**Audio follows one rule: you pick from the devices the system reports, and
Deckhand applies no logic to the list.** It does not categorise, rank or guess.
Network sinks are the one category left out, identified by the flag `pactl`
reports rather than by name.

**Nothing launched from a deck is the daemon's child.** The service runs
under systemd's default `KillMode=control-group`, which kills everything left
in the service's cgroup when it stops — every update, a crash restart,
logging out. A program started as the daemon's child, even detached, stays in
that cgroup, so an update would close every app launched from a deck. Programs
are started through `launch()` (`src/actions/system.ts`), which runs them with
`systemd-run --user --scope`, each in a scope of its own; an app key hands
its desktop entry to `gio launch` the same way. `KillMode=process`
on the unit would also fix it, and would leave the input helper,
`pactl subscribe` and `udevadm monitor` running after every stop.

## Invariants — before changing the code

Each of these looks arbitrary and is not. Most are held by a test; the reason
is here so the test is not "fixed" instead.

| Before touching | The invariant |
| --- | --- |
| `helper/deckhand-input.c` | combo timing (`TAP_DELAY_US`, `COMBO_GAP_US`, …) is a tested floor, not a tuning knob |
| `src/control/` | nothing may block or await a client; socket actions are serialised daemon-wide |
| `src/services/audio.ts`, any audio `describe()` | key faces read a cache; spawning `pactl` from a render feeds itself |
| `src/render.ts`, `src/builtin-icons.ts` | built-ins are resolved by name; a default is never written to `config.json`, and a chosen built-in is written as `builtin:<name>`, never as a path into the app directory |
| `src/default-icons.ts` | pure so the editor can import it; an icon not drawn yet maps to no default, never to `missing`. `BUILTIN_ICONS` = `assets/icons/`, held by `scripts/smoke-defaults.mjs` |
| `src/deck.ts`'s `heldRelease` / `latched`, or anything that changes the page, profile, layout or connection | **nothing may leave a key held at the evdev layer** — every path off a page fires pending releases and releases latches |
| `src/key-failures.ts`, `DeckSession.dispatch()` | a failed key clears only on a successful press, an edit, or the person's **Clear** in the editor (`failure.clear`) — never a timer or a page switch; a cleared key that fails again is marked again; marks cost nothing at rest and notify only on change |
| `src/failed-badge.ts` | the one drawing of the failed-key badge, shared by the deck and the editor's grid; import-free so the editor can import it |
| `src/services/mpris.ts`, any media `describe()` / `iconState()` | key faces read the player state cache; no D-Bus call in a render |
| `src/index.ts`'s `scan()` / `unattached` / `reevaluateUnattached` | a deck with no layout is left alone until a **reload** re-evaluates it; skipping `unattached` unconditionally strands a deck that has just been given one, until it is replugged |
| `editor/src/renderer/model.ts`'s `emptyState()` / `connectionPill()` | the **order** is the content: "nothing is connected at all" is tested before anything per-deck, and before the layout, or one deck gets named while every deck is missing; both use the same order so the card and the pill cannot disagree |
| `followDeck()` | it must **reconcile first, then follow the deck it settled on** — following the previous serial misses the deck's real page whenever the selection named no deck, which is every time the window opens before the daemon has reported. With several decks shown, each other deck then follows its own page, only while it shows the selection's profile — a page id can exist in two profiles |
| `Selection.others`, `keyUnder()`, anything drawing several decks | **with one deck connected the editor is exactly the one-deck editor** — held by `check:one-deck`, run before every commit by `scripts/hooks/pre-commit`. Each shown deck's page is held once: the focused deck's in `page`, every other's in `others`. A key is found by deck **and** index — an index alone names a key on every grid, and a key drag would swap on the wrong deck |
| `editor/src/renderer/canvas.ts`, `DeckCanvas.tsx` | **positions are key units at each grid's top-left**, in the editor preferences by serial, never `config.json`, so they mean the same at any zoom or window size. **A drop saves every shown deck as drawn**, not only the one moved — a deck never dragged would otherwise be placed afresh below the lowest on the next opening. Decks never overlap: a drop onto one is butted against the edge of it the pointer is nearest, not the side it came from, so a held deck follows the pointer. **Zoom changes only when the person asks**, and Fit all runs only on opening and when the shown decks change — never on a resize |
| `deckChoices()` / `knownDecks()` / `deckOptions()` | **a deck that is not plugged in is not listed, anywhere.** The editor's device lists derive from the first two, and Settings' Default deck list (`deckOptions()`, `editor/src/shared/settings.ts`) follows the same rule separately. The *stored* default may still name an absent deck. Accepted cost: unplugging the deck being edited moves the editor off it |
| `src/services/apps.ts`, `src/services/icon-theme.ts`, an action's `defaultIcon()` | an app's icon is resolved when drawn and **never written to `config.json`**; every answer is cached, and nothing watches the disk — the socket's `apps` command, which the editor's app list asks, is the one thing that forgets and re-reads |
| the config watcher, or anything written near `config.json` | it is safe only because it is non-recursive and filters on the file name |
| a toggle's or any other paired icon field | one list, `PAIR_ICON_FIELDS`, held by `editor/test/pair-icons.test.ts` |
| `src/credentials.ts`, or anything that stores a password or token | **a secret is never in `config.json`, an export or a backup**, and the control socket never returns one — only whether it is set. The file is written 0600 by temp file and rename |
| `src/services/obs.ts`, any OBS `describe()` / `iconState()` | **connected only while a shown page has an OBS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; a refused password is never retried until the credentials change; **not set up — no saved connection — never connects at all**, and set up means saved, not "has a password" or "has connected once"; key faces read the state cache, fed by OBS's events, never a request in a render. **What shown keys name — Mute keys' inputs, Source keys' scene items — is asked once, when first shown, then kept by events; never polled**, and forgotten when no shown key names it |
| `src/actions/obs.ts`'s Stream key, `DeckSession`'s `holds` | **Stream starts on a press and stops only on a hold** — accidentally ending a stream is the worst thing it can do. A hold is two timestamps, not a timer; a press that started the stream cannot stop it, and a hold is dropped on every way off the page. **The release decides a hold's mark when the press armed one** (`execute` resolved `'armed'`): that press succeeding does not clear it (or every short press would flicker the badge and notify again), and a release with nothing to do leaves the press's own failure in place. A press that started the stream is judged by itself. **A start is shown, and succeeds, only once OBS says STARTED**: OBS sends STARTING and then nothing for a start that fails at once, so Stream and Record wait for STARTED or STOPPED (one-shot, `START_CONFIRM_MS`), mark the key otherwise, and correct the cached state |
| `src/action-error.ts`, `DeckSession.settle()`, `src/services/notifications.ts` | **only a failure whose message tells the person what to do (`ActionNeeded`) is notified**, and only when the key's mark is newly set or its message changes — never per press; `"notifications": false` is read at the moment of the failure, so a reload counts. **A press of a key whose integration is not set up (`NotSetUp`) is never marked** — its face says so, and a mark would outlast the setup — and is notified once daemon-wide until the setup changes |
| `src/services/vts.ts`, any VTS `describe()` / `iconState()` | **connected only while a shown page has a VTS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; **only `requestAccess` (Settings' Connect) ever asks VTS for a token**; a revoked token is refused and never retried until Connect; **not set up — no saved token — never connects at all**; the broadcast is listened to only inside Connect, never at rest; key faces read the state cache, fed by VTS's events, never a request in a render |
| `src/services/vts-client.ts`'s `PLUGIN_NAME` / `PLUGIN_DEVELOPER` | **permanent**: VTS refuses a saved token given for another name or developer, so a change disconnects every user without a word |
| `src/services/text-socket.ts` | offers **no WebSocket extension**: VTS's server compresses whatever a client accepts, and Node's own client misreads it. Messages arrive in 1016-byte fragments and are put back together |
| `src/actions/system.ts`'s `launch()`, or anything that starts a program from a deck | **nothing launched from a deck may be the daemon's child.** It goes through `launch()` (`systemd-run --user --scope`); a plain or detached spawn stays in `deckhand.service`'s cgroup, and every stop of the service — each update, a crash restart, logging out — kills it. Not `KillMode=process`: that leaves the helper, `pactl subscribe` and `udevadm monitor` behind |

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
