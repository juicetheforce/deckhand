# Deckhand reference

The details behind the [README](README.md): installing, the configuration
format, every action, the `deckhand` command, the control socket, and working
on the code. Why things are the way they are is in
[ARCHITECTURE.md](ARCHITECTURE.md).

- [Installing](#installing): [the release install](#the-release-install),
  [the developer install](#developer-install), [building a release](#building-a-release)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Using it](#using-it)
- [The deckhand command](#the-deckhand-command)
- [Configuration](#configuration)
- [Actions](#actions)
- [OBS Studio](#obs-studio)
- [The control socket](#the-control-socket)
- [Troubleshooting](#troubleshooting)
- [Developing](#developing): [running it](#running-it-while-developing),
  [testing](#testing), [traps in the checks](#traps-in-the-checks),
  [environment traps](#environment-traps)

## Installing

### The release install

This is what the README's line does:

```bash
curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash
```

The script is the one attached to the newest release, and it installs that
release. In order, stopping at the first thing that fails, with nothing
changed:

1. **Checks the machine** and names everything missing at once. If a package
   can supply what is missing, it offers one command to install it for your
   distribution — shown in full, run only if you say yes:

   ```
   Some of that can come from this machine's own packages:
     sudo dnf install -y libusb1 pulseaudio-utils
   Run this now? [y/N]
   ```

   It knows apt, dnf and pacman; elsewhere it names what is missing and leaves
   the installing to you. Piped from `curl`, it asks at your terminal; with no
   terminal at all it prints the command and stops.
2. **Downloads** the release's package (about 130 MB) and `SHA256SUMS`.
3. **Checks the download** against `SHA256SUMS`. That catches a corrupted,
   cut-short or wrong file, and that is all it does: the checksums come from
   the same GitHub release as the package, so they do not prove who made it.
4. **Unpacks it and proves it runs here**: the bundled Node starts, the
   device and image libraries load, and the editor's Electron finds its
   libraries.
5. **Installs it**, starts the service, and puts back the previous version
   if the new one does not stay up.

`curl -fsSL …/install.sh | bash -s -- check` runs only step 1 and changes
nothing. Running the line again on the version already installed says so and
stops; `bash -s -- install --reinstall` installs it again.

It installs for your user only:

| What | Where |
| --- | --- |
| The daemon, its Node, the key-injection helper and the editor | `~/.local/share/deckhand/` |
| The systemd user service | `~/.local/share/systemd/user/deckhand.service` |
| The `deckhand`, `deckhand-editor` and `deckhand-uninstall` commands | `~/.local/bin/` |
| The editor's desktop entry and icon | `~/.local/share/applications/`, `~/.local/share/icons/` |
| A udev rule giving your user the decks and `/dev/uinput` | `/etc/udev/rules.d/60-deckhand.rules` |

**`sudo` is asked for only to write the udev rule**, and only when it is
missing or has changed — and, on distributions that restrict unprivileged user
namespaces (Ubuntu 24.04 and later), once to add an AppArmor profile that
lets the editor start. The installer reports whether your user can open
`/dev/uinput` and each connected deck.

#### Requirements

The installer checks all of these.

- An x86_64 machine with glibc 2.28 or newer: any current Fedora, Ubuntu,
  Debian, Arch or RHEL-family distribution. Each release is checked to load on
  AlmaLinux 8, Debian 11 and 12, Ubuntu 22.04 to 26.04, Fedora 44 and Arch
  before it is published.
- libusb 1.0, which the Stream Deck library links against (`libusb1` on
  Fedora, `libusb-1.0-0` on Debian and Ubuntu).
- `pactl`, for the audio keys. That is **pulseaudio-utils** on Fedora, Debian
  and Ubuntu — a machine running PipeWire may still not have the command.
- A desktop session with a systemd user manager and a session D-Bus.
- `curl`, `tar`, `xz` and `sha256sum`, to download and check the package.
- For the editor's tray icon, a panel that hosts StatusNotifierItem icons.
  KDE Plasma does, and so does Ubuntu's GNOME; plain GNOME needs the
  AppIndicator extension. The installer warns when there is none.

It will not fix what no package fixes: `/dev/uinput` missing (`sudo modprobe
uinput`), a desktop that never reaches `graphical-session.target`, a session
with no seat.

### Developer install

Building from source, for working on Deckhand or for a machine a release does
not cover (anything but x86_64):

```bash
git clone https://github.com/juicetheforce/deckhand ~/src/deckhand
~/src/deckhand/scripts/install.sh install
```

It builds from the checkout and installs to the same places as a release. It
refuses a checkout with uncommitted changes, so what runs can always be traced
to a commit. `scripts/install.sh check` prints its preflight and changes
nothing. On top of the release's requirements (bar curl and xz), it needs:

- Node.js 22.12 or newer, from your distribution's packages, at
  `/usr/bin/node` — the service runs the Node the install was built with —
  plus `npm`. If your distribution's Node is older, you need nvm or a
  third-party repository; the installer will not replace it.
- `gcc` and `make`, and your distribution's kernel headers, to build the
  key-injection helper.
- Network access during the install, for `npm ci` and the editor's Electron.

To follow releases from source, clone a tag instead
(`git -c advice.detachedHead=false clone --depth 1 --branch <tag> …`; git
may print `warning: refs/tags/<tag> … is not a commit!`, which is harmless)
and update with `scripts/install.sh upgrade`, which moves the clone to the
newest release tag and installs it.

### Building a release

For maintainers. `scripts/release.sh build <vX.Y.Z>` builds only from a clean
checkout at that annotated tag, from `git archive` of the tag. It uses the
official Node, compiles the key-injection helper on AlmaLinux 8 (glibc 2.28),
and refuses the release if any binary in the package needs a newer glibc or
libstdc++, or if a shipped package carries no licence.
`bash scripts/test/release-ships.sh <vX.Y.Z>` then tests what ships: it loads
the package in containers of the distributions above, pipes its installer,
installs it on the machine, and runs the tests against that install.
`scripts/release.sh publish <vX.Y.Z>` uploads it with `gh`.

## Updating and uninstalling

**Update a release install by running the install line again.** It installs
the newest release, or says the one installed is already the newest.

**Uninstall**, with no network needed:

```bash
deckhand-uninstall          # asks whether to also remove your config
deckhand-uninstall --purge  # removes your config without asking
```

Uninstall removes the service, the installed copy, the commands, the desktop
entry and Deckhand's udev rule. The rule always goes, because it gives every
program you run access to `/dev/uinput`. It also removes
`~/.local/state/deckhand/`, backups included — that is the app's state, not
your config. A developer install is removed the same way; the checkout is
yours to delete.

Day to day:

```bash
systemctl --user status deckhand
systemctl --user restart deckhand
journalctl --user -u deckhand -f      # follow the log
```

## Using it

The first time the daemon starts, it writes a starter configuration for the
decks that are plugged in: one profile, with the Deckhand logo on each deck's
first key. Pressing it opens the editor.

Open the editor from your desktop's application menu (**Deckhand**) or with
`deckhand-editor`. Selecting a profile or page in the editor switches the
decks to it; every change is saved as you make it and shows on the deck at
once. Closing the editor's window leaves it in the tray (a setting, on by
default); quit it from the tray menu. Closing it changes nothing on the
decks.

**Several decks.** With two or more decks plugged in, the editor still opens
showing one. The device menu becomes a list headed **Show in editor**: tick a
deck to show it alongside the others, or click its name to show it alone.
Hidden decks keep working; they just aren't drawn. Shown decks sit on a
canvas: drag one by its top bar to match your desk. It snaps to the other
decks' edges and key columns and rows, and a deck dropped onto another is
placed against the edge nearest the pointer. The padlock in a deck's top bar
fixes it in place. The zoom bar has Fit all, which the editor opens at, and
Reset (100%). Which decks are shown, where they are and which are locked are
remembered, by serial number, in
`~/.local/state/deckhand/editor/preferences.json`, not in the config. Click a
key on any deck to edit it; the page tabs are for that deck, and every other
deck has its own Page menu. Drag a key onto another key of the same deck to
move it (the two swap), or onto another deck to copy it there, replacing
whatever that key held. A copied Go to page key whose page isn't on the other
deck keeps its icon and label and loses the link, and the editor says so.

**Profiles** switch every deck at once. A deck the active profile has no
layout for keeps showing what it was showing, so a small deck can hold a
permanent row of profile keys while a big one changes. Switch with a key on a
deck, in the editor, or from a script: `deckhand profile <name>`.

**Icons** are image files wherever you keep them (PNG, JPEG, WebP, GIF, SVG).
Nothing is copied or imported: the config holds the path, and editing the
file updates the key. A key with an action and no icon draws that action's
built-in icon.

**Your configuration** is `~/.config/deckhand/config.json`. The editor writes
it, and it is plain JSON you can edit by hand ([Configuration](#configuration)).
Save it and the decks update, with no restart. A file that doesn't validate is
refused, and the decks keep the last good one. Every accepted change keeps the
one it replaced in `~/.local/state/deckhand/backups/` — the newest 20, at most
one every five minutes. The editor's settings export the whole configuration,
icons included, and import it on another machine.

**Replacing a deck.** Layouts are keyed by the deck's serial number, so a new
deck — even the same model — starts blank, and the old deck's layouts stay in
the config, out of sight. To move them to the new deck: quit the editor from
its tray menu, find the new serial with `deckhand decks`, and in
`~/.config/deckhand/config.json` replace the old serial with the new one
everywhere it appears (under `decks` and in each profile's `layouts`). Save;
the deck picks it up at once.

## The deckhand command

`deckhand` talks to the running daemon over its control socket. It never
touches the decks or the config file itself.

```bash
deckhand status                     # active profile, decks, whether the last config reload was accepted, where backups are
deckhand decks                      # connected decks: serial, model, keys
deckhand profile Gaming             # switch every deck to a profile, by ID or name
deckhand repaint                    # repaint all decks (or: deckhand repaint <serial>)
deckhand run --deck <serial> '{"type":"hotkey","keys":"ctrl+1"}'   # run an action without saving it
deckhand sinks                      # audio outputs you can pick (* = current default)
deckhand sources                    # audio inputs you can pick
deckhand apps                       # installed applications an app key can open, with their IDs
deckhand obs                        # OBS: connected or not, streaming, recording, which settings are saved
deckhand obs password               # set OBS's WebSocket password, typed or piped in, never an argument
deckhand obs port 4456              # set OBS's WebSocket port, if it isn't 4455
deckhand vts                        # VTube Studio: connected or not, set up or not, the model loaded
deckhand vts connect                # ask VTube Studio for access, and wait for the answer in its window (a port after it, if not 8001)
deckhand vts hotkeys                # every model's hotkeys, each as a vts.hotkey action to paste into the config
deckhand vts remove                 # forget VTube Studio's access
deckhand watch                      # print changes as they happen, until Ctrl+C
deckhand raw '<request>'            # send one request as JSON and print the reply
```

Add `--json` to any of them for the daemon's raw reply. `deckhand profile …`
is what a game's launch script or a desktop keyboard shortcut should call.
Exit codes: 0 success, 1 the daemon refused the request, 2 wrong usage, 3 the
daemon isn't running or didn't answer.

`deckhand run` sends real keystrokes to whatever window has focus. Anything it
holds down is released when the action finishes, and only one such action runs
at a time, so a script flooding it can't hold up a key press on a deck.

## Configuration

The editor covers all of this; the format is here for hand-editing and
scripts. `config.example.json` shows a complete file — its serials and audio
`node` names are placeholders.

```jsonc
{
  "defaults": { /* background, labelColor, labelSize, labelPosition,
                   iconFit, brightness, refreshMs */ },

  "decks": {                                   // hardware settings, optional
    "<serial>": { "name": "XL", "brightness": 70 }
  },

  "profiles": {
    "<profile ID>": {
      "name": "Gaming",                        // optional
      "layouts": {                             // what each deck shows in this profile
        "<serial>": {
          "startPage": "Combat",               // page ID or name, optional
          "pages": {
            "<page ID>": {
              "name": "Combat",                // optional
              "buttons": { "0": { /* button */ } }
            }
          }
        }
      }
    }
  },

  "startProfile": "Gaming",                    // profile ID or name, optional
  "notifications": false                       // desktop notifications for failed keys; on unless false
}
```

**IDs and names.** Profiles and pages are keyed by ID. Anything that points at
one — `startProfile`, `startPage`, and the `profile` and `page` actions —
matches the ID first, then the `name`. Two pages in one layout, or two
profiles, can't share a name, and a name can't be another entry's ID. A deck
with no layout in any profile is not used. The daemon always starts on
`startProfile` (or the first profile), and a profile switch sends each deck to
its layout's start page.

**Buttons** are keyed by index as a string: 0 is top-left, counting across
rows. A button takes `icon`, `iconFit` (`cover` or `contain`), `label`,
`labelColor`, `labelSize`, `labelPosition`, `background`, `action`,
`onRelease` and `refreshMs`. `\n` in a label gives a second line. A line
too wide for the key is cut and ends in `…`, each line on its own, so a
short second line stays whole under a long first one. A button
index past the deck's last key is accepted and never shown; the editor never
writes one.

**`icon`** is left out for the action's built-in icon (a key with no action
stays blank), `null` for no icon, a path to an image file, or
`"builtin:<name>"` for one of the icons in `assets/icons/`. An icon that
can't be drawn shows a dashed "missing" icon.

## Actions

| type | what it does |
| --- | --- |
| `hotkey` | `keys: "ctrl+alt+3"`, or an array for a sequence. Also `holdMs`, `repeat`, `gapMs` |
| `toggle` | `keys` — latches: one press holds the keys down, the next releases them. `iconOn` / `iconOff` |
| `keyHold` | `keys`, `state: "down"` / `"up"` — pair with `onRelease` for push-to-talk |
| `text` | Types a literal string (US layout) |
| `command` | `command: "sh string"` or `exec: ["bin", "arg"]`. Started in its own systemd scope, so it outlives the daemon; with `wait: true` it runs as the daemon's child for up to 15 s, and a failure marks the key |
| `app` | `app: "<desktop file ID>"` (from `deckhand apps`, e.g. `org.gimp.GIMP.desktop`) — opens an installed application through its desktop entry, with `gio launch`, in its own systemd scope. With no icon of its own, the key shows the app's icon from your icon theme; a dimmed grid means no app is chosen yet |
| `editor` | Opens Deckhand's editor, or brings it to the front if it is already open. Its default icon is the Deckhand logo; every deck starts with one on its first key |
| `multi` | `steps: [...]`, each optionally with `delayMs` — a pause after that step |
| `page` | `to: "<page ID or name>"` or `back: true`. Pages on the same deck and profile |
| `profile` | `to: "<profile ID or name>"` — switches every deck |
| `brightness` | `value` or `delta`; `showLevel: true` shows the level |
| `clock` | Shows the time |
| `noop` | Deliberately blank |
| `audio.sink` | `node` (from `deckhand sinks`), `label` — sets the default output and moves playing streams to it. Highlights when active |
| `audio.cycle` | `devices: [{ node, label }, …]` — steps through outputs from one key |
| `audio.source` | `node` (from `deckhand sources`), `label` — sets the default input and moves recording streams to it. Highlights when active |
| `audio.cycleSource` | `devices: [{ node, label }, …]` — steps through inputs from one key |
| `audio.micMute` | Toggles the default input's mute; `iconMuted` / `iconUnmuted` |
| `audio.volume` | `delta: 5` (or `-5`); `showLevel: true` shows the level |
| `audio.mute` | Toggles output mute; `iconMuted` / `iconUnmuted` |
| `media.control` | `method: playpause \| next \| previous \| stop \| play \| pause`; `iconPlaying` / `iconPaused` |
| `media.info` | Live now-playing key, with album art via `showArt`. `maxChars` cuts the title and artist at a number of characters instead of at the key's width |
| `obs.stream` | Goes live in OBS on a press; stops only when held for a second. Red while live, amber with broken arcs while OBS reconnects |
| `obs.record` | Starts and stops recording in OBS. Red while recording, amber while paused |
| `obs.recordPause` | Pauses and resumes OBS's recording |
| `obs.scene` | `scene: "<name>"` — switches OBS's program scene. Lit while that scene is on air |
| `obs.mute` | `input: "<name>"` — mutes and unmutes one of OBS's audio inputs: OBS's own mute, not the system's (that is `audio.micMute`) |
| `obs.source` | `scene`, `source` — shows and hides a source in one scene. A source in the scene twice: the first |
| `vts.hotkey` | `model`, `hotkey` (IDs) — runs one of a model's hotkeys in VTube Studio, as set up there. Dashed while another model is loaded |
| `vts.expression` | `model` (ID), `expression` (its file, e.g. `EyesLove.exp3.json`) — turns an expression on and off. Lit while it is on |
| `vts.model` | `model` (ID) — loads a model in VTube Studio. Lit while it is loaded |

Audio keys name the exact device: `node` is its system name, and `label` is
only for showing. If that device isn't present, a press logs it and does
nothing — Deckhand never guesses at a similar device. Network audio outputs
are not offered.

Media actions control whichever player is playing, unless you pin one with
`player: "<name>"`.

**Open an app, then switch to its profile** is a `multi` key with a pause
after the app step:

```json
{ "type": "multi", "steps": [
  { "type": "app", "app": "org.gimp.GIMP.desktop", "delayMs": 4000 },
  { "type": "profile", "to": "GIMP" }
]}
```

The pause is a fixed guess at how long the app takes to appear; tune it by
using it. Deckhand does not watch for the window, which would need
something specific to each desktop. The profile switches even if the app
failed to start, and nothing on the deck shows the wait: a second press
during it opens a second copy. Other keys work during the pause.

A key whose press fails wears a red badge, on the deck and in the editor,
until a press of it succeeds, it is edited, or you clear it: select it in the
editor, which says why its last press failed, and press **Clear**. A
`command` key without `wait` is never badged: the press returns before the
program could fail.

When the failure's message says what to do (hold Stream to stop it, start
OBS, nothing is recording, connect VTube Studio again), a desktop notification says it too, through your
desktop's notification service. Once per message: pressing the same key
again with the same failure doesn't notify again, and a new message replaces
that key's last notification. Turn them off in the editor's
**Settings › Notifications**, or with `"notifications": false` in the config.

## OBS Studio

Deckhand is a client of OBS's WebSocket server (obs-websocket 5, built into
OBS since version 28). It works with OBS from your distribution or from
Flathub: both listen on this computer's network, which Deckhand reaches at
`127.0.0.1`.

**Setting it up.** In OBS, **Tools › WebSocket Server Settings**: tick
**Enable WebSocket server**, which is off by default. **Show Connect Info**
has the port (4455 unless you changed it) and the password. Then, in
Deckhand's editor, **Settings › Integrations › OBS Studio**: the host
(`127.0.0.1` for this computer), the port and the password. **Test
connection** tries them without saving and says which thing is wrong: OBS
not running, its WebSocket server off (told apart by whether an OBS process
is running on this computer; for another host it can't tell the two apart),
the password, or no password where OBS asks for one. **Save** sets OBS up and
connects once. If OBS isn't running, that's fine: the keys connect when it
is. For an OBS with authentication turned off, leave the password empty
(**Remove the saved password** clears one saved before).
`deckhand obs password` and `deckhand obs port` set the same things from a
terminal.

**Use a strong password.** OBS's WebSocket server listens on every network
interface, IPv4 and IPv6, with no option to listen on this computer alone, so
the password is the only thing between your network and OBS.

**Where it's kept.** `~/.local/state/deckhand/credentials.json`, readable
only by you (mode `0600`), outside the config directory. It is never in
`config.json`, an export or a backup, and the control socket never returns
it, only whether one is set. An export restored on another machine brings its
OBS keys without the password: they show that OBS isn't set up until it is.

**When it's connected.** Only while a deck shows a page with an OBS key on
it, or a press is waiting on OBS. Once connected, the keys follow OBS's own
events, so a change made in OBS's window shows on the deck. If OBS isn't
running, the next try is within a minute, or straight away when an OBS key is
pressed. A password OBS refused is not retried until it is changed.

**Not set up.** With no saved connection, OBS keys are drawn dimmed with a
grey plug badge, and the editor's OBS actions can't be placed: hovering says
why, and clicking opens Settings at OBS. Pressing such a key notifies once.
**Remove** in Settings disconnects and deletes the saved connection; it
removes no keys, which come back as soon as OBS is set up again.

**The keys.** Stream starts on a press and stops only on a hold of one
second: a quick press while live fails, marks the key and says to hold it,
so a stray tap can't end a stream. Stream and Record turn red only once OBS
says the output started. If it doesn't within 5 seconds (no stream service
set up in OBS, say: OBS shows its own error and tells Deckhand nothing), the
key stays off and is marked, saying OBS's window has the reason. A
connection slower than that is marked too, and still turns red when OBS
goes live. From `deckhand run` or the control socket,
which have no hold, Stream only starts. Pause recording is for recordings,
not streams, and OBS can't pause a recording that shares the stream's encoder
(**Settings › Output › Recording Quality** "Same as stream", OBS's default in
Simple mode); the key is marked and says so rather than doing nothing. Scene,
Mute input and Show/hide source name what they act on, and the editor offers
only what OBS lists, so OBS must be running to choose. Their icons are the
same for every key of a type, so give each a label.

**Known gaps.**

- **Studio mode.** A Scene key switches the program scene directly, skipping
  the preview.
- **Sources inside a group** aren't offered for Show/hide source.
- **Renames.** Keys name scenes, inputs and sources, so renaming one in OBS
  breaks the keys that use it. A press is marked with the missing name, and
  the editor shows the saved name as "not in OBS now" until you choose again.
  Deckhand never rewrites your config to follow a rename.

## VTube Studio

Deckhand is a plugin client of VTube Studio's API, at `127.0.0.1`, port 8001
unless you changed it. VTube Studio is a Windows program; it was tested from
Steam under Proton, version 1.35.

**Setting it up.** In VTube Studio's settings, turn on **Allow Plugin API
access**. Then, in Deckhand's editor, **Settings › Integrations › VTube
Studio**: **Connect**. VTube Studio shows a window asking whether to allow
"Deckhand" (by "Open-source contributors"); it may open behind other
windows. Allow it, and VTube Studio gives Deckhand a token, which is what
"set up" means. If Connect can't reach VTube Studio, it listens for a few
seconds for the announcement VTube Studio broadcasts on this computer's
network, to say whether it isn't running, its API is off, or it is on
another port, and fills in that port. `deckhand vts connect` does the same
from a terminal.

**Only Connect asks.** No key, reconnect or restart ever asks VTube Studio
for access, so its window can't appear by itself in the middle of a stream.
There is no Cancel: closing the request doesn't take VTube Studio's window
back, so answer it there. Deny it, and Connect asks again next time.

**Revoked access.** If you remove Deckhand in VTube Studio's plugin list,
its keys are marked and a notification says to connect again; Deckhand
doesn't ask again until you press Connect. **Remove** in Settings forgets
the token and removes no keys; Deckhand stays in VTube Studio's plugin list
until you remove it there.

**Where it's kept.** The token is in the same file as the OBS password,
`~/.local/state/deckhand/credentials.json`, readable only by you, and never
in `config.json`, an export or a backup. VTube Studio's API listens on every IPv4
network interface, and the token is the only thing protecting it.

**When it's connected.** As for OBS: only while a deck shows a page with a
VTube Studio key on it, or a press is waiting. The keys follow VTube Studio's
own events. If it isn't running, the next try is within a minute, or straight
away when a key is pressed. With no token saved, its keys are dimmed with a
grey plug badge and never connect, and the editor's VTube Studio actions
can't be placed: clicking one opens Settings at VTube Studio.

**Built around the model you're using.** Most VTubers use one main model,
sometimes a second; Deckhand plans for that, and does the simplest honest
thing beyond it:

- A key for another model works once that model is loaded. A Trigger hotkey
  key for it is drawn dashed until then; a Toggle expression key keeps its
  usual face. A press of either is marked and says which model it needs.
  Neither ever falls back to a hotkey or expression of the same name in the
  model that is loaded.
- The expression picker lists the loaded model's expressions only. Choose
  another model and it says to load it in VTube Studio first.

**Trigger hotkey or Toggle expression.** Both can turn an expression on and
off, and they are not the same:

- **Trigger hotkey** runs one of the model's hotkeys as it is set up in VTube
  Studio: its fade time, its sounds, an auto-off after some seconds. It
  doesn't show any state: VTube Studio doesn't say what a hotkey did.
- **Toggle expression** turns the expression on or off directly, with VTube
  Studio's default fade, and lights the key while the expression is on. It
  reads the expression's state before a press, so the press always flips it.

For plain on and off with the state on the key, use Toggle expression; to
keep what the hotkey adds, use Trigger hotkey. Expressions are picked by
file, shown with the hotkey that uses them: "EyesLove (Heart Eyes)".
Hotkeys and models are stored by VTube Studio's IDs, never by name, so a key
never runs the wrong thing.

**The Model key** waits for VTube Studio to say the model has loaded, a
second or two, before lighting, and is marked if it doesn't. VTube Studio
loads at most one model every two seconds; a press inside that is marked.
A press for the model already loaded does nothing, because VTube Studio
would reload it and the avatar would drop out of the stream.

**Known gaps.**

- **An expression changed without a hotkey, on VTube Studio's stable
  version.** Only its beta reports expression changes as events. On stable,
  Deckhand re-reads the expressions when a key comes into view, when a
  model loads, and after any expression hotkey, which covers VTube Studio's
  own window and keyboard shortcuts, since those go through the model's
  hotkeys. A change made another way, by another plugin say, isn't seen
  until one of those happens, and a Toggle expression key shows the old
  state until then. Deckhand doesn't poll to catch it.
- **Deleted in VTube Studio.** Keys name models and hotkeys by VTube
  Studio's IDs, and expressions by file. One deleted, or an expression's
  file renamed, marks the keys that use it, saying to choose it again in the
  editor.

## The control socket

`$XDG_RUNTIME_DIR/deckhand.sock`, mode `0600`: only your user can connect.
Newline-delimited JSON over a stream socket. Protocol version 1, reported by
`status`.

A request is one line:

```json
{"id": 1, "cmd": "profile.switch", "args": {"to": "Gaming"}}
```

`id` is a string or a number, echoed in the reply; requests on one connection
run concurrently and replies are matched by it. `args` is optional. A reply is
`{"id": 1, "ok": true, "result": {…}}` or
`{"id": 1, "ok": false, "error": {"code": "…", "message": "…"}}`.

| cmd | args | does |
| --- | --- | --- |
| `status` | | active profile, every deck, the config's last reload, backups |
| `decks` | | connected decks: serial, model, geometry, unsupported controls |
| `repaint` | `serial` (optional) | redraws one deck, or all |
| `profile.switch` | `to` | switches every deck to a profile, by ID or name |
| `action.run` | `serial`, `action`, optional `onRelease` and `holdMs` | runs an action as if pressed on that deck, without saving it |
| `audio.sinks`, `audio.sources` | | the devices an audio key can name, and the current default |
| `apps` | | the installed applications an app key can open: ID, name, and icon file (null when the theme has none). Reads the disk afresh |
| `failure.clear` | `serial`, `profile`, `page`, `key` | clears one key's failed badge |
| `obs.status` | | OBS: whether it is set up, the connection, stream and recording, host and port, and whether a password is set — never the password |
| `obs.credentials` | any of `host`, `port`, `password`; `null` removes one | saves them (which sets OBS up), then tries once to connect; replies as `obs.status`, with `attempt` |
| `obs.test` | optional `host`, `port`, `password` (missing ones: the saved) | tries to connect and lets go; says which thing is wrong. Saves nothing |
| `obs.list` | `kind`: `scenes`, `inputs` or `sources`; `scene` for sources | what OBS lists, in its own order; audio inputs only |
| `obs.remove` | | deletes OBS's saved connection and disconnects. Keys are untouched |
| `vts.status` | | VTube Studio: whether it is set up, the connection, the model loaded, the port, and how the last Connect went — never the token |
| `vts.connect` | optional `port` | asks VTube Studio for access and replies at once; how it goes arrives as `vts` events, since it waits for someone to answer VTube Studio's window |
| `vts.list` | `kind`: `models`, `hotkeys` or `expressions`; `model` (ID) for the last two | what VTube Studio lists; expressions for the loaded model only |
| `vts.remove` | | forgets the token and disconnects. Keys are untouched |
| `subscribe` | `events`: any of `state`, `config`, `audio`, `obs`, `vts` | replaces this connection's subscriptions |
| `preview.set`, `preview.clear` | | the editor's unsaved previews on a deck; cleared when its connection closes |

After `subscribe`, events arrive as `{"event": "state", "data": {…}}`. No
snapshot is sent on subscribing: subscribe first, then ask for `status`, and
no change can fall between the two.

Error codes: `bad_json`, `bad_request`, `unknown_command`, `not_found`,
`deck_not_connected`, `busy`, `action_failed`, `render_failed`,
`line_too_long`, `too_many_connections`, `internal`. A line may be at most
64 KiB, and at most 16 clients may be connected at once. Nothing in the daemon
waits on a client: one that stops reading is disconnected.

## Troubleshooting

**Which version is installed.** The editor's **Settings › About** shows it:
a release's tag, or `git describe` for a developer install. It can be
selected and copied into an issue. **Releases on GitHub** there opens the
releases page, where every release and its installer are listed; Deckhand
itself never checks for updates. To update, run the install line again.

**Deck not found.** `deckhand decks` lists what the daemon can see. If a deck
is missing, run the install line again with `bash -s -- install --reinstall`
(or `scripts/install.sh update` in a developer install), which reinstalls the
udev rule if needed and reports access per device, then replug the deck.

**Keys do nothing.** Look for `[input] virtual keyboard ready` in
`journalctl --user -u deckhand`. If it's missing, `/dev/uinput` isn't
accessible; the install script's access report says so directly. If the
device doesn't exist at all, `sudo modprobe uinput`.

**An audio key doesn't change anything.** `journalctl --user -u deckhand` says
why: a device that is not present, or a switch the audio server refused.
Compare the key's device with `deckhand sinks` or `deckhand sources`.

**Media keys do nothing.** `busctl --user list | grep mpris` — if nothing is
listed, your player isn't exposing MPRIS.

**OBS keys do nothing.** `deckhand obs` shows whether OBS is set up and
connected. **Settings › Integrations › OBS Studio › Test connection** says
which thing is wrong. The most common one: OBS's WebSocket server is off by
default (**Tools › WebSocket Server Settings › Enable WebSocket server**). A
key badged after a rename in OBS needs its scene, input or source chosen
again in the editor.

**VTube Studio keys do nothing.** `deckhand vts` shows whether it is set up
and connected. **Settings › Integrations › VTube Studio › Connect** says
which thing is wrong: VTube Studio not running, **Allow Plugin API access**
off in its settings, or another port. A key for a model that isn't loaded
is marked and says which model it needs; load that model in VTube Studio.

**`deckhand` says the daemon isn't running.** `systemctl --user status
deckhand`. If the service is up, look for `[control] listening on …` in its
log; if the socket could not be created, the log says why, and the decks keep
working without it.

**The editor doesn't open on Ubuntu.** It needs the AppArmor profile the
installer adds; run the install line again with `bash -s -- install
--reinstall` and read what it reports.

## Developing

Read [ARCHITECTURE.md](ARCHITECTURE.md) first, including its invariants: several
decisions look wrong until you know what they were measured against.

### Running it while developing

The daemon runs from the installed copy in `~/.local/share/deckhand`, not from
the checkout; code changes reach it through `scripts/install.sh update`,
which refuses a dirty checkout and rolls back if the new copy does not stay
up. To run it in the foreground from a checkout, stop the service first —
two daemons would fight over the decks:

```bash
systemctl --user stop deckhand
npm ci
npm start                             # builds, then runs; Ctrl+C to stop
systemctl --user start deckhand       # back to the installed copy
```

The editor is its own package in `editor/` and develops from there with
`npm start`. Quit the installed editor from its tray menu first: both use the
same state directory, and so the same single-instance lock.

### Testing

Everything runs offline, and should be preferred over guessing. `npm run
smoke` at the root drives fake decks; `scripts/smoke-socket.mjs` (part of it)
drives the control socket over a real socket, with
`scripts/test/fake-input-helper.mjs` (the helper's protocol and timing, no
uinput) and `scripts/test/fake-pactl.mjs` on `PATH` (with `FAKE_PACTL_STATE` it
remembers presses, mutes and absent devices). `scripts/test/fake-mpris-player.mjs`
puts a fake player on a private bus (`scripts/smoke-mpris.mjs` re-runs itself
under `dbus-run-session`). `scripts/test/fake-gio.mjs`,
`fake-gsettings.mjs` and `fake-systemd-run.mjs` stand in for the programs an
app key uses (`scripts/smoke-apps.mjs`). `scripts/test/no-decks.mjs` and
`scripts/test/fake-decks.mjs` give a child process no decks, or decks a test
can plug and unplug while the daemon runs.

The checks:

- Root: `npm run smoke`, which includes `smoke-first-run.mjs`: the daemon
  started with no config and two decks, and the starter key it writes.
- `editor/`: `npm test`, and `npm run check:shared`, `check:bridge`,
  `check:live`, `check:hotkey`, `check:icons`, `check:panes`,
  `check:structure`, `check:navigate`, `check:bulk`, `check:forms`,
  `check:tray`, `check:settings`, `check:titlebar`, `check:failures`,
  `check:backup`, `check:empty`, `check:one-deck`, `check:multi-deck`,
  `check:obs` — real
  Electron against a test harness for the control socket.
- **`check:one-deck` runs before every commit touching `editor/` or `src/`**,
  through `scripts/hooks/pre-commit`, once a clone has run `git config
  core.hooksPath scripts/hooks`. With one deck connected the editor must be
  exactly the one-deck editor — one grid, the plain Device dropdown, no
  multi-deck element — and most people have one deck. It checks the working
  tree, so stage everything a change needs.
- The installer, each with `bash`: `scripts/test/desktop-entry.test.sh` (the
  desktop entry and icon, against a scratch HOME), `preflight.test.sh`
  (against stub commands), `apparmor-profile.test.sh`, `upgrade.test.sh`
  (against a local origin), `uninstaller.test.sh`, `pipe.test.sh` (the script
  piped into bash, as `curl … | bash` runs it, at a terminal and without one),
  `release-install.test.sh` (a release's download, checksum and unpack, every
  way it can be wrong), `release-glibc.test.sh` (the release build's glibc
  check) and `udev-trigger.test.sh` (re-applying the rule, with uinput loaded
  and not). `scripts/install.sh check` runs the preflight for real and changes
  nothing.
- A built release: `scripts/test/release-ships.sh <version>` loads it in
  containers of the target distributions, pipes its installer, **installs it
  on this machine**, and runs the suites against that install.

**When a test passes first time, break the code on purpose and check it
fails.** That has caught weak checks many times. **Before a break runner's
failures mean anything, run it on unbroken source and see it pass.** A runner
that cannot resolve the test's imports, or builds the wrong file, prints
nothing and exits non-zero, and "no failures" then reads exactly like a
passing break. A break runner is untested code too: **restore from a copy
of the file and compare checksums**, never by reversing the replacement — a
short replacement reversed lands on its first match anywhere in the file.

For looking rather than checking: `node editor/scripts/screenshot.mjs --out
x.png` renders the editor to a PNG; `node editor/scripts/empty-state.mjs
--state <name>` opens a real editor window in any of the states of "nothing to
show" (`daemon-down`, `never-configured`, `all-unplugged`, `no-layout`,
`deck-unplugged`, and `normal` as the control), against a scratch config,
state directory and socket; `node editor/scripts/demo.mjs` opens it on an
invented setup under its own `HOME` and a private session bus, with a fake OBS
— the README's screenshots come from it: `--view multi` (both decks on the
canvas), `--view obs` (a page of OBS keys) and `--view settings`. Closing the demo's window reopens the editor on the
same state, to see what it remembers across a restart. Ctrl-C to finish either
window.

### Traps in the checks

Each has been hit more than once.

- **Judge a run by its exit code, never by the tail of its output.** Editor
  `npm test` runs several files; the last one printing "all checks passed" can
  hide failures in an earlier one. And **run `tsc` first**: it emits output
  despite type errors, so a green smoke run after a failed `tsc` proves
  nothing.
- **The editor's checks run the daemon from the root `dist/`.** An
  `npm run check:*` in `editor/` builds the editor, not the daemon: after
  changing `src/`, run `npm run build:ts` at the root first, or the check
  drives the old daemon and fails for a reason that is not the code.
- **After a deliberate break, rebuild before the next clean run.** A break
  runner that restores the source leaves `dist/` built from the break. A break
  that fails to build is not a pass either.
- **An `async` function passed to a synchronous `check()` can never fail the
  run.** The helper gets a Promise back and prints PASS; the assertions run
  later, detached. Make the helper `async` and `await` the function, or keep
  the check body synchronous.
- **A hidden check window has no focus, and React listens for `focusout`.**
  `focus()` and `blur()` dispatch nothing there, so a check driving a field's
  "saves when you leave it" path with them tests nothing. Dispatch `focusin`
  and `focusout` instead.
- **Hidden windows deliver no `ResizeObserver` callbacks, never finish lazy
  `<img>` loads, and cache icon URLs.** A check that depends on any of them
  passes or fails for the wrong reason.
- **Editor checks must never touch an installed daemon or the real session
  bus.** They point `DECKHAND_SOCKET`, `DECKHAND_CONFIG_DIR` and
  `DECKHAND_STATE_DIR` at scratch paths. The daemon the control harness
  runs in-process takes its own `DECKHAND_STATE_DIR` — where
  `credentials.json` lives — and gets a scratch one unless the script set
  it. A check window is never shown, on every path that opens one, or it
  takes the desktop's keyboard mid-run. Electron's startup asks the session
  bus for the desktop portal, starting services that outlive the run — why
  `screenshot.mjs` uses a bus config with no service directories.
- **No test connects to OBS's default port, 4455.** A real OBS on the
  machine may be listening there, and the test then talks to it — and
  passes or fails on what that OBS says. Tests use the fake's own port, or
  one taken and let go (`freePort`) for "nothing listening".
- **`inPage` sends a page script as one line**, so a `//` comment in it
  swallows everything after it; the script then "failed to execute" with no
  message. Use `/* */`, or keep comments outside the string.
- **`elementFromPoint` finds nothing off-screen.** A pointer drag from a
  library row below the fold of its pane never starts, so "the drop placed
  nothing" passes whether or not the code blocked it. Scroll the row into
  view, and check the press lands on it before trusting the result.
- **Electron's helpers write to its user-data directory for a moment after it
  exits**, so removing a check's scratch directory can meet `ENOTEMPTY`; the
  checks retry the removal.

### Environment traps

- **Never run `npx <tool>` for a tool that should come from the project.**
  Outside a project, or with a typo, `npx` does not fail: it fetches
  whatever package on the registry has that name and runs it. `npx tsc`
  outside the repository fetches the package called `tsc` — not TypeScript
  — and executes its code. Use the project's own binary:
  `./node_modules/.bin/tsc` (or the `npm run` script that wraps it). If
  `npx` is unavoidable, `npx --no-install <tool>` fails rather than fetch
  (`[confirmed]` on npm 11.16.0) — **but only if `~/.npm/_npx` does not
  already hold a package of that name**: one fetched before runs without
  asking. Clear `~/.npm/_npx` after any accidental fetch. `npx --no tool
  --flag` is no substitute: on npm 11 it answered `--version` with npm's own.

- **A shell inside VS Code has `ELECTRON_RUN_AS_NODE=1`**, which makes the
  Electron binary plain Node with no `BrowserWindow`. `npm start` and
  `editor/scripts/lib/run-electron-check.mjs` clear it; any new way of
  launching Electron must too.
- **On a machine that restricts user namespaces, a green editor check says
  nothing about whether the editor starts there.** Ubuntu 24.04 and later set
  `kernel.apparmor_restrict_unprivileged_userns = 1`, and Electron aborts
  without a namespace (`FATAL:setuid_sandbox_host.cc:166`). **But a shell
  inside VS Code carries VS Code's AppArmor profile, which grants one** — so
  `npm start` and every `check:*` pass there while the same command from a
  plain terminal, or from the user manager, fails. Check
  `/proc/<pid>/attr/current` before believing any Electron launch on such a
  machine, or run it through `systemd-run --user --wait --collect --pipe` for
  an unconfined one. The installed editor is covered by
  `apparmor/deckhand-editor`; the checkout's `editor/node_modules/electron`
  deliberately is not, so development on such a machine does not work and is
  not meant to.
- **Never pipe the daemon's output into `head`** (or anything that exits
  early). When the reader goes away, the next `console.log` throws `EPIPE`,
  the `uncaughtException` handler in `src/index.ts` logs it to the same broken
  pipe, and it recurses: 100% of a core, and `SIGTERM` will not stop it
  because `shutdown()` starts with a `console.log`. It looks exactly like a
  spin bug in the daemon and is not one. Redirect to a file and read that.
  Under systemd stdout is the journal, so the installed service cannot hit it.
- **`grep -q` at the end of a pipe under `pipefail` can read as "not found".**
  `grep` exits at its first match, the writer dies of SIGPIPE, and the
  pipeline fails. Capture the output first, then search it (the install
  script's libusb check was bitten by exactly this).

### Style

Boring and legible beats clever: one person maintains this, long after the
change that wrote it. Prefer explicit over concise. Keep human-readable key
names in `src/keymap.ts`, so the C helper never has to change.

**Adding an action type:** write an object with `execute` and/or `describe`,
add it to the registry in `src/actions/index.ts`, and give it a form in the
editor. `describe` is what makes a key refresh while it is visible — the
clock, now-playing and the active-output highlight all use it — and identical
output is never written to the device.
