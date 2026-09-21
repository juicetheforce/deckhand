# Deckhand

Stream Deck software for Linux. A small background service drives the decks,
and an editor lets you set them up: hotkeys, audio device switching, media
controls, pages and profiles.

I built it for my own decks, because the software I was using kept breaking.
It's one person's project, used every day.

![The editor, with a Stream Deck XL's page open](assets/screenshots/editor.png)

## How it's different

- **The daemon and the editor are separate programs.** The daemon drives the
  decks and sends the keys. The editor only writes a config file. A slow,
  closed or crashed editor can't delay a key press.
- **It does nothing when nothing is happening.** It waits for key presses,
  devices and players rather than checking on them. On my laptop, with music
  playing and live keys on screen, it idles at about 1% of one CPU core.
- **It's native, not a Flatpak.** It needs a udev rule, `/dev/uinput` and your
  audio and media services, which is what a sandbox exists to withhold. Keys
  come from its own virtual keyboard at the kernel's input layer, so games see
  them like a real keyboard's, games under Wine included. No permission
  prompts, and no portal to break when the desktop updates.
- **One press switches every deck.** A profile covers all your decks at once:
  one key takes the whole desk from work to a game.
- **Icons are just files on disk.** Point a key at any image. Nothing is
  copied or imported; edit the file and the key updates. A key without an
  icon draws a built-in one for its action.

## How it treats your hardware

- **Decks are known by serial number**, not by USB port. Move a deck to
  another port and its layouts go with it.
- **Any Stream Deck with screen keys should work.** The key count, layout and
  icon size come from the device, not from a list in Deckhand. I use an XL
  and an Original V2 side by side; other models haven't been tried.
- **Unplugging a deck loses nothing.** Its layouts stay in the config, and
  when you plug it back in it comes back on the active profile's start page.
  Any key it was holding down is released when it goes.

## Screenshots

Setting up a hotkey:

![The key inspector, recording a hotkey](assets/screenshots/hotkey.png)

Choosing an icon from a folder of your own:

![The icon picker, open on a bookmarked folder](assets/screenshots/icon-picker.png)

Settings:

![The settings window](assets/screenshots/settings.png)

## Install

One line, as your normal user:

```bash
curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash
```

It downloads a prebuilt release (about 130 MB) and installs it for your user
only. Nothing is compiled on your machine, and it brings its own Node.js. You
need an x86_64 machine with glibc 2.28 or newer, a desktop session with
systemd, and `pactl` for the audio keys. The installer checks first, names
anything missing, and offers the command to install it.

The download is checked against the release's `SHA256SUMS`. That catches a
corrupted or cut-short download, and that is all it does: the checksums come
from the same GitHub release as the download, so they don't prove who made it.

`sudo` is asked for once, to add a udev rule that gives you access to the
decks, and on Ubuntu once more for an AppArmor profile the editor needs. Then
open **Deckhand** from your application menu.

To update, run the same line again. To remove it: `deckhand-uninstall`.

I use it every day on Fedora 44 (KDE Plasma), and it has run on Ubuntu 26.04
(GNOME). Each release is checked to load on AlmaLinux 8, Debian 11 and 12,
Ubuntu 22.04 to 26.04, Fedora 44 and Arch before it is published. To build it
from source instead, see [the developer install](REFERENCE.md#developer-install).

## What it doesn't do, and why

- **Switch profiles by itself when you change windows.** That needs a
  different backend for every desktop. Switch with a key, from the editor,
  or with `deckhand profile <name>` in a game's launch script.
- **Run as a Flatpak**, for the reasons above.
- **Use ydotool or the desktop portals.** It has its own virtual keyboard.
- **Plugins, a store, accounts or telemetry.** None of them.

And what it doesn't do well yet:

- **Replacing a deck.** A new deck starts blank, even the same model, because
  layouts belong to a serial number. Moving them over means editing the
  serial in the config file ([how](REFERENCE.md#using-it)).
- **Dials, the Plus's touch strip, and the Neo's extra buttons** are ignored.
- **Decks without screens, such as the Pedal**, haven't been tried and
  probably don't work.
- **x86_64 only.** On other machines, install from source.
- **Typed text assumes a US keyboard layout.**
- **Audio devices with non-English names** show their system name instead,
  because `pactl` doesn't report the description. They still work.
- **A Run command key never shows that it failed.** It starts the program
  and moves on, so a mistyped command just does nothing.

## Things I'd like to add

I build what I use, so this list changes, and nothing on it is a promise. If
you use Deckhand and something here matters to you, say so in an issue.
That's what shapes it.

- An app launcher that picks from your installed applications and uses each
  app's own icon.
- Timer keys.
- Volume for individual devices, not just the default one.
- Window actions on KDE Plasma.
- Dials and the touch strip, if I ever have a Stream Deck+ to test on.

## More

- [REFERENCE.md](REFERENCE.md): the config format, every action, the
  `deckhand` command, the control socket, troubleshooting and development.
- [ARCHITECTURE.md](ARCHITECTURE.md): why it's built the way it is.
- [SECURITY.md](SECURITY.md): reporting a security problem privately.

Bug reports are welcome as issues. I answer them when I can; feature requests
are weighed against what I use.

Licensed under the GNU General Public License, version 3 or later:
[LICENSE](LICENSE).
