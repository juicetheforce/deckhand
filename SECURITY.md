# Security

Deckhand synthesises keystrokes through a virtual keyboard and installs a udev
rule to do it, so a flaw in it can matter beyond Deckhand itself. Please
report one privately.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security**
tab, then **Report a vulnerability**. Please don't open a public issue for a
security problem.

Deckhand is maintained by one person. Reports are read and answered on a
best-effort basis; there is no promised response time. Only the latest
release is supported.

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

Out of scope: that a user's own processes can use `/dev/uinput` once the rule
is installed (that is what it is for), and anything that needs root already.
