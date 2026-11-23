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
  touchscreen directly, grabbed, passing touches back — down and up, and,
  for a finger the daemon has found on a slider or dial and asked it to
  follow, its movement. It knows nothing of keys or shapes: the daemon
  decides which key a touch lands on.
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
  belongs to the desktop session, and the daemon is outside it. **Once each time its window opens**, unless
  Settings › General's "Check for updates" is off, it asks GitHub for the latest
  release, to show an Update pill when a newer one exists, with that release's own
  update line to copy; it downloads and installs nothing, and the
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
by index, so a moved or resized key keeps its button. **Every page of a
virtual deck has its own layout** — its panel of controls — so the daemon
lays the deck out again on a page change, **only when the new page's
controls differ** from those shown: a new set clears the screen before every
key is drawn, and two pages with the same grid switch as a Stream Deck's do.
The editor draws each page from the config at that page's grid, never the
grid the deck happens to show. The deck keeps a default size, chosen when it
is added, for every page made without a choice.

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
  lifts, as a held Stream Deck key does. **A control is a rectangle with a
  corner radius, round, or a point-up hexagon**, and each shape answers three
  questions — is a point inside it, what is its outline, what is the largest
  rectangle inside it (`src/shapes.ts`) — and nothing else asks which shape it
  is: a touch is tested on the real shape, the face is cut to the outline, and
  the label and failed badge are laid out in the inner rectangle, so a new
  shape only has to answer the same three. **Where controls overlap, the later
  in the panel's list is on top**, for touch and on the screen alike.
- **Every key of a virtual deck carries a thin, light outline inside its
  shape's edge**, on every page, a grid's included, so a button reads as one on
  a dark screen. Drawn inside, the outline changes neither where a touch lands
  nor what an overlap covers. A Stream Deck's keys have none.
- **What the daemon sends the helper is transparent wherever nothing is
  drawn**: a control's face is its solid fill inside its shape and alpha 0
  outside, never flattened onto the background. The helper puts the background
  under every image before blending it, and the daemon sends a control whose
  box another overlaps as every control touching that box, combined in order
  and still clear where none is — **combined when it is sent**, from the faces
  as they are then, so a control queued behind a busy helper never carries a
  face that has since been replaced. So a shape's soft edge never builds up over
  its own last one, a redrawn control never paints over the one above it, and
  a see-through background needs only the helper to change what it puts under.
  An opaque square key is drawn exactly as before.
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
- **Turning a virtual deck off is unplugging its screen, as far as the
  daemon is concerned**: the driver leaves it out of every scan, so its
  session closes, its helper quits, the grab ends and every held key is let
  go — nothing runs for it at rest. Its pairing, layouts and touchscreen
  access are kept, so on is instant, with no password, and returns to the
  page it was on. **Off lasts until it is turned on, across restarts** —
  the person's intent — kept in the state directory (`virtual-off.json`),
  never `config.json`, which the daemon does not write.
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
while it is visible. Identical images are never rewritten to USB. **A key whose face changes only on events is redrawn only then** (`redraw: 'events'` on its action): OBS, VTube Studio, Twitch and Discord keys are drawn when shown and again when their service announces a change or the key's own state does, never on the 500 ms tick's clock — before, each was redrawn every second for nothing. The tick's clock is for faces that depend on time, like a clock. **A slider's or dial's level is read from the same event-fed caches** — `pactl subscribe`'s, a deck's own brightness, Discord's events — and drawn when they change, never polled; dragging one costs only while a finger moves. "No timers
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
60-second scan. **The input helper, `pactl subscribe`, `udevadm monitor`
and the config watch do the same** (`src/recovery.ts`): one quick retry, then
the scan, and staying up 10 seconds earns the quick retry back, so a
dependency that stays gone costs nothing between scans. A press also tries
to start a missing input helper. **OBS is connected only while a page a deck shows has an OBS
key**, or a press is waiting on it; if OBS is not running, the next try rides
the same 60-second scan — it has no timer of its own. The `setTimeout`s in
`src/services/obs-client.ts` are one-shot deadlines for a handshake or a
request, not recurring timers. **Pairing a virtual deck's
touchscreen** waits for a tap with a one-shot 30-second deadline, and its
root helper drops its temporary access after at most 5 minutes, only while
someone is pairing. **A deck woken by a press while the desktop is idle** gets a one-shot deadline to go back (`src/sleep.ts`), never at rest. **While a Twitch account is being
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
the model has loaded, a one-shot deadline like OBS's. **Discord is the one exception: connected while Discord is running and the active profile has a Discord key on any page**, shown or not, because its handshake has taken up to 20 s, on both its clients, and would otherwise fall on the first press after a page switch. It is not a precedent: a
future integration earns it only with a measured reason of its own. An idle
connection costs nothing, since Discord sends events only on change; when
Discord is not running, the next try rides the same 60-second scan, and its
tokens are renewed only when connecting — no timer of its own. The
`setTimeout`s in `src/services/discord-client.ts` are one-shot deadlines:
the handshake's is 45 s.

**Secrets live in one owner-only file, never in the config.** Credentials for
the services Deckhand is a client of — OBS's WebSocket password, VTube
Studio's token, Twitch's and Discord's tokens — are kept in
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

**Discord is reached through the official app's local RPC, with each
person's own application.** Discord approves no shared application for
RPC, so each person makes one in Discord's Developer Portal, as a public
client, and gives Deckhand its ID; there is no client secret anywhere. The
code Discord's Authorize window gives is exchanged with PKCE. Only Settings'
Connect asks Discord to authorize. The refresh token rotates on every
refresh, but a replaced one sent again is refused without ending the link
(measured), unlike Twitch's; one refresh still runs at a time, saved before
use. The RPM's Discord listens at `$XDG_RUNTIME_DIR/discord-ipc-0`, the
Flathub Flatpak's at two paths under `$XDG_RUNTIME_DIR` (both measured);
Vesktop is not supported. **A press never waits on Discord's handshake**:
until it answers, Discord keys show a connecting badge, and a press is
refused at once, notified and never marked.

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

**A deck sleeps at brightness 0, its images kept.** While logind says the session
is locked or not active, every Stream Deck is dark, so waking is one brightness
write and no redraw. The first press on a dark deck only wakes it, and its release
is swallowed too. Unlike a virtual deck's touches, **an unreadable lock state leaves
the decks awake**: a deck left dark because logind went away is the worse failure.
Sleep all decks dims every deck to a level, or turns them off, until a press on any
deck. Nothing here adds a timer: logind's signals and presses are the only events.

**The compositor counts idle time, not Deckhand.** Dimming after idle is an idle
mode of the display helper (`deckhand-panel --idle`, `panel/idle.c`), asking for
`ext-idle-notify-v1`'s plain notification, which respects the compositor's own idle
inhibitors. **That isn't all that keeps a screen on**: a browser playing a video asks
KDE's power management over D-Bus, which the notification doesn't count (measured:
it said idle while KDE listed an active inhibition). So Deckhand also follows
powerdevil's `ActiveInhibitions`, by its change signal: while one names `idle`, the
helper doesn't run and the decks stay lit, and when it ends the helper starts afresh,
so the count begins then. `sleep` only blocks suspending, and doesn't count. Deckhand can't count for itself: it can't see
keyboard or mouse input without reading every input device, which Wayland
deliberately prevents. The helper runs only while dimming is set and a Stream Deck
is attached, and blocks in `poll()`. logind's `IdleHint` isn't used: KDE never sets
it. Where the compositor lacks the protocol the helper says so, and Settings greys
the controls out. **A press that types nothing is not input to the compositor**, so
a deck it wakes would stay lit until the next idle: it starts a one-shot deadline,
cancelled when the desktop reports resumed, restarted by another deck press, and
overridden by a lock. Virtual decks are left out: their monitor's power saving
covers them.

**A virtual deck dims in its display helper, not on the screen.** The helper keeps the
screen drawn at full brightness and dims each frame as it hands it to the compositor,
and 0 is pure black; **a change is the level alone** — nothing cleared, nothing sent
again, one frame shown at the new level. A slider dragged quickly sends a few bytes a
step, and a burst the helper reads at once is shown as the last of it. Before, a change
cleared the screen and redrew the page: a quick drag blacked the panel out and flashed
its background, and the helper fell about two and a half seconds behind the finger
(measured with the real helper: about 32 ms of CPU a step against about 6 for a
Volume slider's; now about 8–10, since a level changes every pixel and each frame shown
dims the whole screen, 3–5 ms at 1920 × 720). Each of the helper's two buffers copies
only what changed since it was last shown, so no extra memory, and a key's redraw on a
dimmed deck copies the key alone. **A level is light given off, as a backlight's**: a
screen's values are gamma-encoded, so the helper scales them by
(level / 100)^(1 / 2.2), not by the level itself. Scaling by the level drew white at 12
of 255 at 5, the lowest a key or slider sets, and the panel looked switched off; now
it is 65, dim and plainly lit, as a Stream Deck's backlight is at 5. The curve is a
101-entry table, so the helper still needs nothing but libc. Plasma's `org.kde.ScreenBrightness` reached every
screen tried, but only a laptop's own panel really dimmed: monitors barely changed,
and at 0 looked about half as bright (measured on three), which is too weak and too
monitor-dependent to build on. The limit of drawing it: a panel at 0 is black pixels
over a lit backlight, so an LCD still glows faintly. A lock doesn't darken a virtual deck: the lock screen
and the monitor's power saving already cover its screen.

**A virtual deck's page background is drawn by the helper, under everything,
and is see-through only when asked.** Each page has its own: a colour, an
optional image as Fill or Fit over the whole screen, and one opacity for the
layer. The daemon draws the image at the screen's size and sends the whole
layer once; the helper puts it under every image it places, so controls stay
opaque and only the space around them shows the page. **A page with no
background sends nothing new**, and the helper keeps its opaque `XRGB8888`
buffers; below 100% it hands the compositor premultiplied `ARGB8888`, and what
is on that screen behind the deck shows through — and cannot be touched, since
the touchscreen stays grabbed. Brightness is black laid over the whole deck,
so a sleeping see-through deck is black, not clear. **What it costs is the
compositor's** (cgroup CPU over 600 s). **At rest, nothing**: on KDE Plasma with
a GPU, KWin spent the same at 50% as opaque (16.3% and 16.2% of a core on a
busy desktop); on a headless KWin, 0.023% and 0.024%. **With something moving
behind the deck, it depends on how the compositor draws**: on the GPU desktop a
30 fps video behind the panel cost KWin about the same see-through or opaque
(22.6% and 24.2%) — it went on drawing the covered video either way — while a
headless, software-rendered KWin skipped it behind an opaque deck and spent
29–30% against 3–5% with a see-through one. So on a desktop drawing without a
GPU, see-through belongs on screens where nothing moves behind the deck.
Deckhand itself spends the same in every case, and nothing of it runs on a
clock. Where the compositor
has no layer-shell (GNOME) the deck is a full-screen window, which may not
show through; the editor says so there.

**A slider or dial is a touch zone that sets a level, and takes only an
action that carries one** — Volume (any local output or input, or the default
output or input), Brightness (any deck, 5–100, as a key's) and Discord's User
volume (0–200 %). A button keeps every action it has, these included, as
before. **A slider or dial is always a rectangle**: a round or hexagon one
would cut off a dial's ring and its label, so a dial draws its round art
inside its box. Its value is read
from an event-fed cache and written outright (`ActionHandler.value`): a change
made outside Deckhand moves the level shown, and nothing polls.

- **The helper reports a finger's movement only when asked.** The daemon
  hit-tests a touch on its way down, as always; on a slider or dial it asks the
  helper to follow that contact (`M`), which then reports where it moved at
  most once per frame of the touchscreen, until it lifts. A button's touch is
  down and up, exactly as before, and the helper still knows nothing of
  controls.
- **Writes go one at a time, the newest waiting.** A slider dragged faster
  than its service answers sends what the finger has reached when the last
  write lands — no queue, and no timer: the next write starts when the last
  ends. While a finger drags a volume, the cache is not re-read after each
  write; the last write of the drag re-reads it, and `pactl subscribe`'s event
  does once the drag pauses. **A pactl call costs about 22 ms of CPU — 8 ms in
  `pactl` itself, 7 in pipewire-pulse, 6 in pipewire — and as long in wall
  time** (100 calls, measured with a read-only call so no volume changed), so
  each step that writes costs one call instead of the seven a button's press
  spends (the change, its re-read, and the event's re-read), and a fast drag
  writes at most about fifty times a second, bounded by pactl's own round
  trip. Nothing of it runs at rest.
- **The face is drawn in the daemon, its layers once and its level each
  step.** Each layer — the built-in art or an image, in its own area, and the
  level — is rasterised once per change of art, label or badge; each step puts
  them together in plain JavaScript (the fill or ring up to the level, the
  thumb moved or the knob turned) and sends the image as any key's is sent.
  Measured against two alternatives with the real helper under a headless KWin,
  600 steps at 60 a second, CPU per step (ms; daemon / helper / KWin): this
  way, a slider 1.9 / 2.6 / 1.3 and a dial 3.1 / 2.2 / 1.2; **the helper
  composing from values**, its layers sent once, 0.3 / 3.1 / 1.5 and
  0.3 / 4.4 / 1.4; **the whole control redrawn by sharp** each step,
  23.5 / 1.9 / 1.1. Most of a step is the helper placing the image and the
  compositor showing it, which both of the first two pay; the second saved
  about a millisecond a step for a new protocol and compositing in C, so the
  helper stays a placer of images, and a slider overlapped by another control
  is combined as any key is. At rest the helper and KWin spent nothing.
- **Every way off a page ends a drag with the value where it is**: a lock (no
  touch runs while the session is locked or inactive), a page change — to a
  page with the same controls too, where the finger is still on the screen —
  a panel change, the deck closing. What was written stays; a write not yet
  started is dropped; the face goes back to the real value. A write that fails
  marks the control, as a failed press does, and the rest of that drag writes
  nothing, so one drag is one failure.
- **A brightness slider or dial stops at 5**, as a Brightness key does. It
  once went to 0, and a panel dimmed that way came back only when its slider
  was found by touch on a black screen.
- **The level is drawn by Deckhand, never an image** — a slider's fill, a
  dial's ring — shown or switched off, in a colour of the person's choosing or
  the action's (its own bright set, never the background swatches, which are
  dull on purpose), so no art can take the level away: the fill lies under the
  thumb, and **the ring is drawn over the knob**, whose area is inside it.
  **It glows**: a blurred copy under it, in its colour, about as far as the
  touch halo reaches. The glow is drawn once with the art, so a step pays only
  for the pixels it adds — measured in-process over 600 steps, a slider
  (115 × 490) 0.53 → 0.73–0.79 ms of composing a step, a dial (205 × 205)
  1.55 → 1.66–1.75 ms, against 5.8–6.5 ms a step in all; the art's one drawing
  takes 15–20 ms longer. Nothing of it runs at rest.
- **The editor draws a slider or dial as the deck does, from the same code**:
  the same art and areas (`value-controls.ts`), over the control's whole box —
  its selection outline drawn inside the box, taking no room — and a slider's
  travel by one rule on both (`sliderTravel`): the track's ends, the built-in
  one's or the whole length, and a chosen thumb's length from its image's own
  size fitted in its area, never measured from its pixels.
- **Every other layer is Deckhand's own art until an image is chosen**, drawn
  for the box in its action's colour: a slider's track running its length and
  its thumb scaled by its width; a dial's base from its start to its end angle,
  and its knob. **An image keeps its proportions where it is a thing on the
  control** — the thumb, fitted across the slider; the knob, inside the ring;
  the base, in the dial's square — so a round knob never becomes an oval, and
  **fills its area where it is a surface**: the track, stretched to the art, and
  a background image, which has no built-in art, stretched to the whole box
  behind everything (a scale along a slider, say). Every image is held to the
  image limits; one refused is drawn as the built-in layer, the reason logged
  once.

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
**An icon's size is one rule for every image and every shape: at 100% the
whole image fits the key's box, centred**; above, it zooms in and the key's
shape cuts it; below, it shrinks. The scale is relative to the key, never to
the image, so a built-in is never cropped at its default size. Each key may
have its own (`iconScale`, 20–200); without one an image file is at 100 and
a **built-in at `defaults.builtinIconSize`** (45.5 unless set, 25–100:
Settings › General › Icon size, showing the same figure), so the glyphs sit
as the editor's design draws them. **The old crop (`iconFit`) is converted,
not kept alongside**: a config without `"version": 2` is drawn as it was by
the daemon, in memory, and converted by the editor when it opens it — each
image's crop becomes the scale that keeps its look. A number is needed
because a config cannot tell "100%" from "the old default crop" without one.

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
**The one deliberate exception is a soundboard sound**: its player
(`pw-play`, or `paplay`) is the daemon's own child, as `pactl` is, because
its life is the key's state — the key shows playing from the moment it
starts to the moment it exits — and a stopped daemon should stop its sounds.

**A sound key's face follows its player, never a clock.** A player starting
or ending marks the sound keys to be drawn; a loop is the next player
started when the last one ends, and a sound that ends within 250 ms is not
started again, so a file that plays nothing cannot loop. The one
`setTimeout` in `src/services/sounds.ts` is a one-shot wait, up to 250 ms
after a press, for a player that fails at once.

## Invariants — before changing the code

Each of these looks arbitrary and is not. Most are held by a test; the reason
is here so the test is not "fixed" instead.

| Before touching | The invariant |
| --- | --- |
| `helper/deckhand-input.c` | combo timing (`TAP_DELAY_US`, `COMBO_GAP_US`, …) is a tested floor, not a tuning knob |
| `src/control/` | nothing may block or await a client; socket actions are serialised daemon-wide |
| `editor/src/main/one-at-a-time.ts`, `main.ts`'s `deckAction` | **the editor's own deck actions — a page shown, a profile made active, a Test Run — run one at a time**, each whole. The daemon refuses a second socket action with `busy` rather than queue it, so two page tabs clicked quickly lost the second click, and the first's success hid the error |
| `src/recovery.ts`, anything restarting a helper or a watch | **one quick retry, then the 60-second scan**, never a loop of its own: a dependency that stays gone must not add work at rest. Held by `smoke-recovery` |
| `src/services/audio.ts`, any audio `describe()` | key faces read a cache; spawning `pactl` from a render feeds itself |
| `src/render.ts`, `src/builtin-icons.ts` | built-ins are resolved by name; a default is never written to `config.json`, and a chosen built-in is written as `builtin:<name>`, never as a path into the app directory |
| `src/icon-file.ts`, anything that reads an icon path (the renderer, the editor's icon protocol, the export) | **an icon path is checked before it is read**: a regular file (a device or FIFO never finishes reading), at most 10 MB, **never in Deckhand's state directory, links followed** — an icon naming `credentials.json` was exported with its tokens inside. The editor and the export also require an image, by extension or by first bytes. **An icon someone set is also held to the image limits** (`src/image-limits.ts`: PNG, JPEG, WebP, GIF or SVG, 4096 px on the longer side) **by the daemon as well as the editor**: refused, it is drawn as the missing icon, never blank, and the log, the grid and the Icon tab say why in the same words. Held by `smoke-icon-files`, `smoke-appearance`, `check:appearance` and `export-bundle.test.ts` |
| `src/default-icons.ts` | pure so the editor can import it; an icon not drawn yet maps to no default, never to `missing`. `BUILTIN_ICONS` = `assets/icons/`, held by `scripts/smoke-defaults.mjs` |
| `src/deck.ts`'s `heldRelease` / `latched`, or anything that changes the page, profile, layout or connection | **nothing may leave a key held at the evdev layer** — every path off a page fires pending releases and releases latches |
| `src/key-failures.ts`, `DeckSession.dispatch()` | a failed key clears only on a successful press, an edit, or the person's **Clear** in the editor (`failure.clear`) — never a timer or a page switch; a cleared key that fails again is marked again; marks cost nothing at rest and notify only on change |
| `src/failed-badge.ts` | the one drawing of the failed-key badge, shared by the deck and the editor's grid; import-free so the editor can import it |
| `src/services/mpris.ts`, any media `describe()` / `iconState()` | key faces read the player state cache; no D-Bus call in a render |
| `src/index.ts`'s `scan()` / `unattached` / `reevaluateUnattached` | a deck with no layout is left alone until a **reload** re-evaluates it; skipping `unattached` unconditionally strands a deck that has just been given one, until it is replugged |
| `editor/src/renderer/model.ts`'s `emptyState()` / `connectionPill()` | the **order** is the content: "nothing is connected at all" is tested before anything per-deck, and before the layout, or one deck gets named while every deck is missing; both use the same order so the card and the pill cannot disagree |
| `followDeck()` | it must **reconcile first, then follow the deck it settled on** — following the previous serial misses the deck's real page whenever the selection named no deck, which is every time the window opens before the daemon has reported. With several decks shown, each other deck then follows its own page, only while it shows the selection's profile — a page id can exist in two profiles. **It follows a deck into another profile only when that profile is the active one** (a key on the deck switched it): a deck the profile has no keys for still shows an older profile, and **choosing a deck never changes the profile** — App.tsx gives such a deck a blank page there instead |
| `Selection.others`, `keyUnder()`, `DeckPanel.tsx`, anything drawing several decks | **every deck is drawn in its frame with its header — name, size, Page ▾, and a virtual deck's Change layout… and background icon — one deck or several, so a deck's controls are in the same place whatever the number of decks, and the zoom bar is shown with one or several; what arranges decks (dragging, the lock, snapping, Show in editor) appears only with two or more** — held by `check:one-deck`, run before every commit by `scripts/hooks/pre-commit`, which also counts `[data-multideck]`, the mark on everything that exists only with several. **Any click on a deck's frame that is not a drag focuses that deck** — its header, its size, any empty part of the frame — while a control of the frame's own (a button, the Page ▾) does only its own job; a press that moved is a drag, and its click focuses nothing. Held by `check:multi-deck`. Each shown deck's page is held once: the focused deck's in `page`, every other's in `others`. A key is found by deck **and** index — an index alone names a key on every grid, and a key drag would swap on the wrong deck |
| `editor/src/renderer/canvas.ts`, `DeckCanvas.tsx` | **positions are key units at each grid's top-left**, in the editor preferences by serial, never `config.json`, so they mean the same at any zoom or window size. **A drop saves every shown deck as drawn**, not only the one moved — a deck never dragged would otherwise be placed afresh below the lowest on the next opening. Decks never overlap: a drop onto one is butted against the edge of it the pointer is nearest, not the side it came from, so a held deck follows the pointer. **One set of zoom rules, one deck or several, in normal use and in Edit layout**: the view opens at Fit, never above 100%; **a zoom the person sets holds through window resizes** until Fit, and while at Fit a resize fits again; a change of the shown decks fits again; a deck changing size (another page's grid) fits again only while nobody has set a zoom; Edit layout fits the deck being edited on entering, and **leaving puts back the zoom from before entering**; zoomed in, the canvas scrolls to every part of a deck. Held by `check:one-deck` (a set zoom through a resize, scrolling both ways, Fit) and `check:layout` (the zoom across the mode). **A virtual deck's custom page is drawn at the height its deck's default grid takes**, so its frame does not jump from page to page, and **a virtual deck's frame is never narrower than its header**, measured as drawn |
| `deckChoices()` / `knownDecks()` / `deckOptions()` | **a deck that is not plugged in is not listed, anywhere.** The editor's device lists derive from the first two, and Settings' Default deck list (`deckOptions()`, `editor/src/shared/settings.ts`) follows the same rule separately. The *stored* default may still name an absent deck. Accepted cost: unplugging the deck being edited moves the editor off it |
| `editor/src/renderer/Dropdown.tsx` | **every dropdown is this, never a native `<select>`**: a native popup is the system's to draw, so it can't match the rest. Its look is Show in editor's trigger and panel. **Keys pressed in one, open or closed, never reach the grid's shortcuts**: Delete there would clear the selected keys. Held by `check:settings`, comparing their computed styles, `check:bulk` and the editor's unit tests |
| `src/services/apps.ts`, `src/services/icon-theme.ts`, an action's `defaultIcon()` | an app's icon is resolved when drawn and **never written to `config.json`**; every answer is cached, and nothing watches the disk — the socket's `apps` command, which the editor's app list asks, is the one thing that forgets and re-reads |
| the config watcher, or anything written near `config.json` | it is safe only because it is non-recursive and filters on the file name |
| a toggle's or any other key with states, `src/state-icons.ts` | **two icons: the key's own `icon` (its default) and the action's `iconActive`** — a default and no active icon is that icon in both states, never switching; a warning state (OBS reconnecting, paused) draws its built-in over both. **Old configs, one field per state, are migrated by one function**: in memory by the daemon on every load, never writing `config.json`, and saved by the editor when it opens the file — so a config nobody opens in the editor draws as it did. Held by `smoke-defaults`, `config-store.test.ts` and `pair-icons.test.ts` |
| `src/credentials.ts`, or anything that stores a password or token | **a secret is never in `config.json`, an export or a backup**, and the control socket never returns one — only whether it is set. The file is written 0600 by temp file and rename, **one change at a time** — every read-change-write waits for the one before, and each has its own temp file: two at once lost a change or left a file that was not JSON, and a lost Twitch refresh ends the link (held by `smoke-credentials`) |
| `src/services/obs.ts`, any OBS `describe()` / `iconState()` | **connected only while a shown page has an OBS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; a refused password is never retried until the credentials change — not by the scan, a key coming into view, or a press, which is refused at once pointing to Settings, as VTS's is; **not set up — no saved connection — never connects at all**, and set up means saved, not "has a password" or "has connected once"; key faces read the state cache, fed by OBS's events, never a request in a render. **What shown keys name — Mute keys' inputs, Source keys' scene items — is asked once, when first shown, then kept by events; never polled**, and forgotten when no shown key names it |
| `src/actions/obs.ts`'s Stream key, `DeckSession`'s `holds` | **Stream starts on a press and stops only on a hold** — accidentally ending a stream is the worst thing it can do. A hold is two timestamps, not a timer; a press that started the stream cannot stop it, and a hold is dropped on every way off the page. **The release decides a hold's mark when the press armed one** (`execute` resolved `'armed'`): that press succeeding does not clear it (or every short press would flicker the badge and notify again), and a release with nothing to do leaves the press's own failure in place. A press that started the stream is judged by itself. **A start is shown, and succeeds, only once OBS says STARTED**: OBS sends STARTING and then nothing for a start that fails at once, so Stream and Record wait for STARTED or STOPPED (one-shot, `START_CONFIRM_MS`), mark the key otherwise, and correct the cached state |
| `src/action-error.ts`, `DeckSession.settle()`, `src/services/notifications.ts` | **only a failure whose message tells the person what to do (`ActionNeeded`) is notified — on every failed press**, each key keeping one notification: a repeat within 10 s is counted on it, **in place only while its popup is up** (Plasma shows no update to a timed-out one) and otherwise closed and shown anew; clearing the mark (Clear, a press that works) restarts the count; `"notifications": false` is read at the moment of the failure, so a reload counts. **A press of a key whose integration is not set up (`NotSetUp`) is never marked** — its face says so, and a mark would outlast the setup — and is notified like any failed press, per key |
| `src/services/vts.ts`, any VTS `describe()` / `iconState()` | **connected only while a shown page has a VTS key or a press is waiting**; no timer of its own — retries ride the 60-second scan; **only `requestAccess` (Settings' Connect) ever asks VTS for a token**; a revoked token is refused and never retried until Connect; **not set up — no saved token — never connects at all**; the broadcast is listened to only inside Connect, never at rest; key faces read the state cache, fed by VTS's events, never a request in a render. **Expression state is the loaded model's only, asked when an expression key comes into view, on a model load and after an expression hotkey — never polled** — and an answer is kept only for the model it names: `ExpressionStateRequest` answers for whichever model is loaded, whatever model is asked, so the picker and the cache check. **A Model key never asks for the model already loaded**: VTS reloads it, and the avatar drops out |
| `src/services/twitch.ts`, `src/credentials.ts`'s Twitch section | **a refresh token is single-use, and Twitch ends the whole link when a replaced one is sent** (measured): one refresh at a time, shared by the hourly check and every press, and the new pair saved — in one write — before anything uses it. **A refused refresh keeps the link**: Twitch's own faults look the same as a dead link, so the keys are marked, the tokens kept, and the hourly check keeps trying; only Remove or a new link clears it. The link keeps the client ID it was made with. The hourly check runs only while linked, and polling only while linking |
| `src/services/discord.ts`, any Discord `describe()` / `iconState()` | **Discord is the one exception: connected while Discord is running and the active profile has a Discord key on any page**, shown or not, because its handshake has taken up to 20 s, on both its clients, and would otherwise fall on the first press after a page switch. It is not a precedent: not shown-page demand, and no other integration's; **no timer of its own** — retries ride the 60-second scan, and tokens are refreshed only when connecting, one refresh at a time, the new pair saved before use. **A press never waits on the handshake**: not connected, it starts connecting and is refused at once (`StillConnecting`, never marked); keys show the connecting badge meanwhile. **Only `requestAccess` (Settings' Connect) ever asks Discord to authorize**; refused — the authorization revoked and its refresh refused, or the application ID unknown — is never retried until Connect. Key faces read the state cache, fed by `VOICE_SETTINGS_UPDATE` and `VOICE_STATE_*`, never a request in a render; a channel's people are subscribed only while the profile has a User volume key. **A join brings no `VOICE_CHANNEL_SELECT`** (measured), so the cache follows the join's reply. Held by `smoke-discord` |
| `src/services/discord-client.ts` | **no client secret, ever**: each person's application is a public client, and the exchange is proved with PKCE. The handshake's deadline is long (45 s) because READY has taken 20 s (measured) |
| `src/services/vts-client.ts`'s `PLUGIN_NAME` / `PLUGIN_DEVELOPER` | **permanent**: VTS refuses a saved token given for another name or developer, so a change disconnects every user without a word |
| `src/services/text-socket.ts` | offers **no WebSocket extension**: VTS's server compresses whatever a client accepts, and Node's own client misreads it. Messages arrive in 1016-byte fragments and are put back together |
| `src/services/sounds.ts`, `src/actions/sound.ts` | **a sound's player is the daemon's child on purpose** — the one exception to the row below; **its key's face changes only when a player starts or ends**, never on a clock; a loop restarts on the exit, never under 250 ms of play; **a player Deckhand stopped is not a failure** — pw-play exits 1 on SIGTERM, paplay 0 (measured), so it is known by being stopped, not by its code; **a chosen output that is not there fails the press** — pw-play silently plays an unknown target on the default output (measured). Held by `smoke-sounds` |
| `src/services/virtual-power.ts`, the virtual driver's `list()` | **a virtual deck turned off is left out of every scan**, so it closes as an unplugged screen does: helper quit, grab ended, keys let go, nothing at rest; its touchscreen's access kept; **kept off across restarts** in the state directory's `virtual-off.json` — an unreadable file is ignored, never a deck left dark for good. Held by `smoke-virtual-daemon` |
| `src/icon-scale.ts`, `src/render.ts`'s icon layer, `editor/src/renderer/model.ts`'s `iconScale` | **one rule: at 100% the whole image fits the key's box, centred**, the shape cutting what is above it; relative to the key, never the image. A key's own `iconScale` wins; without one **only built-ins** — an action's default, one chosen by name, the missing icon — are drawn at `builtinIconSize`, an image file at 100. The editor's grid draws the same from the same numbers; the slider's mark is the largest scale at which the whole image is inside the shape. Held by `smoke-appearance`, `smoke-defaults`, `check:appearance` and the editor's unit tests |
| `src/icon-fit.ts`, the config's `version` | **a config without `"version": 2` is from before the icon scale**, when a file icon with nothing set was cropped (`iconFit: cover`): the daemon draws it so, in memory, never writing it; the editor converts it when it opens, imports or adopts one — state icons put in today's shape first, so a resting icon kept in its action's old field is sized too; an edit made while an outside file's icons are being read makes that file a conflict, never lost — the crop becomes the scale that keeps the look (`coverScale`, up to 200), `contain` becomes nothing — and writes the version. Without the version, "no `iconScale`" would mean two things. Held by `smoke-appearance` and `appearance.test.ts` |
| `src/deck.ts`'s `pressed`, `src/render.ts`'s `pressedLook` | **Touch feedback is drawn on the touch and on its lift, never on a clock**, a virtual deck's only, while `defaults.touchFeedback` is not false: the face lightened and drawn at 95%, inside its own shape. Every way a touch ends without a lift — a lock, a page or panel change — draws the control at rest. **A face rendered for a touch state that has since changed is never sent**: a quick tap's lift can finish before the press's face, and the pressed face landing after it would stay. A Stream Deck key is never drawn pressed. Held by `smoke-appearance` |
| `src/label-fit.ts`, Settings' Label font (`editor/src/main/fonts.ts`) | **measured label widths are kept per font**, or a font change would cut labels by another face's widths; a font that is not installed falls back to the default in the style itself. **The installed fonts are asked of fontconfig only when Settings opens**, never kept, watched or polled. A font or key colour change is a config reload: each key drawn once. Held by `smoke-appearance`, `appearance.test.ts` and `check:settings` |
| an action's `active()`, `DeckSession.liveFaces()`, `editor/src/renderer/model.ts`'s `faceIcon` | **the editor's grid draws a key with states as the deck draws it**: the daemon's status reports each shown key's state — its built-in's, and whether its active icon applies, two answers because they can differ (Input mode's built-in calls voice activity active; the key calls push-to-talk its active state) — and the grid draws by the deck's rules, only while it shows the page the deck is on. `active()` is the one definition: `describe()` draws by it. A redraw in another state tells the editor — no timer of its own. Before, every such key showed its default state in the grid whatever the deck showed. Held by `smoke-live-faces` and the editor's unit tests |
| `src/drivers/panel-frames.ts`'s `imageFrameParts`, the virtual driver's `draw()` | a key's pixels go to the helper **without a copy**, its header and the cached render in two writes — the copies were ~8.5 MB of garbage on each output return; so a render handed to `draw()` must never be changed afterwards. Held by `smoke-virtual` and `smoke-panel` (the real helper, a frame in two writes) |
| `src/actions/system.ts`'s `launch()`, or anything that starts a program from a deck | **nothing launched from a deck may be the daemon's child.** It goes through `launch()` (`systemd-run --user --scope`); a plain or detached spawn stays in `deckhand.service`'s cgroup, and every stop of the service — each update, a crash restart, logging out — kills it. Not `KillMode=process`: that leaves the helper, `pactl subscribe` and `udevadm monitor` behind |
| `panel/idle.c`, `src/services/idle.ts`, `src/services/desktop-inhibit.ts` | **the compositor counts, never Deckhand**; the plain notification, so its inhibitors keep the decks lit; **and KDE's own inhibitions, which it doesn't count: while powerdevil lists one naming `idle` the helper doesn't run**, followed by the signal, which names the property as invalidated with no value, so each is followed by a read; `sleep` rows don't count; **the helper runs only while dimming is set and a Stream Deck is attached**; a helper that stops rides `recovery.ts`; one that says the protocol is absent is not retried until the settings change. **The re-dim deadline is one-shot, armed only by a press while idle**: cancelled by resumed, restarted by another press, overridden by a lock. Virtual decks are never idle-dimmed. Held by `smoke-sleep` and `smoke-panel` |
| `src/sleep.ts`, `DeckSession.applySleep()` | **only this sets a deck below `clampBrightness`'s 5** — a Brightness key, slider or dial stays 5–100; a level set while asleep is kept and woken to; **a press that only wakes a deck swallows its release too, but a key held down before the sleep is still released**, so nothing stays held; **an unreadable lock state is awake**, the opposite of a touch's. A lock wakes one deck at a press, Sleep all decks all of them. A virtual deck never sleeps on a lock. Held by `smoke-sleep` |
| `panel/panel.c`'s `brightness`, `PanelDevice.setBrightness()`, `panel/wayland.c`'s copy | **the canvas is always drawn at full brightness and dimmed as it is shown** (`dim_out`), so **a change is the level alone**, never a clear and a redraw: a quick drag of a Brightness slider blacked the panel out and fell seconds behind when it was; **each buffer copies only what changed since it was last shown**; **a level is light given off: values are scaled by (level / 100)^(1 / 2.2)** (`LIGHT`, a table), so 5 is dim and lit, never black; **it dims the whole deck, a see-through background included, as black laid over it** — colour and alpha alike move toward opaque black, so what shows through darkens too, and at 0 the screen is opaque black, never clear; a virtual deck is at 100 unless set, never `defaults.brightness`, or every panel would darken on update. Held by `smoke-panel` (real pixels), `smoke-virtual` and `smoke-brightness-drag` (the real helper under a headless KWin: a fast drag, every frame shown checked for black, a missing key or an old level after the lift) |
| `src/services/session-lock.ts`, `src/drivers/virtual.ts`'s touch path | **no touch from a virtual deck runs an action unless logind says the session is unlocked and active**; a state that cannot be read counts as locked; every key held when the lock comes is let go. Reading the device directly bypasses the lock screen, so this is the lock. Held by `smoke-virtual-touch`'s fake logind |
| `src/drivers/virtual.ts`, `src/hit-test.ts` | **the daemon hit-tests, never the helper**; a touch owns the control it started on until it lifts, wherever it lifts; every touch is let go on a lock, a panel change, or the touchscreen or screen going. **A touch is tested on the control's real shape, and the later of two overlapping controls in the panel's list is on top** — geometry carries that order (`z`) because keys are in reading order, which is not it. Held by `smoke-shapes` and `smoke-virtual-touch` |
| `src/value-controls.ts`, `DeckSession`'s value path (`onValue`, `pumpWrites`, `endDrags`) | **a slider or dial takes only an action with a `value`** (Volume, Brightness, User volume), refused by the editor's drop and its main process alike; **its level is read from an event-fed cache and never polled**; **one write in flight, the newest waiting** — never a queue, never a timer; a volume drag skips the cache's re-read until its last write; **every way off a page ends a drag with the value where it is** — a lock, a page change (a page with the same controls too), a panel change, the deck closing; a failed write marks the control and stops that drag's writes. Held by `smoke-values` |
| `panel/panel.c`'s `M`, `panel/evdev.c`'s moves, the virtual driver's `driving` | **the helper reports a finger's movement only for a contact the daemon asked it to follow**, at most once per frame, until it lifts; a follow for a contact not down is ignored, and a new contact in the same slot is not followed. Only the first finger on a slider or dial moves it. A button's touch is down and up only. Held by `smoke-panel` (the real helper) and `smoke-values` |
| `src/value-face.ts`, `src/value-controls.ts`'s built-in art | **layers are drawn once per change of art, label or badge, and put together per value in plain JavaScript** — never a rasterisation per step (measured: ~24 ms a step with sharp against ~2–3 ms); the same value again is the same Buffer, kept per art for a few values, since two controls drawn alike share one art. **`assets/art/` is the generator's output at the design's reference sizes (46 × 130, 76 × 76)**, held equal by `smoke-values`; a built-in is drawn for its box, never stretched; **an image chosen is drawn in its area (`layerArea`): the thumb, knob and base keeping their proportions, the track and background stretched. The level is never an image** — Deckhand draws the fill under the thumb and **the ring over the knob**, so no art hides it. **A slider or dial is a rectangle**; an older round one is made one on load (`migrateValueControls`), as a fill or ring image becomes the drawn level. **A slider's travel is one rule, `sliderTravel`, on the deck and in the editor** — never measured from pixels — and the editor draws every layer over the control's whole box, as the deck does. **A stretched SVG is stretched in the editor too**: an SVG in an `<img>` keeps its own proportions inside whatever box `object-fit` gives it, so the editor's icon protocol serves a stretched layer's SVG inside an outer SVG of its own size that stretches (`stretchedSvg`) — drawn at its size first, as sharp draws it, a viewBox of other proportions keeping its own fit inside, then stretched. Held by `smoke-values`, `check:values` and `check:value-art`, which compares the editor's pixels with the deck's |
| `src/shapes.ts`, `src/render.ts`'s `renderFace` | **each shape answers three questions — inside, outline, largest inner rectangle — and nothing else branches on the shape**: the label, a level and the failed badge go in the inner rectangle, the icon is the square at the shorter side, the fill covers the shape, **and everything outside it is alpha 0**. **A virtual deck's face has its outline (`OUTLINE_PX`) inside the shape's edge**, drawn twice as wide on the edge so the shape's cut leaves the inner half; a Stream Deck's key never has one. Without it, a square key with square corners is `renderButton`'s byte for byte; a Stream Deck's keys never take this path. Held by `smoke-shapes`, `smoke-virtual` and `smoke-panel` (real pixels) |
| `panel/panel.c`'s `draw_image`, `src/drivers/panel-compose.ts` | **the helper puts the background under every image, and an image is clear wherever nothing is drawn**: never blend over the old pixels (a soft edge builds up over itself, a lower control redrawn paints over the upper), and never fill a gap in the daemon (the page's see-through background shows there). The background under an image is the page's, pixel for pixel — its colour, or its picture — at the deck's brightness. A control whose box another overlaps is sent as every control touching it, combined in the panel's order **at the moment it is sent, never when it is queued**: the queue holds controls, not images, or a control queued behind a busy helper carries a face since replaced over the newer one, and nothing redraws it. Held by `smoke-panel` (real pixels), `smoke-shapes` and `smoke-virtual` |
| `src/page-background.ts`, `PanelDevice.setBackground()`, `panel/panel.c`'s ground (`'G'`) | **a page's background is the whole screen's, under every control, and controls never fade**. **Plain black and opaque — every page before backgrounds, and a new page — sends nothing but the canvas frame**, so the helper keeps its opaque `XRGB8888` buffers; below 100% they are `ARGB8888`, premultiplied, and back to `XRGB8888` once opaque again. The background is sent after every canvas frame (which resets it), before the keys; the same background again sends nothing. Its picture is drawn by the daemon at the screen's size on a page change, an edit or the screen coming back — **never on a clock**; a picture drawn for an older background is dropped. **An image is held to PNG, JPEG, WebP, GIF or SVG, 10 MB and 4096 px on its longer side** (`src/image-limits.ts`, one wording for the log and the editor): refused, the colour is shown alone and the log says why, once. Held by `smoke-panel` (real pixels, alpha and buffer formats under a headless KWin) and `smoke-virtual` |
| `editor/src/renderer/BackgroundPanel.tsx`, `PageGround.tsx`, `DeckGrid.tsx`'s key fill | **the editor draws a page's background as the deck does**: behind the keys over the whole screen, an image the limits refuse left out, and **every control on a virtual deck opaque over it, an empty one the plain key face** — the background never shows through a button; a checker stands for what the real screen would show through. **The panel shows the saved background, never the preview**: the opacity is previewed on the page while it moves and saved when let go, and the next change made there must not carry an unsaved one. Black, Fill and 100% store nothing. A Stream Deck has no background icon and draws none. Held by `check:background` and `check:one-deck` |
| `editor/src/renderer/App.tsx`'s Edit layout, `editor/src/main/config-document.ts`'s `setLayout` / `restorePage` | **a layout with no controls is never saved and never shown**: emptied, the page goes back as Edit layout found it and the editor alone shows it empty; Blank saves nothing until its first control; the daemon passes over a hand-written empty panel. **Done sits on the header of the deck being edited, beside the lit Edit layout, in the accent colour** — `check:layout` holds that it is seen at the window's normal size, not merely present. **Every way out of the mode is Done** — Done, the lit button, closing the window, another profile, a deck key changing page or profile — because every change is already saved; the mode ends only when its page or deck is gone, never on a save still on its way. Held by `check:layout` and `layout-edit.test.ts` |
| `editor/src/renderer/useBulk.ts`, `editor/src/shared/bulk.ts`'s `placeOnControls` | **on a custom page a key lands only on a control that exists**: rows and columns mean nothing there, and two controls can share them. A paste goes onto the selected controls, one each, and with none selected pastes nothing; a key dragged from another deck goes onto the control dropped on; Copy to page and Copy to device, which copy to the same places, are refused **whenever either page is custom**. Held by `check:layout` and `bulk.test.ts` |
| `editor/src/main/config-document.ts`'s `setPagePanel` / `setLayout`, `DeckPanel.tsx`'s header | **a page is a grid or custom for its whole life**: Edit layout is offered on a custom page only, Change layout… on a grid page only and only to another grid, and the main process refuses the rest — Change layout…'s edit on a custom page or to a custom panel, and Edit layout's save over a grid page that has keys. A new page started from Blank waits on disk as the deck's default grid, with no keys, until its first control. Held by `layout-edit.test.ts` and `check:layout` |
| `editor/src/shared/layout-arrange.ts` | **the grid and snapping are separate, and Shift ignores both**; snapping, when within reach (6 screen pixels), wins over the grid; **several controls move as one**, stopped where the first meets the canvas's edge, so their places relative to each other never change; align is against the selection's own bounds, match is to the first one selected. Grid, pitch and Snap are editor preferences, never `config.json`. Held by `layout-arrange.test.ts` and `check:layout` |
| `editor/src/shared/templates.ts`, `src/config.ts`'s `validateTemplates` | **a template is a layout and nothing more** — each control's place, size, shape and Lock proportions, at the size of the screen it was saved on; never an action, art or label. Names are unique ignoring case; a name in use is replaced only when asked. **A page from a template is a copy**, not linked, its own canvas kept, scaled to fit another screen, centred. **The editor draws it as the deck does, in the grid and in Edit layout alike** (`layoutScale`): the screen fitted to the frame, then the layout inside the screen — never the layout straight into a frame its header widened. Kept in `config.json` so a backup and an export carry them; the daemon validates them and never reads them otherwise. Held by `templates.test.ts` and `check:layout` |
| `editor/src/shared/layout-edit.ts`'s `resizeBox` / `typedSize` | **Lock proportions holds at a limit**: both sides are scaled by one factor to fit the canvas and the smallest size, never clamped one at a time — a box distorted once becomes the ratio every later edit keeps. Held by `layout-edit.test.ts` |
| `editor/src/renderer/DeckGrid.tsx`'s `placeOf`, `LayoutEditor.tsx` | **a virtual deck's page is drawn where its panel places each key, at its shape, on every page, preset or custom**; a Stream Deck keeps its grid and gets no Edit layout. **Only a custom page (`preset: "free"`) is edited**, and outside the mode nothing changes a layout. Held by `check:layout` and `check:one-deck` |
| `src/panel-presets.ts`'s `pagePanelOf` / `defaultPanelOf` / `migratePagePanels`, `src/drivers/virtual.ts`'s `layoutFrom` | **a virtual deck never attaches with zero keys**: the page's own panel (one with no controls passed over, as if absent), else (a config not yet migrated) its layout's, else the deck's default (`decks[key].virtual.panel`), else a Medium grid for the screen. **Every page made without a choice gets the deck's default**, copied from no other page or profile — a profile made after the deck showed nothing in `v0.8.0`. **The migration keeps every page's grid and keys**: each page takes the panel its profile showed, and a deck without a default is given the one it fell back to; the daemon reads it in memory, the editor saves it once. Held by `virtual-panel.test.ts`, `config-store.test.ts`, `check:virtual` and `smoke-virtual` |
| `src/deck.ts`'s `relayoutFor` / `goToPage` / `goBack` / `reconfigure` | **a page change re-lays out a virtual deck only when the page's controls differ**: a new set is a canvas frame, which clears the screen, then every key; the same set draws only the keys that changed, as before. What was held is let go first, as on any way off a page. Held by `smoke-virtual` and `check:virtual` (the helper's frames) |
| `editor/src/renderer/model.ts`'s `pageGeometry` | **the editor draws a virtual deck's page at that page's grid, from the config**, never the deck's live geometry, which is whatever page the deck shows — Copy to device, a link's key number and the canvas all name pages not shown. A Stream Deck's keys are the daemon's. Held by `virtual-panel.test.ts` |
| `editor/src/renderer/Toolbar.tsx`'s `PageTab` / `AddPage`, `DeckPanel.tsx`'s header | **a Stream Deck's page menu, header and New page are as they were**: Change layout… — in the page tab's menu and as a button in the deck's header — and the grid picker are a virtual deck's only. Held by `check:one-deck` and `check:virtual` |
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
