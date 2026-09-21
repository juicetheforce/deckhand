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
- [The control socket](#the-control-socket)
- [Troubleshooting](#troubleshooting)
- [Developing](#developing)

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
decks that are plugged in: one profile, with one working key on each deck.

Open the editor from your desktop's application menu (**Deckhand**) or with
`deckhand-editor`. Selecting a profile or page in the editor switches the
decks to it; every change is saved as you make it and shows on the deck at
once. Closing the editor's window leaves it in the tray (a setting, on by
default); quit it from the tray menu. Closing it changes nothing on the
decks.

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

  "startProfile": "Gaming"                     // profile ID or name, optional
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
`onRelease` and `refreshMs`. `\n` in a label gives a second line. A button
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
| `media.info` | Live now-playing key, with album art via `showArt` |

Audio keys name the exact device: `node` is its system name, and `label` is
only for showing. If that device isn't present, a press logs it and does
nothing — Deckhand never guesses at a similar device. Network audio outputs
are not offered.

Media actions control whichever player is playing, unless you pin one with
`player: "<name>"`.

A key whose press fails wears a red badge, on the deck and in the editor,
until a press of it succeeds or it is edited. A `command` key without `wait`
is never badged: the press returns before the program could fail.

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
| `subscribe` | `events`: any of `state`, `config`, `audio` | replaces this connection's subscriptions |
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

**`deckhand` says the daemon isn't running.** `systemctl --user status
deckhand`. If the service is up, look for `[control] listening on …` in its
log; if the socket could not be created, the log says why, and the decks keep
working without it.

**The editor doesn't open on Ubuntu.** It needs the AppArmor profile the
installer adds; run the install line again with `bash -s -- install
--reinstall` and read what it reports.

## Developing

The daemon runs from the installed copy, not the checkout. To run it in the
foreground from a checkout, stop the service first — two daemons would fight
over the decks:

```bash
systemctl --user stop deckhand
npm ci
npm start                             # builds, then runs; Ctrl+C to stop
systemctl --user start deckhand       # back to the installed copy
```

The editor develops from `editor/` with `npm start`; quit the installed editor
from its tray menu first. The checks run offline, against fake decks, a fake
input helper and a fake `pactl`: `npm run smoke` at the root, and `npm test`
and the `check:*` scripts in `editor/`. `node editor/scripts/demo.mjs` opens
the real editor on an invented setup, which is where the README's screenshots
come from.

**Adding an action type:** write an object with `execute` and/or `describe`,
add it to the registry in `src/actions/index.ts`, and give it a form in the
editor. `describe` is what makes a key refresh while it is visible — the
clock, now-playing and the active-output highlight all use it — and identical
output is never written to the device.
