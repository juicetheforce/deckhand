# deckhand

A personal Stream Deck daemon for Linux. Built for Nobara / KDE Plasma on
Wayland, driving a Stream Deck XL and an MK.2 at the same time.

Not a product. No plugin store, no telemetry, no onboarding wizard. It does
hotkeys, audio output switching, media control, and pages — and it keeps
doing them while you're in a game.

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
working hotkey button on each, keyed by serial number. Edit that file.

The config file is watched. Save it and the decks repaint immediately — no
restart. If you save a syntax error, the daemon logs it and keeps running on
the last good config rather than going dark mid-game.

Config is keyed by serial, never by USB path, so plugging the decks into
different ports doesn't shuffle your layouts. To see the serials of connected
decks (safe while the service is running):

```bash
node ~/.local/share/deckhand/dist/index.js --list
```

`config.example.json` shows the config format, but its audio `match` strings
and deck names are examples, not values that will work on your machine.

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
another package's own udev rule can still grant it.

Day to day:

```bash
systemctl --user status deckhand
systemctl --user restart deckhand
journalctl --user -u deckhand -f      # follow the log
```

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
(96px) and the MK.2 (72px). There is no import step and no icon library:
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
  "decks": {
    "<serial>": {
      "name": "XL",
      "brightness": 70,
      "startPage": "main",
      "pages": {
        "main": { "buttons": { "0": { /* button */ } } }
      }
    }
  }
}
```

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
| `page` | `to: "pageName"` or `back: true` |
| `multi` | `steps: [...]`, each optionally with `delayMs` |
| `brightness` | `value` or `delta` |
| `clock` | Shows the time |
| `noop` | Deliberately blank |
| `audio.sink` | `match: "headset"` — switches default output and moves playing streams. Highlights when active |
| `audio.cycle` | `matches: ["headset","speakers"]` — rotate outputs from one button |
| `audio.micMute` | Toggles the default input; swaps icon and background with `iconMuted` / `iconUnmuted` |
| `audio.volume` | `delta: 5`; shows the current level |
| `audio.mute` | Toggles output mute |
| `media.control` | `method: playpause \| next \| previous \| stop \| play \| pause` |
| `media.info` | Live now-playing button, with album art via `showArt` |

Sink matching is a case-insensitive substring against the device description
or node name, so `"headset"` beats pasting a forty-character `alsa_output`
string that changes when you move the USB port.

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

Runs the render pipeline, page navigation, and action dispatch against a
fake 32-key device. Handy after touching `render.ts`.

## Troubleshooting

**Deck not found.** Run `node ~/.local/share/deckhand/dist/index.js --list`.
Empty means your user can't reach the device — run `scripts/install.sh
update`, which reinstalls the udev rule if needed and reports access per
device, then replug the deck.

**Keys do nothing.** Look for `[input] virtual keyboard ready` in
`journalctl --user -u deckhand`. If it's missing, `/dev/uinput` isn't
accessible; the install script's access report says so directly. If the
device doesn't exist at all, `sudo modprobe uinput`.

**Audio button doesn't change anything.** `pactl -f json list sinks` and
check that your `match` substring actually appears in a description.

**Media buttons do nothing.** `busctl --user list | grep mpris` — if nothing
is listed, your player isn't exposing MPRIS.

## Known gaps

- Dials, the touch strip on a Plus, and the Neo's extra buttons are ignored;
  the code skips non-button controls rather than mishandling them.
- No editor UI yet. The daemon's config format is deliberately hand-editable
  in the meantime.
- Text typing assumes a US layout.
- No per-app profile switching, by choice — that's the feature that would
  drag in a compositor-specific backend.
