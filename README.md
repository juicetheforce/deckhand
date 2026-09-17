# deckhand

A personal Stream Deck daemon for Linux. Built on Fedora KDE Plasma
(Wayland), driving a Stream Deck XL and a Stream Deck Original V2 at the same
time. Nothing in it is specific to those two models: key count and icon size
come from the device.

Not a product. No plugin store, no telemetry, no onboarding wizard. It does
hotkeys, audio output switching, media control, pages and profiles — and it
keeps doing them while you're in a game.

## Why it's shaped like this

The daemon owns the decks and nothing else. Image compositing, D-Bus calls,
and shell-outs all happen off the USB write path, and a config editor — when
one exists — will be a separate process talking over a socket. That split is
the whole point: a hung UI can't stall your buttons, because the UI isn't
running in the same process as your buttons.

Key injection goes through a small resident C program that owns a `uinput`
virtual keyboard. That layer is below both X11 and Wayland, so there's no
portal permission to grant, nothing to break on a compositor update, and
games see the keystrokes because SDL reads evdev directly. The helper only
ever receives numeric keycodes — every human-readable key name lives in
`src/keymap.ts` — which is why the C file should never need to change.

## Requirements

- Node.js 20 or newer, installed from your distribution's packages at
  `/usr/bin/node` (the service runs that path), plus `npm`
- `gcc` and `make` (`sudo dnf install nodejs npm gcc make`)
- `pactl` (comes with pipewire-pulseaudio)
- A desktop session with a systemd user manager and a session D-Bus
- Network access during install, for `npm ci`

The install script checks for all of these and stops with a message if one is
missing. It does not install them for you.

## Install

Clone the repo anywhere, then run the install script as your normal user:

```bash
git clone <your-repo> ~/src/deckhand
cd ~/src/deckhand
scripts/install.sh install
```

It builds a copy of Deckhand and installs it for your user only:

| What | Where |
| --- | --- |
| The daemon, its dependencies and the key-injection helper | `~/.local/share/deckhand/` |
| The systemd user service | `~/.local/share/systemd/user/deckhand.service` |
| The udev rule that lets your user reach the decks and `/dev/uinput` | `/etc/udev/rules.d/60-deckhand.rules` |

The udev rule is the only part that needs `sudo`, and you are only asked for it
when the rule is missing or has changed. The script then starts the service,
enables it so it starts with your desktop session, and prints whether your
user can actually open `/dev/uinput` and each connected deck.

If the newly installed daemon doesn't stay running, the script puts the
previous installation back and shows the log.

The running service uses the installed copy, **not** the checkout: editing or
rebuilding in the checkout changes nothing until you run the update below.

## Configure

The first time the daemon starts with no config, it writes one to
`~/.config/deckhand/config.json` for the decks that are plugged in — one
profile, with one working hotkey button on each deck, keyed by serial number.
Edit that file.

The config file is watched. Save it and the decks repaint immediately — no
restart. If you save a syntax error, the daemon logs it and keeps running on
the last good config rather than going dark mid-game.

Every accepted change also keeps the config it replaced, as a backup in
`~/.local/state/deckhand/backups/` (`$XDG_STATE_HOME`), named by the time it
was saved. At most one is taken every 5 minutes, so a burst of edits leaves
one backup from before the burst; the newest 20 are kept. `deckhand status`
prints where they are. To go back, copy one over `config.json`.

Config is keyed by serial, never by USB path, so plugging the decks into
different ports doesn't shuffle your layouts. To see the serials of connected
decks (safe while the service is running):

```bash
node ~/.local/share/deckhand/dist/index.js --list
```

`config.example.json` shows the config format. Its serials and audio `node`
names are `REPLACE-WITH-…` placeholders, not values that will work on your
machine.

### Converting a config from before profiles

Configs written before profiles existed (v0.1) kept pages directly under each
deck. The daemon refuses that format and logs a message saying so. Convert it
once, from the checkout, with the service stopped:

```bash
systemctl --user stop deckhand
npm run build:ts
node scripts/migrate-config.mjs --dry-run   # optional: print the result, write nothing
node scripts/migrate-config.mjs
scripts/install.sh update                   # installs and starts the daemon that reads it
```

Every deck becomes a layout in one profile, `default`. Buttons are copied
unchanged, page names become page IDs (so existing `page` links still work),
and the original is kept as `~/.config/deckhand/config.v0.1.json`. If you ever
need to go back to a daemon from before profiles, copy that file back over
`config.json`.

## Update, uninstall, and the service

```bash
cd ~/src/deckhand
git pull
scripts/install.sh update        # same as install
```

`install` and `update` refuse to run from a checkout with uncommitted changes,
so a half-finished edit can't reach the running daemon by accident. Pass
`--dirty` to override.

```bash
scripts/install.sh uninstall         # asks whether to also remove your config
scripts/install.sh uninstall --purge # removes your config without asking
```

Uninstall stops and removes the service, the installed copy, and Deckhand's
udev rule — the rule is always removed, because it gives every program you run
access to `/dev/uinput`. It reports whether that access is actually gone;
another package's own udev rule can still grant it. It also removes
`~/.local/state/deckhand/`, including the config backups, without asking:
that is the app's state, not your config.

Day to day:

```bash
systemctl --user status deckhand
systemctl --user restart deckhand
journalctl --user -u deckhand -f      # follow the log
```

## The deckhand command

The install script also puts a `deckhand` command in `~/.local/bin`. It talks
to the running daemon over its control socket (`$XDG_RUNTIME_DIR/deckhand.sock`,
readable only by you); it never touches the decks or the config file itself.

```bash
deckhand status                     # active profile, decks, whether the last config reload was accepted, where backups are
deckhand decks                      # connected decks, key counts and layout
deckhand profile FFXIV              # switch every deck to a profile, by ID or name
deckhand repaint                    # repaint all decks (or: deckhand repaint <serial>)
deckhand run --deck <serial> '{"type":"hotkey","keys":"ctrl+1"}'   # run an action without saving it
deckhand sinks                      # audio outputs you can pick (* = current default)
deckhand sources                    # audio inputs you can pick
deckhand watch                      # print changes as they happen, until Ctrl+C
```

Add `--json` to any of them for the daemon's raw reply. `deckhand profile …`
is what a game launch script or a KDE keyboard shortcut should call to switch
profiles. Exit codes: 0 success, 1 the daemon refused the request, 2 wrong
usage, 3 the daemon isn't running or didn't answer.

`deckhand run` sends real keystrokes to whatever window has focus. Anything it
holds down is released when the action finishes, and only one such action runs
at a time, so a script flooding it can't hold up a key press on the deck.

The socket protocol (newline-delimited JSON) is documented in
`docs/scope.md` §7, "M3 protocol design".

## Developing

Work in the checkout. To run the daemon in the foreground from it, stop the
service first — two daemons would fight over the decks:

```bash
systemctl --user stop deckhand
npm ci
npm start                             # builds, then runs; Ctrl+C to stop
systemctl --user start deckhand       # back to the installed copy
```

When a change is ready, commit it and run `scripts/install.sh update`.

## Icons

An icon is just a path in the config:

```json
{ "label": "Push", "icon": "~/Pictures/deck-icons/push.png" }
```

Any format sharp can read — png, jpg, webp. It's resized to the right size
for whichever deck the button is on, so the same icon works on both the XL
(96px) and the Original V2 (72px). There is no import step and no icon library:
drop a file anywhere, point at it, done. Overwrite the file and the button
picks up the change, because the render cache keys on mtime.

`iconFit` is `cover` (crop to fill, the default) or `contain` (letterbox).

Labels are drawn with a dark outline behind the glyphs so light text stays
readable on a bright icon. `\n` in a label gives you a second line.

## Config reference

Top level:

```jsonc
{
  "defaults": { /* background, labelColor, labelSize, labelPosition,
                   iconFit, brightness, refreshMs */ },

  "decks": {                                   // hardware settings, optional
    "<serial>": { "name": "XL", "brightness": 70 }
  },

  "profiles": {
    "<profile ID>": {
      "name": "FFXIV",                         // optional
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

  "startProfile": "FFXIV"                      // profile ID or name, optional
}
```

**Profiles** switch every deck at once. A deck the active profile has no
layout for keeps showing what it was showing, so a small deck can hold a
permanent row of profile keys while the big one changes. Switching sends each
covered deck to its layout's start page. The daemon always starts on
`startProfile` (or the first profile).

**IDs and names.** Profiles and pages are keyed by ID. Anything that points at
one — `startProfile`, `startPage`, and the `profile` and `page` actions —
matches the ID first, then the `name`. Write `"to": "Combat"` by hand and it
works; a tool can write IDs so renaming a page never breaks a link. Two pages
in one layout, or two profiles, can't share a name, and a name can't be another
entry's ID — the daemon refuses such a config and keeps the last good one.

A deck with no layout in any profile is not used. `decks` is only for
hardware settings; a deck doesn't need an entry there.

Buttons are keyed by index as a string. Index 0 is top-left, counting across
rows. A button takes `icon`, `iconFit`, `label`, `labelColor`, `labelSize`,
`labelPosition`, `background`, `action`, `onRelease`, and `refreshMs`.

### Actions

| type | what it does |
| --- | --- |
| `hotkey` | `keys: "ctrl+alt+3"` or an array for a sequence. Also `holdMs`, `repeat`, `gapMs` |
| `text` | Types a literal string (US layout) |
| `keyHold` | `state: "down"` / `"up"` — pair with `onRelease` for push-to-talk |
| `command` | `command: "sh string"` or `exec: ["bin","arg"]`. Detached unless `wait: true` |
| `page` | `to: "<page ID or name>"` or `back: true`. Pages on the same deck and profile |
| `profile` | `to: "<profile ID or name>"` — switches every deck |
| `multi` | `steps: [...]`, each optionally with `delayMs` |
| `brightness` | `value` or `delta` |
| `clock` | Shows the time |
| `noop` | Deliberately blank |
| `audio.sink` | `node: "<node from deckhand sinks>"`, `label: "<its description>"` — switches default output and moves playing streams. Highlights when active |
| `audio.cycle` | `devices: [{ node, label }, …]` — rotate outputs from one button; shows the active entry's label |
| `audio.micMute` | Toggles the default input; swaps icon and background with `iconMuted` / `iconUnmuted` |
| `audio.volume` | `delta: 5`; shows the current level |
| `audio.mute` | Toggles output mute |
| `media.control` | `method: playpause \| next \| previous \| stop \| play \| pause` |
| `media.info` | Live now-playing button, with album art via `showArt` |

Audio keys name the exact device: `node` is a name from `deckhand sinks`, and
`label` is only for showing. If that device is not present, a press logs it
and does nothing — there is no guessing at a similar device. Local (ALSA) node
names don't include the USB port, so they survive replugging into a different
port; network sink names include an IP address and don't.

Hand-edited config can still use `match` (and `matches` for `audio.cycle`): a
case-insensitive substring of the description or node name, ignored when
`node` / `devices` is set. If a substring matches several sinks — a headset
often has a stereo and a mono sink — the first one wins, and the log says so
once.

Media actions target whichever player is actually playing unless you pin one
with `player: "tidal"`. Bind it loose and the same buttons work for Tidal
today and a browser tab tomorrow.

## Adding an action type

Write an object with `execute` and/or `describe`, then add one line to the
registry in `src/actions/index.ts`. Nothing else in the daemon needs to know
it exists.

```ts
export const myThing: ActionHandler = {
  async execute(ctx, params) { /* do it */ },
  async describe(ctx, params) { return { label: 'live text' }; },
};
```

Defining `describe` is what makes a button refresh on a timer — that's how
the clock, the now-playing button, and the active-output highlight work.
Buttons re-render at most every `refreshMs`, and identical output is never
written to the device, so a 1 Hz refresh costs almost nothing on the wire.

## Testing without hardware

```bash
npm run smoke
```

Three parts, about 40 seconds together:

- `scripts/smoke.mjs` — the render pipeline, page navigation, action dispatch,
  config validation and profile switching, against fake 32-key devices.
- `scripts/smoke-socket.mjs` — the control socket over a real socket, with a
  fake input helper and a fake `pactl`, including two proofs: a client flooding
  the socket can't delay a deck key press by more than one keystroke, and no
  client can leave a key held down. The flood proof measures timing, so a
  heavily loaded machine can fail it spuriously.
- `scripts/smoke-backups.mjs` — rolling config backups with a fake clock: a
  burst of saves leaves one backup and pushes none out, pruning never touches
  files Deckhand didn't name, and writing backups never triggers a config
  reload.

Handy after touching `render.ts`, `deck.ts`, `config.ts`, `profiles.ts`,
`input.ts`, `backups.ts` or anything in `src/control/`.

## Troubleshooting

**Deck not found.** Run `node ~/.local/share/deckhand/dist/index.js --list`.
Empty means your user can't reach the device — run `scripts/install.sh
update`, which reinstalls the udev rule if needed and reports access per
device, then replug the deck.

**Keys do nothing.** Look for `[input] virtual keyboard ready` in
`journalctl --user -u deckhand`. If it's missing, `/dev/uinput` isn't
accessible; the install script's access report says so directly. If the
device doesn't exist at all, `sudo modprobe uinput`.

**Audio button doesn't change anything.** `journalctl --user -u deckhand` says
why: a device that is not present, or a switch the audio server refused. Check
the key's `node` against `deckhand sinks`; with a hand-written `match`, check
the substring appears in a description in `pactl -f json list sinks`.

**Media buttons do nothing.** `busctl --user list | grep mpris` — if nothing
is listed, your player isn't exposing MPRIS.

**`deckhand` says the daemon isn't running.** `systemctl --user status
deckhand`. If the service is up, look for `[control] listening on …` in its log;
if the socket could not be created the log says why, and the decks keep working
without it.

## Known gaps

- Dials, the touch strip on a Plus, and the Neo's extra buttons are ignored;
  the code skips non-button controls rather than mishandling them.
  `deckhand decks` lists them as unsupported.
- No editor UI yet. The daemon's config format is deliberately hand-editable
  in the meantime.
- Text typing assumes a US layout.
- No per-app profile switching, by choice — that's the feature that would
  drag in a compositor-specific backend.
