# Deckhand

A Stream Deck daemon and editor for Linux. It does hotkeys, audio device
switching, media control, pages and profiles — and it keeps doing them while
you're in a game.

- **Keys that games see.** Keystrokes come from a virtual keyboard at the
  kernel's input layer, so they reach games — including games under Wine —
  the same way a real keyboard's do, with no permission prompts.
- **A daemon that stays up.** It runs as a `systemd --user` service,
  separate from the editor: a hung or closed editor cannot stall a key.
- **An editor** for everything: pages, profiles, icons, and every action,
  with changes showing on the decks as you make them.
- **Any Stream Deck with LCD keys.** Key count and icon size come from the
  device. Several decks at once, each with its own layout.

Tested on Fedora 44 (KDE Plasma, Wayland) and Ubuntu 26.04 (GNOME, Wayland),
with a Stream Deck XL and a Stream Deck Original V2 attached together. Other
distributions and models should work; they haven't been tried.

Why it is built the way it is: [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

One command, from a terminal, as your normal user:

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/juicetheforce/deckhand ~/.local/src/deckhand && ~/.local/src/deckhand/scripts/install.sh install
```

That clones the release into `~/.local/src/deckhand` and runs its install
script. Keep the clone: updating and uninstalling run from it.

The script checks the machine first. If something is missing, it names
everything missing at once and offers one command to install it for your
distribution — shown in full, run only if you say yes:

```
Some of that can come from this machine's own packages:
  sudo dnf install -y make gcc pulseaudio-utils
Run this now? [y/N]
```

`~/.local/src/deckhand/scripts/install.sh check` prints the same report and
changes nothing. The script knows apt, dnf and pacman; elsewhere it names what
is missing and leaves the installing to you.

It then builds Deckhand and installs it for your user only:

| What | Where |
| --- | --- |
| The daemon, the key-injection helper and the editor | `~/.local/share/deckhand/` |
| The systemd user service | `~/.local/share/systemd/user/deckhand.service` |
| The `deckhand` and `deckhand-editor` commands | `~/.local/bin/` |
| The editor's desktop entry and icon | `~/.local/share/applications/`, `~/.local/share/icons/` |
| A udev rule giving your user the decks and `/dev/uinput` | `/etc/udev/rules.d/60-deckhand.rules` |

**`sudo` is asked for only to write the udev rule**, and only when it is
missing or has changed — and, on distributions that restrict unprivileged user
namespaces (Ubuntu 24.04 and later), once to add an AppArmor profile that
lets the editor start. The script starts the service, enables it with your
desktop session, and reports whether your user can open `/dev/uinput` and each
connected deck. If the new copy doesn't stay running, it puts the previous
installation back and shows the log.

### Requirements

The install script checks all of these; the list is here so you can read it
first.

- Node.js 22.12 or newer, from your distribution's packages, at
  `/usr/bin/node` (the service runs that path), plus `npm`.
- `gcc` and `make`, and your distribution's kernel headers, to build the
  key-injection helper.
- `pactl`, for the audio keys. That is **pulseaudio-utils** on Fedora, Debian
  and Ubuntu — a machine running PipeWire may still not have the command.
- A desktop session with a systemd user manager and a session D-Bus.
- Network access during the install, for `npm ci` and the editor's Electron.
- For the editor's tray icon, a panel that hosts StatusNotifierItem icons.
  KDE Plasma does, and so does Ubuntu's GNOME; plain GNOME needs the
  AppIndicator extension. The install script warns when there is none.

Two things it will not do for you:

- **Replace a Node that is present but too old**, or one not at
  `/usr/bin/node`. If your distribution's Node is older than 22.12 — Debian
  stable ships 20 — you need nvm or a third-party repository.
- **Fix what no package fixes**: `/dev/uinput` missing (`sudo modprobe
  uinput`), a desktop that never reaches `graphical-session.target`, a session
  with no seat.

## Using it

The first time the daemon starts, it writes a starter configuration for the
decks that are plugged in: one profile, with one working key on each deck.

Open the editor from your desktop's application menu (**Deckhand**) or with
`deckhand-editor`. Selecting a profile or page in the editor switches the
decks to it; every change is saved as you make it and shows on the deck at
once. Closing the editor's window leaves it in the tray (a setting, on by
default); quit it from the tray menu. Closing it changes nothing on the
decks.

**Profiles** switch every deck at once — say, one for the desktop and one for
a game. A deck the active profile has no layout for keeps showing what it was
showing, so a small deck can hold a permanent row of profile keys while a big
one changes. Switch with a key on a deck, in the editor, or from a script:
`deckhand profile <name>`.

**Icons** are image files wherever you keep them (PNG, JPEG, WebP, GIF, SVG).
Nothing is copied or imported: the config holds the path, and editing the
file updates the key. A key with an action and no icon draws that action's
built-in icon.

**Your configuration** is `~/.config/deckhand/config.json`. The editor writes
it, and it is plain JSON you can edit by hand (see
[the config reference](#config-reference)). Save it and the decks update, with
no restart. A file that doesn't validate is refused, and the decks keep the
last good one. Every accepted change keeps the one it replaced in
`~/.local/state/deckhand/backups/` — the newest 20, at most one every five
minutes. The editor's settings export the whole configuration, icons
included, and import it on another machine.

### The deckhand command

`deckhand` talks to the running daemon over its control socket
(`$XDG_RUNTIME_DIR/deckhand.sock`, readable only by you). It never touches the
decks or the config file itself.

```bash
deckhand status                     # active profile, decks, whether the last config reload was accepted, where backups are
deckhand decks                      # connected decks: serial, model, keys
deckhand profile Gaming             # switch every deck to a profile, by ID or name
deckhand repaint                    # repaint all decks (or: deckhand repaint <serial>)
deckhand run --deck <serial> '{"type":"hotkey","keys":"ctrl+1"}'   # run an action without saving it
deckhand sinks                      # audio outputs you can pick (* = current default)
deckhand sources                    # audio inputs you can pick
deckhand watch                      # print changes as they happen, until Ctrl+C
```

Add `--json` to any of them for the daemon's raw reply. `deckhand profile …`
is what a game's launch script or a desktop keyboard shortcut should call.
Exit codes: 0 success, 1 the daemon refused the request, 2 wrong usage, 3 the
daemon isn't running or didn't answer.

`deckhand run` sends real keystrokes to whatever window has focus. Anything it
holds down is released when the action finishes, and only one such action runs
at a time, so a script flooding it can't hold up a key press on a deck.

## Update and uninstall

To update to a newer release, check it out in the clone and run the update
(replace `v0.2.0` with the release you want — they are listed on the
repository's Releases page):

```bash
cd ~/.local/src/deckhand && git fetch --tags && git checkout v0.2.0 && scripts/install.sh update
```

`update` builds from the checkout and refuses one with uncommitted changes, so
what runs can always be traced to a release.

```bash
~/.local/src/deckhand/scripts/install.sh uninstall          # asks whether to also remove your config
~/.local/src/deckhand/scripts/install.sh uninstall --purge  # removes your config without asking
```

Uninstall removes the service, the installed copy, the commands, the desktop
entry and Deckhand's udev rule. The rule always goes, because it gives every
program you run access to `/dev/uinput`. It also removes
`~/.local/state/deckhand/`, backups included — that is the app's state, not
your config. Then delete `~/.local/src/deckhand`.

Day to day:

```bash
systemctl --user status deckhand
systemctl --user restart deckhand
journalctl --user -u deckhand -f      # follow the log
```

## What it deliberately doesn't do

- **Switch profiles by itself when you change windows.** That needs a
  different backend for every desktop. Switch from a key, the editor, or
  `deckhand profile` in a game's launch script.
- **Plugins, a store, accounts, telemetry.** None.
- **Run as a Flatpak.** It needs udev rules, `/dev/uinput` and your audio and
  media services — everything a sandbox exists to withhold
  ([why](ARCHITECTURE.md#decisions)).
- **Use ydotool or the desktop portals.** Keys come from its own virtual
  keyboard, so there is nothing to grant and nothing to break when the desktop
  updates.

## Known limitations

- **Replacing a deck.** Layouts are keyed by the deck's serial number, so a
  new deck — even the same model — starts blank, and the old deck's layouts
  stay in the config, out of sight. To move them to the new deck: quit the
  editor from its tray menu, find the new serial with `deckhand decks`, and in
  `~/.config/deckhand/config.json` replace the old serial with the new one
  everywhere it appears (under `decks` and in each profile's `layouts`). Save;
  the deck picks it up at once.
- **Dials, the Plus's touch strip, and the Neo's extra buttons are ignored.**
  `deckhand decks` lists them as unsupported.
- **Typed text assumes a US keyboard layout.**
- **Audio devices with non-ASCII names** (accented or non-Latin descriptions,
  common on non-English systems) are shown by their system node name, because
  `pactl` reports their description as `(null)`. They work; the name is just
  less friendly.
- **A key index past a deck's last key** is accepted in a hand-edited config
  and never shown. The editor never writes one.
- **A Run command key is never marked as failed** on the deck: it starts its
  command detached, so there is no failure to see.

## Troubleshooting

**Deck not found.** `deckhand decks` lists what the daemon can see. If a deck
is missing, run `~/.local/src/deckhand/scripts/install.sh update`, which
reinstalls the udev rule if needed and reports access per device, then replug
the deck.

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
installer adds; run `~/.local/src/deckhand/scripts/install.sh update` again
and read what it reports.

## Config reference

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
`onRelease` and `refreshMs`. `\n` in a label gives a second line.

**`icon`** is left out for the action's built-in icon (a key with no action
stays blank), `null` for no icon, a path to an image file, or
`"builtin:<name>"` for one of the icons in `assets/icons/`. An icon that
can't be drawn shows a dashed "missing" icon.

### Actions

| type | what it does |
| --- | --- |
| `hotkey` | `keys: "ctrl+alt+3"`, or an array for a sequence. Also `holdMs`, `repeat`, `gapMs` |
| `toggle` | `keys` — latches: one press holds the keys down, the next releases them. `iconOn` / `iconOff` |
| `keyHold` | `keys`, `state: "down"` / `"up"` — pair with `onRelease` for push-to-talk |
| `text` | Types a literal string (US layout) |
| `command` | `command: "sh string"` or `exec: ["bin", "arg"]`. Detached unless `wait: true` |
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

## Developing

Why things are the way they are: [ARCHITECTURE.md](ARCHITECTURE.md). How to
work on the code, including every check and the traps in them:
[CLAUDE.md](CLAUDE.md) — written for AI coding assistants and people alike.

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
and the `check:*` scripts in `editor/`.

**Adding an action type:** write an object with `execute` and/or `describe`,
add it to the registry in `src/actions/index.ts`, and give it a form in the
editor. `describe` is what makes a key refresh while it is visible — the
clock, now-playing and the active-output highlight all use it — and identical
output is never written to the device.

## Support, security and licence

Deckhand is maintained by one person, for their own use first. Bug reports are
welcome as GitHub issues and are answered on a best-effort basis, with no
promised response time; feature requests are weighed against what the
maintainer uses. Pull requests are considered case by case.

Security problems: please report them privately, as described in
[SECURITY.md](SECURITY.md), not as public issues.

Licensed under the GNU General Public License, version 3 or (at your option)
any later version — see [LICENSE](LICENSE). The installed editor carries the
licences of the packages bundled into it in `THIRD-PARTY-NOTICES.txt`.
