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

- Node 20+
- `gcc` and `make` (`sudo dnf install gcc make`)
- `pactl` (comes with pipewire-pulse; already on Nobara)
- A session D-Bus, for MPRIS media control

## Install

```bash
git clone <your-repo> ~/src/deckhand
cd ~/src/deckhand
npm install
npm run build          # builds the C helper, then the TypeScript
```

Install the udev rules so your user can reach the decks and `/dev/uinput`
without root:

```bash
sudo cp udev/60-deckhand.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Unplug and replug the decks. If key injection later fails with a permission
error, `sudo modprobe uinput` and confirm the rule took effect.

## Configure

Find your serial numbers:

```bash
npm run decks
```

Then:

```bash
mkdir -p ~/.config/deckhand
cp config.example.json ~/.config/deckhand/config.json
$EDITOR ~/.config/deckhand/config.json     # paste in the serials
```

Config is keyed by serial, never by USB path, so plugging the decks into
different ports doesn't shuffle your layouts.

Run it:

```bash
npm start
```

The config file is watched. Save it and the decks repaint immediately — no
restart. If you save a syntax error, the daemon logs it and keeps running on
the last good config rather than going dark mid-game.

## Run it at login

```bash
cp systemd/deckhand.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/deckhand.service   # fix the paths
systemctl --user daemon-reload
systemctl --user enable --now deckhand
journalctl --user -u deckhand -f
```

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

**Deck not found.** `npm run decks`. Empty means the udev rule didn't take —
reload it and replug.

**Keys do nothing.** Look for `[input] virtual keyboard ready` in the log. If
it's missing, `/dev/uinput` isn't accessible.

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
