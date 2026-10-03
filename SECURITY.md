# Security

Deckhand synthesises keystrokes through a virtual keyboard and installs a udev
rule to do it, so a flaw in it can matter beyond Deckhand itself. Please
report one privately.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security**
tab, then **Report a vulnerability**. Please don't open a public issue for a
security problem.

This is a one-person project. I'll acknowledge a report as soon as I can,
usually within a few days. Only the latest release is supported.

## What is in scope

- **The input helper** (`helper/deckhand-input.c`) and the daemon's use of it:
  anything that lets another process make it type, or leaves a key held down.
- **The control socket** (`$XDG_RUNTIME_DIR/deckhand.sock`, mode `0600`):
  anything that lets another user reach it, or a client make the daemon do
  more than its commands allow.
- **The udev rule** (`/etc/udev/rules.d/60-deckhand.rules`), which gives the
  logged-in user access to the decks and to `/dev/uinput`. Its breadth is
  deliberate — any process of that user can then synthesise keystrokes, which
  is why uninstalling always removes it — but a way to widen it further is in
  scope.
- **The install script** (`scripts/install.sh`), which runs `sudo` for the
  udev rule and, on some distributions, an AppArmor profile for the editor.
- **Config import** in the editor, which writes icon files from an archive:
  anything that writes outside the places it shows you before importing.
- **The secrets** Deckhand keeps, the OBS password and VTube Studio's token:
  anything that puts one anywhere but its own file, or lets another user
  read it.

## Secrets

Deckhand keeps two secrets: the password for OBS's WebSocket server, and the
token VTube Studio gives Deckhand when you allow it. Both are kept the same
way.

- They live in `~/.local/state/deckhand/credentials.json` (under
  `$XDG_STATE_HOME` if set), mode `0600`, written by temporary file and
  rename so the file is never on disk with wider permissions. It is outside
  the config directory, which people sync or keep in dotfiles.
- They are **never in `config.json`, an export or a backup**. Exports bundle
  the config and its icons; the rolling backups copy the config. Neither
  touches this file, so restoring an export or a backup never restores a
  secret.
- The daemon writes the file. The OBS password reaches it from the editor
  over the control socket (mode `0600`), or from `deckhand obs password`,
  which reads it from the terminal or stdin, never from an argument, which
  every process could see. VTube Studio's token comes from VTube Studio
  itself, when you allow Deckhand in its window. **The socket never returns
  either**, only whether one is set.
- They are not encrypted at rest, and not kept in the desktop keyring: the
  keyring would not separate them from your other programs either, and the
  udev rule above already trusts them. Full-disk encryption is what protects
  them at rest.

OBS's WebSocket server listens on every network interface, with no option to
listen on this computer alone, so its password is all that stands between
your network and OBS. Use a strong one: OBS's default is a generated
16-character password, and **Show Connect Info** has it.

VTube Studio's API listens on every IPv4 network interface too, and a
plugin's token is all that stands between your network and it. VTube Studio
asks you before giving a plugin one, and anything that can reach its port
can make that window appear, so allow only a request you made, from
Deckhand's **Connect**. Removing a plugin in VTube Studio's plugin list
revokes its token.

Out of scope: that a user's own processes can use `/dev/uinput` once the rule
is installed (that is what it is for), and anything that needs root already.
