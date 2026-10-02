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
- **The OBS password** Deckhand keeps: anything that puts it anywhere but its
  own file, or lets another user read it.

## Secrets

Deckhand keeps one secret today: the password for OBS's WebSocket server.

- It lives in `~/.local/state/deckhand/credentials.json` (under
  `$XDG_STATE_HOME` if set), mode `0600`, written by temporary file and
  rename so it is never on disk with wider permissions. It is outside the
  config directory, which people sync or keep in dotfiles.
- It is **never in `config.json`, an export or a backup**. Exports bundle the
  config and its icons; the rolling backups copy the config. Neither touches
  this file, so restoring an export or a backup never restores the password.
- The editor sends it to the daemon over the control socket (mode `0600`),
  and the daemon writes the file. **The socket never returns it**, only
  whether one is set. `deckhand obs password` reads it from the terminal or
  stdin, never from an argument, which every process could see.
- It is not encrypted at rest, and not kept in the desktop keyring: the
  keyring would not separate it from your other programs either, and the
  udev rule above already trusts them. Full-disk encryption is what protects
  it at rest.

OBS's WebSocket server listens on every network interface, with no option to
listen on this computer alone, so its password is all that stands between
your network and OBS. Use a strong one: OBS's default is a generated
16-character password, and **Show Connect Info** has it.

Out of scope: that a user's own processes can use `/dev/uinput` once the rule
is installed (that is what it is for), and anything that needs root already.
