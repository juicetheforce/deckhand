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
   │   │                                                        │
   │   │ USB HID                                                ▼
   │   ▼                                                uinput virtual kbd
   │  Stream Decks                                              │
   │                                                            ▼
   │ pipes: images ▶ ◀ touches                             evdev ──▶ games
   ▼
deckhand-panel (C), one per virtual deck ──▶ Wayland surface on its screen
   ▲
   └── touchscreen (evdev, grabbed)

unix socket ◀── deckhand CLI, editor
editor (Electron/React) — config producer only
```

- **The daemon** (`src/`) owns the decks. It reads the config, draws the keys,
  runs the actions, and keeps audio and media state. It runs as a
  `systemd --user` service, as **plain Node, not inside Electron**. The daemon
  depends on native modules (`node-hid`, `sharp`), which would have to be
  rebuilt against Electron's ABI on every Electron update. The component that
  has to just work does not take that risk. A release carries its own Node for
  the daemon, as it carries its own Electron for the editor.
- **The display helper** (`panel/`, C, linking only libc and
  `libwayland-client`) shows a virtual deck: a touchscreen used as a deck.
  One runs per connected virtual deck's screen, started by the daemon, and
  talks to it over its own pipes, never the socket. It composes the images
  the daemon renders onto a surface on that screen, and reads the paired
  touchscreen directly, grabbed, passing touches back. It knows nothing of
  keys or shapes: the daemon decides which key a touch lands on.
- **The input helper** (`helper/deckhand-input.c`, about 250 lines, no
  dependencies beyond libc and the kernel headers) is a resident process that
  owns one `uinput` virtual keyboard. It receives **numeric keycodes only** on
  stdin. Every human-readable key name lives in `src/keymap.ts`, so the C file
  does not change as key coverage grows. Its timing constants are floors,
  measured against real applications, not tuning knobs.
- **The editor** (`editor/`) is **strictly a config producer**. It writes
  `config.json` and talks to the daemon over the socket to learn deck
  geometry and state, preview keys and switch pages. It cannot start, stop or
  restart the daemon. When a touchscreen is paired as a virtual deck, or one
  is removed, it also runs Deckhand's root helper through `pkexec`, which
  asks for the password (below) — the editor, because the polkit prompt
  belongs to the desktop session, and the daemon is outside it. **Once each time its window opens**, unless Settings ›
  About's "Check for updates" is off, it asks GitHub for the latest release,
  to say when a newer one exists; it downloads and installs nothing, and the
  daemon never asks. A hung or crashed editor cannot stall a key press, and
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
new serial by hand (see the README). A virtual deck is keyed the same way by
its screen (below).

**The daemon owns all device knowledge, and hardcodes none of it.** Key count,
icon size and layout come from the Stream Deck library's control descriptions
at runtime. There is no per-model table and no guessed default. Only a key the library says has a screen is drawn, at that screen's own size — not every model's keys are square (a Studio's are 144×112), and some keys have none (a Neo's touch keys, every Pedal key); `smoke-models` drives every model the installed library knows through the library's own checks. The editor
learns each deck's geometry from the daemon, so a model it has never heard of
draws correctly.

**A virtual deck is Deckhand doing for a touchscreen what it does for a
Stream Deck.** Above one seam the daemon never asks which kind of deck it
has: each driver — the Stream Deck library, and virtual decks — hands it
devices with controls that have an ID, a position, a size and a shape, and a
Stream Deck's grid is one such layout. Keys are named by control ID, never
by index, so a moved or resized key keeps its button. A panel's controls
live in each profile's layout, so one screen can show different layouts in
different profiles.

- **The screen is drawn on a Wayland layer-shell surface on the `overlay`
  layer** that never takes keyboard focus, on the chosen output; where the
  compositor has no layer-shell (GNOME), a fullscreen window on it. Two
  standard protocols and one fallback: no per-desktop code, and no portal.
- **Touch is read from the touchscreen directly and grabbed**, below the
  compositor, so the desktop never sees it and nothing depends on which
  display the desktop thinks the touchscreen belongs to — which KDE Plasma
  got wrong on both machines tried, until it was set by hand.
- **Only a touchscreen paired as a virtual deck is readable, and only from
  the moment of pairing.** Wayland keeps programs from reading each other's
  input; a udev rule giving the user access to a touchscreen opts that device
  out of the protection, so any program the user runs could read its touches
  — on a touchscreen laptop, what is typed on its on-screen keyboard. So the
  install adds no touchscreen rule. Pairing asks for the password once, through
  `pkexec`: a small root helper, installed root-owned in `/usr/local/libexec`,
  gives temporary read access to the touchscreens while the daemon waits for
  the tap, then writes a rule for the touchscreen tapped alone (its vendor
  and product IDs, and its serial when it has one) and drops the temporary
  access. Removing the deck removes its entry and its access (the password
  again); uninstalling removes them all. A touchscreen with no serial is
  covered by model, so identical ones share an entry.
- **That access is a file ACL for the user who paired the touchscreen, not
  the `uaccess` tag**, so it belongs to that user rather than to whoever is
  at the seat. udev keeps a device's tags until it is unplugged or the
  machine restarts, and its seat rule re-grants `uaccess` access on every
  re-trigger of a device that ever had the tag — measured: a touchscreen
  granted that way got its access back the moment it was taken away. A
  rule that runs `setfacl` for one user on one device has nothing sticky:
  removing it is deleting the rule and the ACL, with no re-trigger, and
  neither change nor add events bring it back (measured on the panel and
  the laptop's own touchscreen). Read access only: writing to an input
  device can inject events into it. One rule file per user.
- **The daemon hit-tests**, not the helper, in a module the editor shares,
  so shapes never reach C. A touch belongs to the key it started on until it
  lifts, as a held Stream Deck key does.
- **A screen is recognised by its EDID**: maker and product, and its text
  serial number when it has one — never the numeric serial field, which many
  screens fill with a placeholder. Identical screens are told apart by the
  connector each was set up on. **Nothing links a touch controller to its
  screen**, so setup asks for one tap; the pairing is remembered by the
  touch device's USB serial, or by its USB IDs and port when it has none.
- **No touch runs an action while the session is locked or not the active
  one**, as logind's `LockedHint` and `Active` say, followed by their change
  signals; if they cannot be read, touches are refused. Reading the device
  directly bypasses the lock screen, so this rule is what stands in for it.
- **Discovery costs nothing at rest**: screens from `/sys/class/drm`,
  touchscreens from udev's database, changes from the `udevadm monitor` the
  daemon already runs. A display change that alters no screen Deckhand
  cares about does not rescan. A helper runs only while a virtual deck's
  screen is connected, and does nothing until the daemon sends it an image.
- **Whether the screen is plugged in is the kernel's to say; whether the
  panel can be shown is the compositor's.** KWin removes a screen's output
  when it wakes from power saving and adds it back a moment later, with
  nothing in the kernel's view changing. So the helper outlives its output:
  it waits for an output of the same name to be announced, then shows the
  panel again, and the daemon quits it only when the kernel says the screen
  is gone. A helper that stops by itself closes its deck.

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
while it is visible. Identical images are never rewritten to USB. **A key whose face changes only on events is redrawn only then** (`redraw: 'events'` on its action): OBS, VTube Studio and Twitch keys are drawn when shown and again when their service announces a change or the key's own state does, never on the 500 ms tick's clock — before, each was redrawn every second for nothing. The tick's clock is for faces that depend on time, like a clock. "No timers
at rest" is a structural rule, not "no measurable cost", which would weaken as
hardware gets faster. Three recurring timers are accepted exceptions:

- a 60-second device scan (`SAFETY_SCAN_INTERVAL_MS`, `src/index.ts`), as
  insurance against a missed udev event;
- a 500 ms render tick per deck (`TICK_MS`, `src/deck.ts`), which has no
  measurable cost;
- **an hourly Twitch check, only while a Twitch account is linked**
  (`CHECK_EVERY_MS`, `src/services/twitch.ts`). Twitch requires every app
  that keeps a session to validate its token at start and hourly, so the
  integration cannot work without it: a requirement, not a feature's
  convenience. It also refreshes the access token before it lapses, which
  keeps the link alive. It stops when the link is removed.

Everything else is started by an event. Those three are the only `setInterval`
calls in `src/`; check with grep before adding one, and a new recurring timer
needs a reason good enough to join this list. Media players are discovered
from D-Bus's `NameOwnerChanged`, not by rescanning. One `setTimeout` a grep
will find is not a recurring timer: after the session bus is lost,
`src/services/mpris.ts` retries once, 2 s later, and further retries ride the
60-second scan. **OBS is connected only while a page a deck shows has an OBS
key**, or a press is waiting on it; if OBS is not running, the next try rides
the same 60-second scan — it has no timer of its own. The `setTimeout`s in
`src/services/obs-client.ts` are one-shot deadlines for a handshake or a
request, not recurring timers. **Pairing a virtual deck's
touchscreen** waits for a tap with a one-shot 30-second deadline, and its
root helper drops its temporary access after at most 5 minutes, only while
someone is pairing. **While a Twitch account is being
linked**, the daemon asks Twitch every few seconds whether the person has
approved — the only way to learn it — until they do, the code expires, they
cancel, or the client that started it closes; never at rest. **VTube Studio
is connected the same way** —
only while a shown page has a VTS key, retries riding the 60-second scan.
VTS also announces itself over UDP every few seconds; **that broadcast is
listened to only inside Settings' Connect**, for a few seconds when the
connection fails, to say why — never at rest. What an expression key shows
is asked of VTS when the key comes into view, on a model load and after an
expression hotkey, never polled; a Model key's press waits for VTS to say
the model has loaded, a one-shot deadline like OBS's.

**Secrets live in one owner-only file, never in the config.** Credentials for
the services Deckhand is a client of — OBS's WebSocket password, VTube
Studio's token, Twitch's tokens — are kept in
`~/.local/state/deckhand/credentials.json`, mode 0600, outside the config
directory people sync, and outside everything that copies the config: an
export bundles `config.json` and its icons, and the rolling backups copy
`config.json`. The control socket sets them and reports only whether one is
set. Not the desktop keyring: that is a different backend on every desktop,
can be locked when the daemon starts at login, and does not separate one
user's programs from each other — Deckhand's udev rule already lets any of
them type keystrokes. OBS's WebSocket server listens on every network
interface with its password as the only protection, so that password should
be a strong one. Twitch's tokens are the first credential for a service on
the internet: anything that can read the file can act as the linked
account on Twitch, within what the link allows, from anywhere, until the
link is removed.

**Twitch is actions only.** A Twitch key's press is one request to
Twitch's API as the linked account, on its own channel; no face shows
anything live from Twitch, and nothing is connected. Stream state comes
from OBS.

**Twitch is linked by device code, with one public client ID for
everyone.** Deckhand is registered with Twitch as a *public* client, so it
needs no secret — which an open-source app cannot keep — and nobody has to
register a developer app of their own. The person approves Deckhand at
twitch.tv/activate with the code Settings shows; the daemon asks Twitch
whether they have, at the interval Twitch gives, until they do, the code
expires, or they cancel. Twitch lists the app as "Deckhand App". The client
ID is the project's, owned by an account that exists only to own it; if it
were ever revoked, every link would stop at once, so `config.json`'s
`twitch.clientId` lets someone link with their own public app without
waiting for a release. A saved link keeps the client ID it was made with.

**A Twitch refresh token is used once, and never twice.** Twitch replaces
the refresh token on every refresh, and **ends the whole link if a
replaced one is ever sent** (measured). So one refresh runs at a time,
shared by the hourly check and every press, and the new pair is written —
in one write — before anything uses it. Public clients' refresh tokens
lapse 30 days after they were issued; the hourly check refreshes ahead of
the access token's expiry, so a link stays alive while Deckhand runs, and
lapses only after 30 days without it. **A refused refresh keeps the link**:
a fault on Twitch's side has looked exactly like a dead link, so the keys
are marked and the person told, but the tokens are kept and the hourly
check keeps trying; only Remove or a new link clears them. Remove revokes
the refresh token, which ends the link at Twitch too.

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
on the session bus: the ordinary notification service, not a portal.
**Every failed press notifies, and each key keeps one notification**: a
repeat within 10 seconds says how many times on that one — updated in place
while its popup is still up, and closed and shown anew once the popup has
gone, because KDE Plasma updates a notification whose popup has timed out
without showing anything (its popups last about 5 seconds; it says when one
closes, and Deckhand listens). Clearing a key's mark starts the count again.
So the desktop's history keeps one per key, the latest. Each names Deckhand's desktop entry, so
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
| `editor/src/main/one-at-a-time.ts`, `main.ts`'s `deckAction` | **the editor's own deck actions — a page shown, a profile made active, a Test Run — run one at a time**, each whole. The daemon refuses a second socket action with `busy` rather than queue it, so two page tabs clicked quickly lost the second click, and the first's success hid the error |
| `src/services/audio.ts`, any audio `describe()` | key faces read a cache; spawning `pactl` from a render feeds itself |
| `src/render.ts`, `src/builtin-icons.ts` | built-ins are resolved by name; a default is never written to `config.json`, and a chosen built-in is written as `builtin:<name>`, never as a path into the app directory |
| `src/icon-file.ts`, anything that reads an icon path (the renderer, the editor's icon protocol, the export) | **an icon path is checked before it is read**: a regular file (a device or FIFO never finishes reading), at most 10 MB, **never in Deckhand's state directory, links followed** — an icon naming `credentials.json` was exported with its tokens inside. The editor and the export also require an image, by extension or by first bytes; the daemon leaves the type to sharp. Held by `smoke-icon-files` and `export-bundle.test.ts` |
| `src/default-icons.ts` | pure so the editor can import it; an icon not drawn yet maps to no default, never to `missing`. `BUILTIN_ICONS` = `assets/icons/`, held by `scripts/smoke-defaults.mjs` |
| `src/deck.ts`'s `heldRelease` / `latched`, or anything that changes the page, profile, layout or connection | **nothing may leave a key held at the evdev layer** — every path off a page fires pending releases and releases latches |
| `src/key-failures.ts`, `DeckSession.dispatch()` | a failed key clears only on a successful press, an edit, or the person's **Clear** in the editor (`failure.clear`) — never a timer or a page switch; a cleared key that fails again is marked again; marks cost nothing at rest and notify only on change |
| `src/failed-badge.ts` | the one drawing of the failed-key badge, shared by the deck and the editor's grid; import-free so the editor can import it |
| `src/services/mpris.ts`, any media `describe()` / `iconState()` | key faces read the player state cache; no D-Bus call in a render |
| `src/index.ts`'s `scan()` / `unattached` / `reevaluateUnattached` | a deck with no layout is left alone until a **reload** re-evaluates it; skipping `unattached` unconditionally strands a deck that has just been given one, until it is replugged |
| `editor/src/renderer/model.ts`'s `emptyState()` / `connectionPill()` | the **order** is the content: "nothing is connected at all" is tested before anything per-deck, and before the layout, or one deck gets named while every deck is missing; both use the same order so the card and the pill cannot disagree |
| `followDeck()` | it must **reconcile first, then follow the deck it settled on** — following the previous serial misses the deck's real page whenever the selection named no deck, which is every time the window opens before the daemon has reported. With several decks shown, each other deck then follows its own page, only while it shows the selection's profile — a page id can exist in two profiles. **It follows a deck into another profile only when that profile is the active one** (a key on the deck switched it): a deck the profile has no keys for still shows an older profile, and **choosing a deck never changes the profile** — App.tsx gives such a deck a blank page there instead |
| `Selection.others`, `keyUnder()`, anything drawing several decks | **with one deck connected the editor is exactly the one-deck editor** — held by `check:one-deck`, run before every commit by `scripts/hooks/pre-commit`. Each shown deck's page is held once: the focused deck's in `page`, every other's in `others`. A key is found by deck **and** index — an index alone names a key on every grid, and a key drag would swap on the wrong deck |
| `editor/src/renderer/canvas.ts`, `DeckCanvas.tsx` | **positions are key units at each grid's top-left**, in the editor preferences by serial, never `config.json`, so they mean the same at any zoom or window size. **A drop saves every shown deck as drawn**, not only the one moved — a deck never dragged would otherwise be placed afresh below the lowest on the next opening. Decks never overlap: a drop onto one is butted against the edge of it the pointer is nearest, not the side it came from, so a held deck follows the pointer. **Zoom changes only when the person asks**, and Fit all runs only on opening and when the shown decks change — never on a resize |
| `deckChoices()` / `knownDecks()` / `deckOptions()` | **a deck that is not plugged in is not listed, anywhere.** The editor's device lists derive from the first two, and Settings' Default deck list (`deckOptions()`, `editor/src/shared/settings.ts`) follows the same rule separately. The *stored* default may still name an absent deck. Accepted cost: unplugging the deck being edited moves the editor off it |
| `src/services/apps.ts`, `src/services/icon-theme.ts`, an action's `defaultIcon()` | an app's icon is resolved when drawn and **never written to `config.json`**; every answer is cached, and nothing watches the disk — the socket's `apps` command, which the editor's app list asks, is the one thing that forgets and re-reads |
| the config watcher, or anything written near `config.json` | it is safe only because it is non-recursive and filters on the file name |
| a toggle's or any other paired icon field | one list, `PAIR_ICON_FIELDS`, held by `editor/test/pair-icons.test.ts` |
| `src/credentials.ts`, or anything that stores a password or token | **a secret is never in `config.json`, an export or a backup**, and the control socket never returns one — only whether it is set. The file is written 0600 by temp file and rename, **one change at a time** — every read-change-write waits for the one before, and each has its own temp file: two at once lost a change or left a file that was not JSON, and a lost Twitch refresh ends the link (held by `smoke-credentials`) |
| `src/services/obs.ts`, any OBS `describe()` / `iconState()` | **connected only while a shown page has an OBS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; a refused password is never retried until the credentials change — not by the scan, a key coming into view, or a press, which is refused at once pointing to Settings, as VTS's is; **not set up — no saved connection — never connects at all**, and set up means saved, not "has a password" or "has connected once"; key faces read the state cache, fed by OBS's events, never a request in a render. **What shown keys name — Mute keys' inputs, Source keys' scene items — is asked once, when first shown, then kept by events; never polled**, and forgotten when no shown key names it |
| `src/actions/obs.ts`'s Stream key, `DeckSession`'s `holds` | **Stream starts on a press and stops only on a hold** — accidentally ending a stream is the worst thing it can do. A hold is two timestamps, not a timer; a press that started the stream cannot stop it, and a hold is dropped on every way off the page. **The release decides a hold's mark when the press armed one** (`execute` resolved `'armed'`): that press succeeding does not clear it (or every short press would flicker the badge and notify again), and a release with nothing to do leaves the press's own failure in place. A press that started the stream is judged by itself. **A start is shown, and succeeds, only once OBS says STARTED**: OBS sends STARTING and then nothing for a start that fails at once, so Stream and Record wait for STARTED or STOPPED (one-shot, `START_CONFIRM_MS`), mark the key otherwise, and correct the cached state |
| `src/action-error.ts`, `DeckSession.settle()`, `src/services/notifications.ts` | **only a failure whose message tells the person what to do (`ActionNeeded`) is notified — on every failed press**, each key keeping one notification: a repeat within 10 s is counted on it, **in place only while its popup is up** (Plasma shows no update to a timed-out one) and otherwise closed and shown anew; clearing the mark (Clear, a press that works) restarts the count; `"notifications": false` is read at the moment of the failure, so a reload counts. **A press of a key whose integration is not set up (`NotSetUp`) is never marked** — its face says so, and a mark would outlast the setup — and is notified like any failed press, per key |
| `src/services/vts.ts`, any VTS `describe()` / `iconState()` | **connected only while a shown page has a VTS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; **only `requestAccess` (Settings' Connect) ever asks VTS for a token**; a revoked token is refused and never retried until Connect; **not set up — no saved token — never connects at all**; the broadcast is listened to only inside Connect, never at rest; key faces read the state cache, fed by VTS's events, never a request in a render. **Expression state is the loaded model's only, asked when an expression key comes into view, on a model load and after an expression hotkey — never polled** — and an answer is kept only for the model it names: `ExpressionStateRequest` answers for whichever model is loaded, whatever model is asked, so the picker and the cache check. **A Model key never asks for the model already loaded**: VTS reloads it, and the avatar drops out |
| `src/services/twitch.ts`, `src/credentials.ts`'s Twitch section | **a refresh token is single-use, and Twitch ends the whole link when a replaced one is sent** (measured): one refresh at a time, shared by the hourly check and every press, and the new pair saved — in one write — before anything uses it. **A refused refresh keeps the link**: Twitch's own faults look the same as a dead link, so the keys are marked, the tokens kept, and the hourly check keeps trying; only Remove or a new link clears it. The link keeps the client ID it was made with. The hourly check runs only while linked, and polling only while linking |
| `src/services/vts-client.ts`'s `PLUGIN_NAME` / `PLUGIN_DEVELOPER` | **permanent**: VTS refuses a saved token given for another name or developer, so a change disconnects every user without a word |
| `src/services/text-socket.ts` | offers **no WebSocket extension**: VTS's server compresses whatever a client accepts, and Node's own client misreads it. Messages arrive in 1016-byte fragments and are put back together |
| `src/actions/system.ts`'s `launch()`, or anything that starts a program from a deck | **nothing launched from a deck may be the daemon's child.** It goes through `launch()` (`systemd-run --user --scope`); a plain or detached spawn stays in `deckhand.service`'s cgroup, and every stop of the service — each update, a crash restart, logging out — kills it. Not `KillMode=process`: that leaves the helper, `pactl subscribe` and `udevadm monitor` behind |
| `src/services/session-lock.ts`, `src/drivers/virtual.ts`'s touch path | **no touch from a virtual deck runs an action unless logind says the session is unlocked and active**; a state that cannot be read counts as locked; every key held when the lock comes is let go. Reading the device directly bypasses the lock screen, so this is the lock. Held by `smoke-virtual-touch`'s fake logind |
| `src/drivers/virtual.ts`, `src/hit-test.ts` | **the daemon hit-tests, never the helper**; a touch owns the control it started on until it lifts, wherever it lifts; every touch is let go on a lock, a panel change, or the touchscreen or screen going |
| `src/panel-presets.ts`'s `panelIn` / `defaultPanelOf`, `src/drivers/virtual.ts`'s `layoutFrom` | **a virtual deck never attaches with zero keys**: a profile's own panel, else the deck's default (`decks[key].virtual.panel`), else the first profile's, else a Medium grid for the screen. A profile made after the deck has no panel of its own and must show the default — found shipped in `v0.8.0`, where it showed nothing. Held by `virtual-panel.test.ts`, `check:virtual` and `smoke-virtual` |
| `src/screens.ts` | **a screen's key never contains the EDID's numeric serial**: the Xeneon Edge and two identical HP monitors all report the same placeholder there; only the text serial, cleaned of unprintable bytes (one carries a NUL), tells screens apart |
| `panel/wayland.c`, `src/drivers/virtual.ts`'s helper exit | **losing the output is not losing the screen**: the helper waits for its output to be announced again (no timer) and the daemon draws everything on its next `ready`; only the kernel's connector state ends a virtual deck. **A helper that stops unasked closes its deck's session** — listed again with its screen still connected, the session would stay open around a helper that is gone, showing nothing and reported connected. Held by `smoke-panel` (a headless KWin's output disabled and enabled) and `smoke-virtual` |
| `panel/evdev.c` | **the paired touchscreen is grabbed, and a failed grab is an error**, never a silent read the desktop also sees; a path that is not an input device is refused unless `--touch-test-range` is given, which only tests pass |
| `src/services/hotplug.ts` | **a display event rescans only when the connected screens or their keys changed**, and is ignored with no virtual deck configured: `drm` change events have arrived every few seconds at rest with nothing plugged in |
| `udev/60-deckhand.rules`, `udev/deckhand-touch-access`, `editor/src/main/touch-access.ts` | **no touchscreen is readable unless it is paired as a virtual deck, and only from its pairing** (Ryan's decision, 2026-10-17). A rule granting a touchscreen opts it out of Wayland's separation of programs' input: any program the user runs could read it, a laptop's on-screen keyboard included. So no rule at install, no rule for every touchscreen, and one entry per paired touchscreen — its IDs, and its serial when it has one — written by the root helper at pairing, removed with its deck and at uninstall. **The grant is a file ACL for the user who paired it, read only, never `TAG+="uaccess"`**: udev's tags are sticky until the device goes, and its seat rule re-grants on every re-trigger, so a uaccess grant cannot be taken back (measured). **Nothing re-triggers a touchscreen**: access is set and taken off directly. The temporary access for the tap is dropped on every path: a deck added, a cancel, no tap, the editor gone, a kill, 5 minutes. The helper takes no paths or user from its caller and refuses any serial udev would read as a pattern. Never the "mouse" twin either, a plain mouse to udev. Held by `touch-access.test.sh`, `udev-trigger.test.sh` and `check:virtual` |

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
`~/.local/bin`. The pieces that need root are a udev rule granting the
logged-in user access to the decks and to `/dev/uinput`, and the touchscreen
pairing helper, installed root-owned so that nothing the user can write runs
as root; touchscreens are granted only one at a time, as they are paired
(above). Uninstalling always removes the rule, every paired touchscreen's
rule and the helper, because they let any of the user's processes synthesise
keystrokes and read those touchscreens.

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
  is not in a commit. The two binaries Deckhand compiles, the input and
  display helpers, are compiled on AlmaLinux 8 (glibc 2.28); every other
  native file is an upstream prebuild. Then every binary in the package is read, and the release is
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
