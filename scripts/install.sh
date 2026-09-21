#!/bin/bash
#
# Deckhand install / update / uninstall — the daemon and the editor.
#
#   scripts/install.sh install [--dirty]
#   scripts/install.sh update  [--dirty]     (same as install)
#   scripts/install.sh upgrade               (moves a release checkout to the newest release, then updates)
#   scripts/install.sh uninstall [--purge]
#   scripts/install.sh check                 (checks this machine, changes nothing)
#
# (usage() below prints the same list; it cannot read it from this file, which
# a piped install does not have.)
#
# Layout, per user, nothing under /usr except the udev rule:
#
#   $XDG_DATA_HOME/deckhand/                  the app: dist/, node_modules/,
#                                             helper/deckhand-input,
#                                             assets/icons/ (built-in icons),
#                                             editor/ (the editor, with its own
#                                             Electron in editor/electron/), ...
#   $XDG_DATA_HOME/systemd/user/deckhand.service
#   ~/.local/bin/deckhand                     the CLI: a small wrapper that runs
#                                             dist/cli.js from the app directory
#   ~/.local/bin/deckhand-editor              the editor's launcher
#   $XDG_DATA_HOME/applications/<id>.desktop  the editor's desktop entry, and
#   $XDG_DATA_HOME/icons/hicolor/*/apps/<id>.*  its icon; <id> is "desktopName"
#                                             in editor/package.json
#   /etc/udev/rules.d/60-deckhand.rules       the only file needing sudo
#   $XDG_CONFIG_HOME/deckhand/                your config — never touched by
#                                             install; uninstall asks
#   $XDG_STATE_HOME/deckhand/                 the app's state: rolling config
#                                             backups. Uninstall removes it
#                                             without asking (it goes with the
#                                             app, not with your config)
#
# Two ways to install, one script. From a git checkout it builds Deckhand (the
# developer install). As a release's install.sh — RELEASE_VERSION below stamped
# by scripts/release.sh — it downloads that release's prebuilt package, checks
# it against the release's SHA256SUMS, and installs it; nothing is built:
#
#   curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash
#
# Everything after the app directory is staged is the same for both.
#
# Run it from a git checkout of Deckhand, as your normal user (not root).
# It checks for prerequisites before anything is changed, and names everything
# missing at once rather than stopping at the first. For the ones a package can
# supply it then offers one command, shown in full, and runs it only if you say
# yes; "check" prints the same list and the same command and runs nothing.

set -euo pipefail

# Empty in the repository. scripts/release.sh writes the release's tag here in
# the copy it attaches to a release; that copy installs the prebuilt package.
RELEASE_VERSION=""
# The glibc every binary in a release is checked against when it is built
# (scripts/release.sh), and so the oldest a machine may have to install one.
RELEASE_GLIBC_FLOOR=2.28

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UDEV_RULE_SRC="$REPO_DIR/udev/60-deckhand.rules"
UDEV_RULE_DST="/etc/udev/rules.d/60-deckhand.rules"
# The AppArmor profile that lets the editor's Electron have a user namespace.
# Installed only where the kernel is restricting them; see apparmor_needed().
APPARMOR_PROFILE_SRC="$REPO_DIR/apparmor/deckhand-editor"
APPARMOR_PROFILE_DST="/etc/apparmor.d/deckhand-editor"
# A release has no checkout: its rule and profile arrive in the package, and
# cmd_install points these at the staged copies once it is unpacked. Until
# then they name nothing, which the preflight treats as "may need sudo".
if [ -n "$RELEASE_VERSION" ]; then
  UDEV_RULE_SRC=""
  APPARMOR_PROFILE_SRC=""
fi

# How long the service must stay up, without restarting, to count as started.
START_SETTLE_SECONDS=8

# The CLI wrapper. ~/.local/bin is the XDG location for a user's executables
# and has no environment variable of its own. The marker line is how install
# and uninstall recognise a wrapper they wrote, so an unrelated "deckhand"
# command is never overwritten or deleted.
CLI_DIR="$HOME/.local/bin"
CLI_FILE="$CLI_DIR/deckhand"
CLI_MARKER='# deckhand-cli-wrapper'
# The editor's launcher, recognised the same way.
EDITOR_LAUNCHER="$CLI_DIR/deckhand-editor"
EDITOR_MARKER='# deckhand-editor-launcher'
# The editor's desktop entry, recognised the same way.
DESKTOP_MARKER='# deckhand-desktop-entry'
# The uninstaller, recognised the same way.
UNINSTALLER="$CLI_DIR/deckhand-uninstall"
UNINSTALL_MARKER='# deckhand-uninstall-wrapper'

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

is_release() { [ -n "$RELEASE_VERSION" ]; }

usage() {
  if is_release; then
    cat >&2 <<USAGE
Deckhand $RELEASE_VERSION installer.

  install.sh [install] [--reinstall]   (the default; also updates an older install)
  install.sh check                     (checks this machine, changes nothing)
  install.sh uninstall [--purge]       (deckhand-uninstall does the same)
USAGE
    exit 2
  fi
  cat >&2 <<'USAGE'
Deckhand install / update / uninstall — the daemon and the editor.

  scripts/install.sh install [--dirty]
  scripts/install.sh update  [--dirty]     (same as install)
  scripts/install.sh upgrade               (moves a release checkout to the newest release, then updates)
  scripts/install.sh uninstall [--purge]
  scripts/install.sh check                 (checks this machine, changes nothing)
USAGE
  exit 2
}

# --- Locations ---------------------------------------------------------------
#
# The unit finds the app through %D, which systemd resolves from the *user
# manager's* XDG_DATA_HOME, not this shell's. Read the same value here so the
# files land exactly where %D will look.

manager_env() {
  # Prints the value of $1 in the systemd user manager's environment, or nothing.
  systemctl --user show-environment 2>/dev/null | sed -n "s/^$1=//p"
}

resolve_locations() {
  DATA_HOME="$(manager_env XDG_DATA_HOME)"
  DATA_HOME="${DATA_HOME:-$HOME/.local/share}"
  CONFIG_HOME="$(manager_env XDG_CONFIG_HOME)"
  CONFIG_HOME="${CONFIG_HOME:-$HOME/.config}"
  # The daemon reads XDG_STATE_HOME from the same user manager environment.
  STATE_HOME="$(manager_env XDG_STATE_HOME)"
  STATE_HOME="${STATE_HOME:-$HOME/.local/state}"

  APP_DIR="$DATA_HOME/deckhand"
  STAGE_DIR="$DATA_HOME/deckhand.new"
  PREVIOUS_DIR="$DATA_HOME/deckhand.old"
  UNIT_DIR="$DATA_HOME/systemd/user"
  UNIT_FILE="$UNIT_DIR/deckhand.service"
  CONFIG_DIR="$CONFIG_HOME/deckhand"
  STATE_DIR="$STATE_HOME/deckhand"
  APPLICATIONS_DIR="$DATA_HOME/applications"
  ICON_THEME_DIR="$DATA_HOME/icons/hicolor"
}

# --- Checks ------------------------------------------------------------------

# The preflight: every requirement is checked before anything is touched, and
# every unmet one is named in one report, rather than the install stopping at
# the first and failing somewhere obscure later.
# "Missing" stops the install; "Warnings" do not — they are things that work
# worse, not things that break the daemon. `scripts/install.sh check` prints
# the same report and touches nothing, for pasting into a bug report.
#
# The fixed paths it looks at are variables so scripts/test/preflight.test.sh
# can point them at scratch files.
SERVICE_NODE=/usr/bin/node            # what systemd/deckhand.service runs
UINPUT_NODE=/dev/uinput
UINPUT_HEADER=/usr/include/linux/uinput.h
LOGIND_SEATS_DIR=/run/systemd/seats
SYSCTL_DIR=/proc/sys
OS_RELEASE=/etc/os-release

# Every unmet requirement is recorded twice: the sentence a person reads, and
# a short key naming the requirement, so the offer below can look up a package
# for it. "-" is the key for anything no package can fix (running as root, a
# desktop that never reaches graphical-session.target, /dev/uinput missing).
PREFLIGHT_MISSING=()
PREFLIGHT_MISSING_KEYS=()
PREFLIGHT_WARNINGS=()
missing() { PREFLIGHT_MISSING_KEYS+=("$1"); PREFLIGHT_MISSING+=("$2"); }
caution() { PREFLIGHT_WARNINGS+=("$1"); }

has_command() { command -v "$1" >/dev/null 2>&1; }

# Whether a name on the session bus has an owner. Fails (status 2) if the bus
# cannot be asked at all, so a caller can tell "absent" from "no bus".
bus_name_has_owner() {
  local answer
  answer="$(busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s "$1" 2>/dev/null)" || return 2
  [ "$answer" = "b true" ]
}

# Reads one number from /proc/sys, or prints nothing if the file is not there.
sysctl_value() {
  [ -r "$SYSCTL_DIR/$1" ] && cat "$SYSCTL_DIR/$1" 2>/dev/null || true
}

# Whether this machine denies unprivileged user namespaces to unconfined
# programs, which is what stops the editor's Electron starting. Ubuntu 24.04
# and later set this; Fedora does not, and there the profile is neither needed
# nor installed.
userns_restricted() {
  [ "$(sysctl_value kernel/apparmor_restrict_unprivileged_userns)" = 1 ]
}

# The profile's attachment path is a glob over the default location, so it
# covers every user of the machine without one install overwriting another's.
# An install somewhere else (a non-default XDG_DATA_HOME) is not covered by it,
# and says so rather than installing a profile that would never attach.
apparmor_path_covered() {
  case "$APP_DIR/editor/electron/electron" in
    /home/*/.local/share/deckhand/editor/electron/electron) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether the profile has to be installed or refreshed: only where user
# namespaces are restricted, and only when what is on disk differs.
apparmor_needed() {
  userns_restricted && ! cmp -s "$APPARMOR_PROFILE_SRC" "$APPARMOR_PROFILE_DST"
}

preflight_checks() {
  PREFLIGHT_MISSING=()
  PREFLIGHT_MISSING_KEYS=()
  PREFLIGHT_WARNINGS=()

  [ "$(id -u)" -ne 0 ] \
    || missing - "Running as root. Run this as your normal user; it asks for sudo only for the udev rule."
  if ! is_release; then
    [ -f "$REPO_DIR/package.json" ] && [ -f "$UDEV_RULE_SRC" ] \
      || missing - "Not a Deckhand checkout: run this script from inside one."
  fi

  # systemd user session: the daemon is a systemd --user service, started with
  # the graphical session (systemd/deckhand.service is WantedBy
  # graphical-session.target — a desktop that never reaches that target would
  # install fine and then never start the daemon at login).
  if ! has_command systemctl; then
    missing - "systemctl: Deckhand runs as a systemd user service, and this machine has no systemd."
  elif ! systemctl --user show-environment >/dev/null 2>&1; then
    missing - "The systemd user manager (systemctl --user) cannot be reached. Run this from a terminal in your desktop session."
  elif [ "$(systemctl --user is-active graphical-session.target 2>/dev/null)" != active ]; then
    missing - "graphical-session.target is not active in your systemd user session. The service starts with it, so it would never start at login. Run this from your desktop session; if you are, your desktop does not start that target."
  fi

  # The D-Bus session bus: media keys (MPRIS), and the tray and shortcut
  # lookups below, all go through it.
  local bus=yes
  if ! has_command busctl; then
    bus=no
    missing - "busctl (part of systemd): needed to reach the D-Bus session bus."
  elif ! busctl --user status >/dev/null 2>&1; then
    bus=no
    missing - "No D-Bus session bus (busctl --user status failed). Run this from your desktop session."
  fi

  # logind, for uaccess: the udev rule tags the decks and /dev/uinput
  # "uaccess", and it is logind that then grants them to the user at the seat.
  # With no logind, or no session on a seat, the rule installs and grants nothing.
  local display_session=""
  if ! has_command loginctl || [ ! -d "$LOGIND_SEATS_DIR" ]; then
    missing - "systemd-logind is not running (no loginctl or no $LOGIND_SEATS_DIR). Device access is granted through it (udev's uaccess)."
  else
    display_session="$(loginctl show-user "$(id -un)" -p Display --value 2>/dev/null || true)"
    if [ -z "$display_session" ] || [ -z "$(loginctl show-session "$display_session" -p Seat --value 2>/dev/null || true)" ]; then
      missing - "You have no graphical login session on a seat (loginctl). Device access (udev's uaccess) goes to the user at the seat. Log in at the machine and run this from that session."
    fi
  fi

  # Node: the unit runs $SERVICE_NODE, and native modules are built by the
  # node on PATH, so they must be the same one. 22.12, not the daemon's own
  # 20: building the editor needs it (Electron's package and the editor's
  # build tools declare >= 22.12).
  #
  # Only the "no node at all" case carries a package key. A node that is
  # present but too old, or present at the wrong path, is advice and nothing
  # more: on Fedora the versioned packages each own /usr/bin/node, so offering
  # nodejs24-bin to a machine running nodejs20-bin asks dnf to resolve a file
  # conflict nobody asked it to, and installing a package was never going to
  # fix a node that is simply somewhere else. Upgrading or rearranging an
  # existing Node is the owner's business.
  if is_release; then
    release_checks
  elif ! has_command node; then
    missing node "node: install Node.js 22.12 or newer from your distribution's packages (the service runs $SERVICE_NODE)."
  elif [ "$(command -v node)" != "$SERVICE_NODE" ]; then
    missing - "node on your PATH is $(command -v node), but the service runs $SERVICE_NODE. Native modules built with one would not load in the other. Install Node.js 22.12 or newer from your distribution's packages, and make it the node on PATH."
  else
    local version major minor
    version="$("$SERVICE_NODE" -v 2>/dev/null || true)"
    version="${version#v}"
    major="${version%%.*}"
    minor="${version#*.}"; minor="${minor%%.*}"
    if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
      missing - "Cannot tell which Node.js $SERVICE_NODE is ('$version'). Deckhand needs 22.12 or newer."
    elif [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 12 ]; }; then
      missing - "Node.js $version is too old; Deckhand needs 22.12 or newer."
    fi
  fi
  if ! is_release; then
    has_command npm  || missing npm "npm: install it (some distributions package it apart from Node.js)."
    has_command make || missing make "make: needed to build the key-injection helper."
    has_command cc   || missing cc "A C compiler (cc): install gcc, to build the key-injection helper."
    [ -f "$UINPUT_HEADER" ] \
      || missing uinput-header "$UINPUT_HEADER: the helper is built against the kernel's uinput header. Install your distribution's kernel headers for userspace (kernel-headers on Fedora, linux-libc-dev on Debian and Ubuntu)."
  fi

  # The virtual keyboard. Whether it is writable is the udev rule's business,
  # reported after it is installed; here it only has to exist.
  [ -c "$UINPUT_NODE" ] \
    || missing - "$UINPUT_NODE does not exist, so keystrokes cannot be injected. Load the module (sudo modprobe uinput) and make it load at boot."

  # Audio keys drive PulseAudio or PipeWire through pactl.
  if ! has_command pactl; then
    missing pactl "pactl: install the package that provides this command-line tool — pulseaudio-utils on Debian, Ubuntu and Fedora alike (on Fedora it is not pipewire-pulseaudio, which ships only the server). A machine can have PipeWire running and still not have it."
  elif ! pactl info >/dev/null 2>&1; then
    missing - "pactl cannot reach a sound server (pactl info failed). Deckhand's audio keys need PipeWire's PulseAudio server or PulseAudio running."
  fi

  # Root is needed only when the udev rule is new or changed.
  if ! cmp -s "$UDEV_RULE_SRC" "$UDEV_RULE_DST"; then
    has_command sudo    || missing - "sudo: needed once, to install the udev rule at $UDEV_RULE_DST."
    has_command udevadm || missing - "udevadm: needed to load the udev rule."
  fi

  # Same, for the AppArmor profile the editor needs on this kind of machine.
  if apparmor_needed; then
    has_command sudo           || missing - "sudo: needed once, to install the AppArmor profile at $APPARMOR_PROFILE_DST that lets the editor start."
    has_command apparmor_parser || missing apparmor-parser "apparmor_parser: needed to load the AppArmor profile that lets the editor start. Install your distribution's apparmor package."
  fi

  # --- Warnings: the install goes ahead ---

  # Electron's sandbox needs unprivileged user namespaces. Ubuntu 24.04's
  # AppArmor restriction, and older Debian's switch, turn them off. Only a
  # warning: the daemon, which drives the decks, does not need them. Only the
  # editor does.
  local userns_why=""
  [ "$(sysctl_value kernel/apparmor_restrict_unprivileged_userns)" = 1 ] && userns_why="AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns = 1, as on Ubuntu 24.04 and later)"
  [ "$(sysctl_value kernel/unprivileged_userns_clone)" = 0 ] && userns_why="unprivileged user namespaces are turned off (kernel.unprivileged_userns_clone = 0)"
  [ "$(sysctl_value user/max_user_namespaces)" = 0 ] && userns_why="user namespaces are turned off (user.max_user_namespaces = 0)"
  # The AppArmor case is handled: this install puts a profile in place that
  # grants the editor's Electron a user namespace, so warn only when that
  # profile cannot be what fixes it — the other two switches, which no profile
  # overrides — or when it is not installed yet and cannot be.
  if [ -n "$userns_why" ]; then
    if cmp -s "$APPARMOR_PROFILE_SRC" "$APPARMOR_PROFILE_DST"; then
      : # the profile is installed and current; the editor starts
    elif userns_restricted && [ "$(sysctl_value kernel/unprivileged_userns_clone)" != 0 ] \
        && [ "$(sysctl_value user/max_user_namespaces)" != 0 ]; then
      caution "The editor needs an AppArmor profile here: $userns_why, which Electron's sandbox needs. This install adds one at $APPARMOR_PROFILE_DST (it asks for sudo once) and the editor then starts normally. The decks never needed it."
    else
      caution "The editor will not start: $userns_why, which Electron's sandbox needs, and no AppArmor profile can grant it — that switch is off for every program. The decks will work. The likely symptom: deckhand-editor exits at once, printing \"No usable sandbox!\" or \"The SUID sandbox helper binary was found, but is not configured correctly\"."
    fi
  fi

  if [ "$bus" = yes ]; then
    # The tray is a StatusNotifierItem: it needs a panel that
    # hosts them, which registers this name. GNOME has none without an
    # AppIndicator extension. Electron does not report the difference, so
    # closing the editor would hide it with no icon to click.
    bus_name_has_owner org.kde.StatusNotifierWatcher \
      || caution "No system tray (nothing owns org.kde.StatusNotifierWatcher; GNOME needs an AppIndicator extension). Closing the editor's window would leave it running with no tray icon to reopen it: turn off \"Close to system tray\" in its settings, or run deckhand-editor again to bring the window back."
    # The hotkey inspector warns when a combo is a KDE global shortcut.
    bus_name_has_owner org.kde.kglobalaccel \
      || caution "No KDE shortcut service (org.kde.kglobalaccel): the editor cannot warn when a hotkey is already a desktop shortcut. Everything else works."
  fi
}

# What a release needs instead of a build toolchain: a machine its prebuilt
# binaries run on, the one system library they link that a desktop may lack,
# and the tools to download and check the package. Node, npm, a compiler and
# kernel headers are not needed: nothing is built here.
release_checks() {
  local arch glibc
  arch="$(uname -m)"
  [ "$arch" = x86_64 ] \
    || missing - "This machine is $arch. Deckhand's releases are built for x86_64 only; on $arch, install from source (the developer install in REFERENCE.md)."

  glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  glibc="${glibc#glibc }"
  if ! [[ "$glibc" =~ ^[0-9]+\.[0-9]+ ]]; then
    missing - "Cannot find this machine's glibc version (getconf GNU_LIBC_VERSION). Deckhand's releases need glibc $RELEASE_GLIBC_FLOOR or newer; a system on another C library (musl) cannot run them."
  elif [ "$(printf '%s\n%s\n' "$RELEASE_GLIBC_FLOOR" "$glibc" | sort -V | head -n 1)" != "$RELEASE_GLIBC_FLOOR" ]; then
    missing - "This machine has glibc $glibc; Deckhand's releases need $RELEASE_GLIBC_FLOOR or newer."
  fi

  # The Stream Deck library's HID backend links libusb-1.0 (and libudev, which
  # comes with systemd). ldconfig's cache is where the loader looks.
  local ldconfig
  ldconfig="$(command -v ldconfig || true)"
  for candidate in /sbin/ldconfig /usr/sbin/ldconfig; do
    [ -n "$ldconfig" ] || { [ -x "$candidate" ] && ldconfig="$candidate"; }
  done
  if [ -z "$ldconfig" ]; then
    caution "ldconfig was not found, so libusb-1.0 was not checked. If it is missing, the install stops after the download and names it."
  elif ! "$ldconfig" -p 2>/dev/null | grep -q 'libusb-1\.0\.so\.0 '; then
    missing libusb "libusb-1.0: the Stream Deck library links against it. Install your distribution's libusb 1.0 package."
  fi

  has_command curl      || missing curl "curl: needed to download the release."
  has_command xz        || missing xz "xz: needed to unpack the release."
  has_command tar       || missing - "tar: needed to unpack the release."
  has_command sha256sum || missing - "sha256sum (coreutils): needed to check the download."
}

# --- Offering to install what is missing --------------------------------------
#
# Turns the preflight's list into one install command, shown in full and run
# only on a keypress. `scripts/install.sh check` prints the same command and
# never offers to run it.
#
# Two rules hold this together.
#
# 1. **The command printed is the command run**, character for character. It is
#    built once, shown, and then handed to bash. Nothing is appended after the
#    person has read it, because reading it is what makes typing "y" safe.
#
# 2. **A package name is never printed without asking this machine whether it
#    exists.** A hand-written package table goes wrong silently: on Fedora,
#    pactl comes from pulseaudio-utils, not pipewire-pulseaudio
#    (`rpm -qf $(command -v pactl)`), and Fedora 44 has no package called
#    `nodejs` or `npm` at all (`dnf list nodejs npm` matches nothing;
#    /usr/bin/node comes from nodejsNN-bin). So a name this machine's package
#    manager does not know is never shown: the requirement is reported without
#    a command instead.
#
#    What the guard does not catch: a name that exists but is the wrong
#    package (pipewire-pulseaudio is a real Fedora package without pactl).
#    Only checking a cell against a real machine catches that in advance. At
#    install time the re-check catches it: the package installs, the command
#    is still missing, and the preflight refuses by name. That costs one
#    wasted install and still tells the truth.
#
#    Not done: asking the manager which package provides the missing
#    *command* (`dnf provides /usr/bin/pactl`), which would catch both kinds.
#    dnf supports it out of the box, but apt needs apt-file and pacman needs
#    pkgfile, and neither is installed by default, so it would be a
#    per-manager capability, not a rule.

# The table. Candidates are tried in order and the first one this machine knows
# about is the one offered, so a versioned name can be listed ahead of a plain
# one and the cell ages gracefully as distributions renumber.
#
# Checked against a real machine, and marked "checked" per cell: every dnf
# cell (Fedora 44, `dnf list` / `dnf provides`), and apt's pactl, node and npm
# (Ubuntu 26.04). The rest, including every pacman cell, are unchecked; the
# guard makes a wrong one print nothing rather than a wrong name.
pkg_candidates() {   # pkg_candidates <manager> <key> -> candidate names, best first
  case "$1:$2" in
    apt:pactl)             echo "pulseaudio-utils" ;;          # checked: Ubuntu 26.04
    dnf:pactl)             echo "pulseaudio-utils" ;;          # checked: Fedora 44
    pacman:pactl)          echo "libpulse" ;;

    apt:cc)                echo "gcc" ;;
    dnf:cc)                echo "gcc" ;;                       # checked: Fedora 44
    pacman:cc)             echo "gcc" ;;

    apt:make)              echo "make" ;;
    dnf:make)              echo "make" ;;                      # checked: Fedora 44
    pacman:make)           echo "make" ;;

    apt:uinput-header)     echo "linux-libc-dev" ;;
    dnf:uinput-header)     echo "kernel-headers" ;;            # checked: Fedora 44
    pacman:uinput-header)  echo "linux-api-headers" ;;

    # Fedora has no unversioned nodejs package; /usr/bin/node comes from
    # nodejsNN-bin. Newest first, so the floor of 22.12 is cleared by whichever
    # of these the release still carries.
    apt:node)              echo "nodejs" ;;                    # checked: Ubuntu 26.04 (22.22.1)
    dnf:node)              echo "nodejs24-bin nodejs22-bin nodejs" ;;   # checked: Fedora 44
    pacman:node)           echo "nodejs" ;;

    apt:npm)               echo "npm" ;;                       # checked: Ubuntu 26.04 (9.2.0)
    dnf:npm)               echo "nodejs24-npm-bin nodejs22-npm-bin npm" ;;  # checked: Fedora 44
    pacman:npm)            echo "npm" ;;

    # A release's requirements.
    apt:libusb)            echo "libusb-1.0-0" ;;
    dnf:libusb)            echo "libusb1" ;;                   # checked: Fedora 44
    pacman:libusb)         echo "libusb" ;;

    apt:curl)              echo "curl" ;;
    dnf:curl)              echo "curl" ;;
    pacman:curl)           echo "curl" ;;

    apt:xz)                echo "xz-utils" ;;
    dnf:xz)                echo "xz" ;;
    pacman:xz)             echo "xz" ;;

    # Only ever asked for where AppArmor restricts user namespaces, which is
    # the apt family; Fedora never reaches this check.
    apt:apparmor-parser)   echo "apparmor" ;;
    pacman:apparmor-parser) echo "apparmor" ;;
  esac
}

# By command presence, not /etc/os-release: Nobara reports ID=nobara and Mint
# reports ID=linuxmint, and asking which tool is installed gets every
# derivative right without an ID_LIKE chain to maintain. Prints nothing on a
# machine with none of them, and the caller then names what is missing and
# offers nothing.
detect_package_manager() {
  if has_command apt-get; then echo apt
  elif has_command dnf; then echo dnf
  elif has_command pacman; then echo pacman
  fi
}

# Does this machine's package manager know that name? Read-only, and with
# stdin closed: a third-party repository that wants to ask about a signing key
# must fail rather than hang the preflight waiting for an answer.
package_known() {   # package_known <manager> <package>
  case "$1" in
    apt)    [ -n "$(apt-cache policy "$2" </dev/null 2>/dev/null)" ] ;;
    dnf)    dnf -q list "$2" </dev/null >/dev/null 2>&1 ;;
    pacman) pacman -Si "$2" </dev/null >/dev/null 2>&1 ;;
    *)      return 1 ;;
  esac
}

install_command() {   # install_command <manager> <package>...
  local manager="$1"; shift
  case "$manager" in
    # apt-get rather than apt: apt says its CLI "does not have a stable
    # interface" when it is not talking to a terminal. The update is part of
    # the command because a machine whose lists are months old answers
    # "Unable to locate package" without it — and it is in the string shown,
    # not added afterwards.
    apt)    printf 'sudo apt-get update && sudo apt-get install -y %s' "$*" ;;
    dnf)    printf 'sudo dnf install -y %s' "$*" ;;
    # -S --needed, never -Sy and never -Syu. Refreshing the database for one
    # package without upgrading the rest is Arch's partial-upgrade footgun,
    # and a full system upgrade is not a thing a script may decide to run on
    # someone's machine. The cost is that a stale database answers with a 404,
    # which offer_to_install explains rather than working around.
    pacman) printf 'sudo pacman -S --needed %s' "$*" ;;
  esac
}

# Every requirement key the table has cells for, in the order the preflight
# checks them — each install's own: a release needs none of the build tools,
# a build from a checkout none of the download tools. The header walks all of
# them; the offer only the missing ones.
package_keys() {
  if is_release; then echo "libusb curl xz pactl apparmor-parser"
  else echo "node npm make cc uinput-header pactl apparmor-parser"
  fi
}

# The package this machine would install for one requirement: the first of
# its candidates the manager knows. Prints nothing if there is no cell for it
# here, or none of the candidates is known.
resolve_key() {   # resolve_key <manager> <key>
  local pkg
  for pkg in $(pkg_candidates "$1" "$2"); do
    if package_known "$1" "$pkg"; then echo "$pkg"; return 0; fi
  done
}

# For the header: the manager this script detected and what every cell in the
# table resolves to on this machine — **whether or not anything is missing**.
# Without it, `check` on a machine that already has everything would say
# nothing about what the table resolves to there. "?" is a requirement with a
# cell but no candidate this machine knows — the guard's answer, shown rather
# than hidden. A requirement with no cell for this manager (apparmor-parser on
# dnf) is left out.
package_summary() {
  local manager key found line=""
  manager="$(detect_package_manager)"
  if [ -z "$manager" ]; then
    echo "none this script knows (it knows apt, dnf and pacman)"
    return 0
  fi
  for key in $(package_keys); do
    if [ -z "$(pkg_candidates "$manager" "$key")" ]; then continue; fi
    found="$(resolve_key "$manager" "$key")"
    line="$line $key=${found:-?}"
  done
  echo "$manager:$line"
}

# Fills PREFLIGHT_PACKAGES with the package names to offer: one per unmet
# requirement that has a cell in the table *and* is known to this machine.
# PREFLIGHT_UNCOVERED counts the ones left over, which is what decides whether
# the offer admits to covering only part of the list. It is counted rather
# than inferred from the two array lengths, because two requirements are
# allowed to resolve to the same package — nothing in the table does today,
# and a comparison of lengths would quietly start lying on the day one does.
PREFLIGHT_PACKAGES=()
PREFLIGHT_UNCOVERED=0
resolve_packages() {   # resolve_packages <manager>
  local manager="$1" key pkg found listed
  PREFLIGHT_PACKAGES=()
  PREFLIGHT_UNCOVERED=0
  [ "${#PREFLIGHT_MISSING_KEYS[@]}" -gt 0 ] || return 0
  for key in "${PREFLIGHT_MISSING_KEYS[@]}"; do
    if [ "$key" = "-" ]; then PREFLIGHT_UNCOVERED=$((PREFLIGHT_UNCOVERED + 1)); continue; fi
    found="$(resolve_key "$manager" "$key")"
    if [ -z "$found" ]; then PREFLIGHT_UNCOVERED=$((PREFLIGHT_UNCOVERED + 1)); continue; fi
    listed=no
    for pkg in ${PREFLIGHT_PACKAGES[@]+"${PREFLIGHT_PACKAGES[@]}"}; do
      if [ "$pkg" = "$found" ]; then listed=yes; fi
    done
    if [ "$listed" = no ]; then PREFLIGHT_PACKAGES+=("$found"); fi
  done
}

# Sets PREFLIGHT_INSTALL_COMMAND, or returns 1 when there is no command to
# build: no package manager this script knows, no cell in the table, or a cell
# this machine does not recognise.
#
# It sets a variable rather than printing one: a caller reading it through
# $(...) would run resolve_packages in a subshell, and PREFLIGHT_PACKAGES and
# PREFLIGHT_UNCOVERED would not survive back to it, so the "does this cover
# everything" line below would fire even when it covered everything.
PREFLIGHT_INSTALL_COMMAND=""
build_install_command() {
  local manager
  PREFLIGHT_INSTALL_COMMAND=""
  manager="$(detect_package_manager)"
  [ -n "$manager" ] || return 1
  resolve_packages "$manager"
  [ "${#PREFLIGHT_PACKAGES[@]}" -gt 0 ] || return 1
  PREFLIGHT_INSTALL_COMMAND="$(install_command "$manager" "${PREFLIGHT_PACKAGES[@]}")"
  [ -n "$PREFLIGHT_INSTALL_COMMAND" ]
}

# Does the command cover everything that is missing, or only part of it?
install_command_is_partial() {
  [ "$PREFLIGHT_UNCOVERED" -gt 0 ]
}

# The offer itself. Returns 0 if a command was actually run — the caller then
# re-checks the machine, which is the only thing that decides whether the
# install goes ahead. Returns 1 if there was nothing to offer, no terminal to
# ask at, or the answer was no.
offer_to_install() {
  local command reply
  build_install_command || return 1
  command="$PREFLIGHT_INSTALL_COMMAND"
  printf '\n'
  say "Some of that can come from this machine's own packages:"
  printf '  %s\n' "$command"
  if install_command_is_partial; then
    printf '  That does not cover the whole list above; the rest is not something this script can install.\n'
  fi
  # No terminal, no prompt: a run from a pipe, a cron job or a desktop
  # launcher must neither hang waiting for an answer nor take silence for one.
  if [ ! -t 0 ]; then
    printf '  Nothing was run: there is no terminal here to ask at. Run that command yourself, or run this script from a terminal.\n'
    return 1
  fi
  printf 'Run this now? [y/N] '
  read -r reply || return 1
  case "$reply" in
    y|Y|yes|Yes|YES) ;;
    *) return 1 ;;
  esac
  say "Running: $command"
  # The string that was printed, run as it was printed. $BASH rather than a
  # bare "bash" so this does not depend on finding one on PATH.
  if ! "$BASH" -c "$command"; then
    warn "that command did not finish cleanly. The re-check below says what is still missing."
    if [ "$(detect_package_manager)" = pacman ]; then
      warn "if pacman could not find the package files, its database is out of date. A full system upgrade would fix that, and this script will not run one for you."
    fi
  fi
  return 0
}

# One line per thing that describes this machine, for a bug report.
preflight_header() {
  local distro="unknown" desktop session commit
  if [ -r "$OS_RELEASE" ]; then
    distro="$(sed -n 's/^PRETTY_NAME=//p' "$OS_RELEASE" | tr -d '"')"
  fi
  desktop="$(manager_env XDG_CURRENT_DESKTOP || true)"
  session="$(manager_env XDG_SESSION_TYPE || true)"
  if is_release; then
    printf '  %-9s %s\n' \
      "deckhand" "release $RELEASE_VERSION" \
      "distro"   "${distro:-unknown}" \
      "kernel"   "$(uname -r) $(uname -m)" \
      "glibc"    "$( (getconf GNU_LIBC_VERSION) 2>/dev/null || echo unknown)" \
      "desktop"  "${desktop:-${XDG_CURRENT_DESKTOP:-unknown}} (${session:-${XDG_SESSION_TYPE:-unknown}})" \
      "packages" "$(package_summary)"
    return 0
  fi
  commit="$(git -C "$REPO_DIR" describe --always --dirty 2>/dev/null || echo "not a git checkout")"
  printf '  %-9s %s\n' \
    "deckhand" "$commit" \
    "distro"   "${distro:-unknown}" \
    "kernel"   "$(uname -r) $(uname -m)" \
    "desktop"  "${desktop:-${XDG_CURRENT_DESKTOP:-unknown}} (${session:-${XDG_SESSION_TYPE:-unknown}})" \
    "node"     "$( (node -v) 2>/dev/null || echo none) at $(command -v node || echo -)" \
    "npm"      "$( (npm -v) 2>/dev/null || echo none)" \
    "packages" "$(package_summary)"
}

preflight_report() {
  local item
  if [ "${#PREFLIGHT_MISSING[@]}" -gt 0 ]; then
    printf '\033[1;31mMissing — the install cannot go ahead:\033[0m\n'
    for item in "${PREFLIGHT_MISSING[@]}"; do printf '  ✗ %s\n' "$item"; done
  fi
  if [ "${#PREFLIGHT_WARNINGS[@]}" -gt 0 ]; then
    printf '\033[1;33mWarnings — the install goes ahead:\033[0m\n'
    for item in "${PREFLIGHT_WARNINGS[@]}"; do printf '  ! %s\n' "$item"; done
  fi
  if [ "${#PREFLIGHT_MISSING[@]}" -eq 0 ]; then
    say "Every requirement is met."
  fi
}

# Before an install: the report, an offer to install what a package can supply,
# and stop if anything is still missing.
preflight() {
  say "Checking this machine"
  preflight_checks
  preflight_report
  # One offer and one re-check, never a loop. Whatever the packages did or did
  # not fix, the second pass is what decides; someone who answered no, or a
  # package that did not help, is not asked a second time.
  if [ "${#PREFLIGHT_MISSING[@]}" -gt 0 ] && offer_to_install; then
    say "Checking this machine again"
    preflight_checks
    preflight_report
  fi
  if [ "${#PREFLIGHT_MISSING[@]}" -gt 0 ]; then
    preflight_header >&2
    if is_release; then
      die "nothing was changed. Fix what is listed above and run the install line again."
    fi
    die "nothing was changed. Fix what is listed above and run this again; 'scripts/install.sh check' re-checks without installing."
  fi
}

# `scripts/install.sh check`: the report and nothing else. Exit status 1 if
# anything is missing.
cmd_check() {
  local command
  [ $# -eq 0 ] || usage
  say "Deckhand preflight — this checks the machine and changes nothing"
  preflight_header
  preflight_checks
  preflight_report
  # "check" is documented as changing nothing, so it names the command and
  # stops there. Offering to run it belongs to install.
  if [ "${#PREFLIGHT_MISSING[@]}" -gt 0 ]; then
    if build_install_command; then
      command="$PREFLIGHT_INSTALL_COMMAND"
      printf 'Some of that can come from this machine'"'"'s own packages:\n'
      printf '  %s\n' "$command"
      if install_command_is_partial; then
        printf '  That does not cover the whole list above.\n'
      fi
      printf '  "scripts/install.sh install" offers to run it for you.\n'
    fi
  fi
  [ "${#PREFLIGHT_MISSING[@]}" -eq 0 ]
}

check_clean_checkout() {
  local allow_dirty="$1"
  if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "not a git checkout; cannot check for uncommitted changes."
    return
  fi
  if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
    if [ "$allow_dirty" = yes ]; then
      warn "installing from a checkout with uncommitted changes (--dirty)."
    else
      git -C "$REPO_DIR" status --short >&2
      die "the checkout has uncommitted changes (above). Commit them, or pass --dirty to install anyway."
    fi
  fi
}

# --- install / update --------------------------------------------------------

build_and_stage() {
  # Build in the staging directory, never in the checkout. The checkout may be
  # what the running service uses (the old unit ran straight from its dist/),
  # so building there would overwrite the very files a rollback relies on.
  say "Building into $STAGE_DIR"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR/helper"
  cp -r "$REPO_DIR/src" "$STAGE_DIR/src"
  cp "$REPO_DIR/tsconfig.json" "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" \
     "$REPO_DIR/README.md" "$STAGE_DIR/"
  cp "$REPO_DIR/helper/deckhand-input.c" "$REPO_DIR/helper/Makefile" "$STAGE_DIR/helper/"
  # Built-in icons: the daemon finds them beside dist/ and
  # draws them only as fallbacks; config.json never points here, since this
  # directory is replaced on every update.
  mkdir -p "$STAGE_DIR/assets"
  cp -r "$REPO_DIR/assets/icons" "$STAGE_DIR/assets/icons"
  [ -f "$STAGE_DIR/assets/icons/missing.svg" ] || die "assets/icons/missing.svg did not copy into $STAGE_DIR"

  (
    cd "$STAGE_DIR"
    npm ci                    # dev dependencies too: TypeScript is needed to build
    npm run build:ts
    make -C helper
  )
  # Before the daemon's dev dependencies and src/ go: the editor's build
  # bundles daemon source and resolves its packages from this node_modules.
  build_editor
  (
    cd "$STAGE_DIR"
    # Keep production dependencies only. They are installed on this machine,
    # so the native modules (node-hid, sharp) match this machine's Node.
    # A fresh `npm ci --omit=dev` rather than `npm prune --omit=dev`: in npm
    # 11.16, prune ignores package.json's allowScripts and prints an
    # "install scripts not yet covered" notice for packages already reviewed
    # there; ci honours it and prints nothing.
    rm -rf node_modules
    npm ci --omit=dev
    rm -rf src tsconfig.json helper/deckhand-input.c helper/Makefile
  )
  stage_install_files
  # The Node this install was built with. A release carries its own here
  # instead; either way the unit and the deckhand command run runtime/node.
  mkdir -p "$STAGE_DIR/runtime"
  ln -s "$SERVICE_NODE" "$STAGE_DIR/runtime/node"
  git -C "$REPO_DIR" describe --always --dirty 2>/dev/null > "$STAGE_DIR/VERSION" || echo unknown > "$STAGE_DIR/VERSION"
}

# What an installed copy needs to install, update and remove itself without the
# checkout it came from: this script (deckhand-uninstall runs a copy of it), the
# udev rule, the AppArmor profile and the unit. A release carries the same.
# And the licences: Deckhand's own, and licenses/ for what ships without its
# text (scripts/release.sh names each such package).
stage_install_files() {
  install -m 755 "$REPO_DIR/scripts/install.sh" "$STAGE_DIR/install.sh"
  install -m 644 "$REPO_DIR/LICENSE" "$STAGE_DIR/LICENSE"
  cp -r "$REPO_DIR/licenses" "$STAGE_DIR/licenses"
  install -D -m 644 "$REPO_DIR/udev/60-deckhand.rules" "$STAGE_DIR/udev/60-deckhand.rules"
  install -D -m 644 "$REPO_DIR/apparmor/deckhand-editor" "$STAGE_DIR/apparmor/deckhand-editor"
  install -D -m 644 "$REPO_DIR/systemd/deckhand.service" "$STAGE_DIR/systemd/deckhand.service"
}

# --- A release: download, check, unpack -----------------------------------------
#
# The package and SHA256SUMS come from the release this script belongs to, so
# script and package always match. DECKHAND_RELEASE_BASE points elsewhere (a
# file:// directory, for testing a package before it is published).
#
# What the check proves, and what it does not: the package is byte for byte
# the one SHA256SUMS names — not corrupt, not cut short, not a different
# file. It does not prove who made it. SHA256SUMS comes from the same GitHub
# release, so whoever could replace the package could replace the sums too.

release_asset() { printf 'deckhand-%s-linux-x64.tar.xz' "$RELEASE_VERSION"; }
release_base() { printf '%s' "${DECKHAND_RELEASE_BASE:-https://github.com/juicetheforce/deckhand/releases/download/$RELEASE_VERSION}"; }

download_and_stage() {
  local base asset dl line
  base="$(release_base)"
  asset="$(release_asset)"
  dl="$(mktemp -d "${TMPDIR:-/tmp}/deckhand-download.XXXXXX")"
  say "Downloading Deckhand $RELEASE_VERSION"
  curl -fsSL --retry 2 -o "$dl/SHA256SUMS" "$base/SHA256SUMS" \
    || { rm -rf "$dl"; die "could not download $base/SHA256SUMS; nothing was changed."; }
  curl -fL --retry 2 --progress-bar -o "$dl/$asset" "$base/$asset" \
    || { rm -rf "$dl"; die "could not download $base/$asset; nothing was changed."; }

  say "Checking the download against SHA256SUMS"
  line="$(grep -E "^[0-9a-f]{64}  $asset\$" "$dl/SHA256SUMS" || true)"
  [ -n "$line" ] || { rm -rf "$dl"; die "SHA256SUMS has no line for $asset; nothing was changed."; }
  if ! (cd "$dl" && printf '%s\n' "$line" | sha256sum -c --quiet - >/dev/null 2>&1); then
    rm -rf "$dl"
    die "the download does not match its checksum: it is corrupt, incomplete, or not the file SHA256SUMS names. Nothing was changed; run the install line again."
  fi

  say "Unpacking into $STAGE_DIR"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  if ! tar -xJf "$dl/$asset" -C "$STAGE_DIR" --strip-components=1 --no-same-owner; then
    rm -rf "$dl" "$STAGE_DIR"
    die "could not unpack $asset; nothing was changed."
  fi
  rm -rf "$dl"
  local inside
  inside="$(cat "$STAGE_DIR/VERSION" 2>/dev/null || echo 'no version')"
  [ "$inside" = "$RELEASE_VERSION" ] \
    || { rm -rf "$STAGE_DIR"; die "the package says it is $inside, not $RELEASE_VERSION; nothing was changed."; }
  check_release_stage
}

# The preflight cannot see the binaries until they are here. Before anything
# installed is touched: the bundled Node runs, the daemon's native modules load
# (their system libraries are present), and Electron finds its libraries.
check_release_stage() {
  local node="$STAGE_DIR/runtime/node" absent
  # Each looked for by name: ldd on a file that is not there reports no missing
  # library, so the Electron check below would pass a package without Electron.
  local part
  for part in runtime/node helper/deckhand-input editor/electron/electron; do
    [ -x "$STAGE_DIR/$part" ] || { rm -rf "$STAGE_DIR"; die "the package is incomplete ($part missing); nothing was changed."; }
  done
  [ -f "$STAGE_DIR/dist/index.js" ] || { rm -rf "$STAGE_DIR"; die "the package is incomplete (dist/index.js missing); nothing was changed."; }
  if ! (cd "$STAGE_DIR" && "$node" -e 'require("./node_modules/sharp"); require("./node_modules/node-hid"); require("./node_modules/@elgato-stream-deck/node")' >/dev/null 2>&1); then
    absent="$(find "$STAGE_DIR/node_modules" -name '*.node' -path '*linux-x64*' -exec ldd {} \; 2>/dev/null | awk '/=> not found/ { print $1 }' | sort -u | tr '\n' ' ')" || true
    rm -rf "$STAGE_DIR"
    die "Deckhand's device and image modules do not load on this machine${absent:+ — missing: ${absent% }}. Nothing was changed."
  fi
  check_electron_libraries "$STAGE_DIR/editor/electron/electron"
}

# The editor goes inside the daemon's app directory, built from the same
# checkout in the same run. It bundles daemon source —
# config validation, the action registry, the default icons — so an editor
# installed on its own could silently pair with a daemon from another commit.
# Here the two are always one commit, and roll back together. Inside the app
# directory, the editor's built-in icon lookup finds the daemon's
# assets/icons/ (editor/src/main/builtin-icons.ts).
#
# Kept: dist/{main,preload,renderer}/, dist/THIRD-PARTY-NOTICES.txt (the
# licences of what the bundles contain), package.json (Electron reads "main" and
# "type" from it) and Electron's own runtime, moved to editor/electron/. The
# editor needs no other package at runtime: esbuild and Vite bundle everything
# but electron itself.
build_editor() {
  say "Building the editor into $STAGE_DIR/editor"
  local editor_dir="$STAGE_DIR/editor"
  mkdir -p "$editor_dir/scripts"
  cp -r "$REPO_DIR/editor/src" "$editor_dir/src"
  cp "$REPO_DIR/editor/package.json" "$REPO_DIR/editor/package-lock.json" \
     "$REPO_DIR/editor/tsconfig.main.json" "$REPO_DIR/editor/tsconfig.renderer.json" \
     "$REPO_DIR/editor/vite.config.ts" "$editor_dir/"
  cp "$REPO_DIR/editor/scripts/build-main.mjs" "$REPO_DIR/editor/scripts/third-party-notices.mjs" "$editor_dir/scripts/"
  # The tray icon's PNGs, which the editor build copies into its dist/; the
  # title bar's logo, which Vite bundles into dist/renderer/;
  # and the application icon, png/apps/ and deckhand.svg, which
  # install_desktop_entry installs from the app directory.
  mkdir -p "$STAGE_DIR/assets/logo"
  cp -r "$REPO_DIR/assets/logo/png" "$STAGE_DIR/assets/logo/png"
  cp "$REPO_DIR/assets/logo/deckhand-small.svg" "$REPO_DIR/assets/logo/deckhand.svg" "$STAGE_DIR/assets/logo/"

  (
    cd "$editor_dir"
    npm ci
    # Electron 44 has no install script: its binary is fetched the first time
    # the package is required. Fetch it now. It is checked against the
    # package's checksums.json and cached in ~/.cache/electron, so an update
    # does not download it again.
    node node_modules/electron/install.js
    npm run build
    mv node_modules/electron/dist electron
    rm -rf node_modules src scripts dist/test package-lock.json \
           tsconfig.main.json tsconfig.renderer.json vite.config.ts
    find dist -name '*.map' -delete
  )
  [ -x "$editor_dir/electron/electron" ] || die "the editor's Electron binary is missing from $editor_dir/electron"
  check_electron_libraries "$editor_dir/electron/electron"
  [ -f "$editor_dir/dist/main/main.js" ] && [ -f "$editor_dir/dist/renderer/index.html" ] && [ -f "$editor_dir/dist/icons/tray.png" ] && [ -f "$editor_dir/dist/THIRD-PARTY-NOTICES.txt" ] \
    || die "the editor did not build into $editor_dir/dist"
}

# Electron arrives with the build, so the preflight cannot look at it. This
# runs on the staged copy, before the swap: a shared library the binary links
# against and this machine lacks would otherwise install fine and leave an
# editor that never opens. ldd sees only what is linked, not what Electron
# loads later by name, so a pass here is not a promise.
check_electron_libraries() {
  local binary="$1" absent
  if ! has_command ldd; then
    warn "ldd is not available; not checking the editor's shared libraries."
    return
  fi
  absent="$(ldd "$binary" 2>/dev/null | awk '/=> not found/ { print $1 }' | sort -u | tr '\n' ' ')" || true
  [ -z "$absent" ] \
    || die "the editor's Electron needs shared libraries this machine does not have: ${absent% }. Install the packages that provide them and run this again; nothing was changed."
}

elgato_hidraw_nodes() {
  # Prints /dev/hidrawN for every connected Elgato device (USB vendor 0fd9).
  local dev
  for dev in /sys/class/hidraw/hidraw*; do
    [ -e "$dev" ] || continue
    if grep -qi '^HID_ID=0003:00000FD9:' "$dev/device/uevent" 2>/dev/null; then
      echo "/dev/$(basename "$dev")"
    fi
  done
}

retrigger_udev() {
  # Re-apply rules to devices that are already present, so a rule change takes
  # effect now rather than at the next replug or reboot. Reports failure
  # instead of hiding it.
  local targets=(/sys/class/misc/uinput) node output
  for node in $(elgato_hidraw_nodes); do targets+=("/sys/class/hidraw/${node#/dev/}"); done
  if output="$(sudo udevadm trigger --action=change --settle "${targets[@]}" 2>&1)"; then
    say "udev re-applied to: ${targets[*]}"
  else
    warn "udevadm trigger failed — the rule may not apply until the devices are replugged:"
    printf '%s\n' "$output" >&2
  fi
}

report_device_access() {
  # What actually matters: can this user open the devices? Other packages'
  # rules can grant the same access, so this checks the result, not which rule
  # produced it.
  local node
  if [ -w /dev/uinput ]; then say "access ok: /dev/uinput"; else warn "NO ACCESS: /dev/uinput — keystrokes cannot be injected"; fi
  local found=no
  for node in $(elgato_hidraw_nodes); do
    found=yes
    if [ -w "$node" ]; then say "access ok: $node (Stream Deck)"; else warn "NO ACCESS: $node (Stream Deck)"; fi
  done
  [ "$found" = yes ] || say "no Stream Deck connected, so deck access was not checked"
}

install_udev_rule() {
  if cmp -s "$UDEV_RULE_SRC" "$UDEV_RULE_DST"; then
    say "udev rule already up to date"
  else
    say "Installing udev rule to $UDEV_RULE_DST (needs sudo)"
    sudo install -m 644 "$UDEV_RULE_SRC" "$UDEV_RULE_DST"
    sudo udevadm control --reload
    retrigger_udev
  fi
  report_device_access
}

# The AppArmor profile that lets the editor's Electron start.
# Only where user namespaces are restricted, and only when it is not already
# there: on Fedora, and on a second run, this does nothing and asks for nothing.
install_apparmor_profile() {
  if ! userns_restricted; then
    return
  fi
  if ! apparmor_path_covered; then
    warn "not installing the AppArmor profile: it attaches to ~/.local/share/deckhand/editor/electron/electron, and this install is at $APP_DIR. The editor will not start until a profile matching that path grants it \"userns\"; copy $APPARMOR_PROFILE_SRC, change the path in it, and load it with apparmor_parser -r."
    return
  fi
  if cmp -s "$APPARMOR_PROFILE_SRC" "$APPARMOR_PROFILE_DST"; then
    say "AppArmor profile already up to date"
    return
  fi
  say "Installing AppArmor profile to $APPARMOR_PROFILE_DST, so the editor can start (needs sudo)"
  if sudo install -m 644 "$APPARMOR_PROFILE_SRC" "$APPARMOR_PROFILE_DST" && sudo apparmor_parser -r "$APPARMOR_PROFILE_DST"; then
    say "AppArmor profile loaded"
  else
    # Not fatal: the daemon and the decks do not need it, only the editor does.
    warn "could not install or load the AppArmor profile. The decks will work; the editor will abort at startup with \"The SUID sandbox helper binary was found, but is not configured correctly\"."
  fi
}

service_is_up() {
  # $1 is the service's main PID right after it was started. Up means active,
  # and still the same process: a crash plus automatic restart always gives a
  # new PID. (NRestarts is not used — whether it survives a stop differs
  # between systemd versions and unit states.)
  [ "$(systemctl --user is-active deckhand 2>/dev/null)" = active ] \
    && [ "$(systemctl --user show deckhand -p MainPID --value)" = "$1" ]
}

rollback() {
  warn "the new install did not start — rolling back"
  systemctl --user disable --now deckhand >/dev/null 2>&1 || true
  journalctl --user -u deckhand --since "@$1" --no-pager -n 20 >&2 || true

  rm -rf "$APP_DIR"
  if [ -d "$PREVIOUS_DIR" ]; then
    mv "$PREVIOUS_DIR" "$APP_DIR"
  else
    # First install: there is no previous version to go back to.
    rm -f "$UNIT_FILE"
  fi

  systemctl --user daemon-reload
  if [ -d "$APP_DIR" ]; then
    systemctl --user enable --now deckhand >/dev/null 2>&1 \
      && say "previous version restored and started" \
      || warn "could not restart the previous version — check: systemctl --user status deckhand"
  fi
  die "install failed; see the log above."
}

cmd_install() {
  local allow_dirty=no reinstall=no
  for arg in "$@"; do
    case "$arg" in
      --dirty) is_release && usage; allow_dirty=yes ;;
      --reinstall) is_release || usage; reinstall=yes ;;
      *) usage ;;
    esac
  done

  preflight
  resolve_locations
  # Nothing below touches the running daemon until the swap, so a failed
  # download, check, unpack or build leaves everything as it was.
  if is_release; then
    if [ "$reinstall" = no ] && [ "$(cat "$APP_DIR/VERSION" 2>/dev/null)" = "$RELEASE_VERSION" ]; then
      say "Deckhand $RELEASE_VERSION is already installed. Nothing to do (install --reinstall installs it again)."
      return 0
    fi
    download_and_stage
    UDEV_RULE_SRC="$STAGE_DIR/udev/60-deckhand.rules"
    APPARMOR_PROFILE_SRC="$STAGE_DIR/apparmor/deckhand-editor"
  else
    check_clean_checkout "$allow_dirty"
    build_and_stage
  fi
  install_udev_rule
  install_apparmor_profile

  say "Stopping the running service"
  systemctl --user stop deckhand 2>/dev/null || true

  rm -rf "$PREVIOUS_DIR"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$PREVIOUS_DIR"; fi
  mv "$STAGE_DIR" "$APP_DIR"

  mkdir -p "$UNIT_DIR"
  install -m 644 "$APP_DIR/systemd/deckhand.service" "$UNIT_FILE"

  say "Starting the service"
  local started_at main_pid
  started_at="$(date +%s)"
  systemctl --user daemon-reload
  systemctl --user reset-failed deckhand >/dev/null 2>&1 || true
  systemctl --user enable --now deckhand >/dev/null 2>&1 || rollback "$started_at"
  main_pid="$(systemctl --user show deckhand -p MainPID --value)"
  [ "$main_pid" != 0 ] || rollback "$started_at"

  sleep "$START_SETTLE_SECONDS"
  service_is_up "$main_pid" || rollback "$started_at"

  rm -rf "$PREVIOUS_DIR"
  say "Installed. Service is running from $APP_DIR"
  # Only after a successful start: a rollback restores an older app that may
  # have no CLI, and the wrapper must not point at one that is not there.
  install_cli
  install_editor_launcher
  install_uninstaller
  install_desktop_entry
  journalctl --user -u deckhand --since "@$started_at" --no-pager -o cat | grep -E 'attached|not in config' || \
    warn "no Stream Deck attached yet — is one plugged in?"
}

# --- upgrade -----------------------------------------------------------------
#
# Moves a release checkout (a detached HEAD at a tag, as the README's install
# makes) to the newest release tag, then runs *that* release's install.sh.
#
# The hand-off is an exec, so the old script's install logic never runs
# against the new checkout. The old file is also never read again after the
# checkout: this whole function, and main's case below, are parsed before any
# of it runs, so it does not matter how git replaces the file.
#
# Only tags of exactly the form vMAJOR.MINOR.PATCH count; a pre-release such
# as v0.3.0-rc1 is ignored. The remote is assumed to be "origin", which is
# what the README's clone creates.

cmd_upgrade() {
  [ $# -eq 0 ] || usage
  if is_release; then
    die "this is a release install: to update, run the install line again — curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash"
  fi

  if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "not a git checkout; upgrade needs the clone the install was made from."
  fi
  local branch
  if branch="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD)"; then
    die "the checkout is on the branch \"$branch\", not a release. Upgrade only moves a release checkout; for a branch, pull and run \"scripts/install.sh update\"."
  fi
  if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
    git -C "$REPO_DIR" status --short >&2
    die "the checkout has uncommitted changes (above). Upgrade will not move it."
  fi

  say "Fetching releases"
  git -C "$REPO_DIR" fetch --quiet --tags origin

  local newest
  # "|| true": with no matching tag, grep fails, and under pipefail that would
  # end the script here, silently, instead of at the message below.
  newest="$(git -C "$REPO_DIR" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
  [ -n "$newest" ] || die "no release tags found."

  # "Already there" means the newest release is in HEAD's history, not only
  # that HEAD is that release, so a checkout past it is never moved backwards.
  if git -C "$REPO_DIR" merge-base --is-ancestor "$newest" HEAD; then
    say "Already up to date: $newest is the newest release."
    exit 0
  fi

  say "Moving the checkout to $newest"
  git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet "$newest"
  say "Handing over to $newest's install script"
  exec "$REPO_DIR/scripts/install.sh" update
}

# --- CLI wrapper -------------------------------------------------------------

cli_is_ours() {
  [ -f "$CLI_FILE" ] && grep -qxF "$CLI_MARKER" "$CLI_FILE"
}

editor_launcher_is_ours() {
  [ -f "$EDITOR_LAUNCHER" ] && grep -qxF "$EDITOR_MARKER" "$EDITOR_LAUNCHER"
}

# Writes ~/.local/bin/deckhand. The app path is written in as resolved here —
# from the systemd user manager's XDG_DATA_HOME, the same place the unit's %D
# points — rather than read from the environment when the wrapper runs, which
# for a KDE shortcut or a game launcher may not match.
install_cli() {
  case "$APP_DIR" in
    *"'"*)
      warn "the app directory contains a single quote; not writing the CLI wrapper. Run: '$APP_DIR/runtime/node' '$APP_DIR/dist/cli.js'"
      return
      ;;
  esac
  if [ -e "$CLI_FILE" ] && ! cli_is_ours; then
    warn "$CLI_FILE exists and was not written by Deckhand; leaving it alone."
    warn "The CLI can be run as: $APP_DIR/runtime/node $APP_DIR/dist/cli.js"
    return
  fi
  mkdir -p "$CLI_DIR"
  local tmp="$CLI_FILE.new.$$"
  cat > "$tmp" <<EOF
#!/bin/sh
$CLI_MARKER
# Written by Deckhand's scripts/install.sh; "scripts/install.sh uninstall" removes it.
exec '$APP_DIR/runtime/node' '$APP_DIR/dist/cli.js' "\$@"
EOF
  chmod 755 "$tmp"
  mv "$tmp" "$CLI_FILE"
  say "CLI installed: $CLI_FILE"
  case ":$PATH:" in
    *":$CLI_DIR:"*) ;;
    *) warn "$CLI_DIR is not on PATH in this shell; run $CLI_FILE by its full path, or add $CLI_DIR to PATH." ;;
  esac
}

# Writes ~/.local/bin/deckhand-editor, the same way as the CLI wrapper: the app
# path resolved here, a marker line, never over a file Deckhand did not write.
# ELECTRON_RUN_AS_NODE is cleared because a shell started from VS Code sets it,
# and it turns Electron into plain Node with no window.
install_editor_launcher() {
  case "$APP_DIR" in
    *"'"*)
      warn "the app directory contains a single quote; not writing the editor launcher."
      return
      ;;
  esac
  if [ -e "$EDITOR_LAUNCHER" ] && ! editor_launcher_is_ours; then
    warn "$EDITOR_LAUNCHER exists and was not written by Deckhand; leaving it alone."
    warn "The editor can be run as: env -u ELECTRON_RUN_AS_NODE '$APP_DIR/editor/electron/electron' '$APP_DIR/editor'"
    return
  fi
  mkdir -p "$CLI_DIR"
  local tmp="$EDITOR_LAUNCHER.new.$$"
  cat > "$tmp" <<EOF
#!/bin/sh
$EDITOR_MARKER
# Written by Deckhand's scripts/install.sh; "scripts/install.sh uninstall" removes it.
exec env -u ELECTRON_RUN_AS_NODE '$APP_DIR/editor/electron/electron' '$APP_DIR/editor' "\$@"
EOF
  chmod 755 "$tmp"
  mv "$tmp" "$EDITOR_LAUNCHER"
  say "Editor launcher installed: $EDITOR_LAUNCHER"
}

uninstaller_is_ours() {
  [ -f "$UNINSTALLER" ] && grep -qxF "$UNINSTALL_MARKER" "$UNINSTALLER"
}

# Writes ~/.local/bin/deckhand-uninstall: uninstall with no checkout and no
# network. It runs a temporary copy of the installed install.sh, never the
# installed one, because uninstalling deletes the directory that one lives in.
# The wrapper itself is deleted during the run too; sh keeps reading the file
# it opened, so that is harmless (the same measurement as for upgrade).
install_uninstaller() {
  case "$APP_DIR" in
    *"'"*)
      warn "the app directory contains a single quote; not writing deckhand-uninstall."
      return
      ;;
  esac
  if [ -e "$UNINSTALLER" ] && ! uninstaller_is_ours; then
    warn "$UNINSTALLER exists and was not written by Deckhand; leaving it alone."
    warn "Deckhand can be removed with: bash '$APP_DIR/install.sh' uninstall"
    return
  fi
  mkdir -p "$CLI_DIR"
  local tmp="$UNINSTALLER.new.$$"
  cat > "$tmp" <<WRAPPER
#!/bin/sh
$UNINSTALL_MARKER
# Written by Deckhand's install.sh; it removes itself along with Deckhand.
copy="\$(mktemp "\${TMPDIR:-/tmp}/deckhand-uninstall.XXXXXX")" || exit 1
cp '$APP_DIR/install.sh' "\$copy" || { rm -f "\$copy"; echo "deckhand-uninstall: $APP_DIR/install.sh is missing" >&2; exit 1; }
bash "\$copy" uninstall "\$@"
status=\$?
rm -f "\$copy"
exit \$status
WRAPPER
  chmod 755 "$tmp"
  mv "$tmp" "$UNINSTALLER"
  say "Uninstaller installed: $UNINSTALLER"
}

remove_uninstaller() {
  if uninstaller_is_ours; then
    rm -f "$UNINSTALLER"
    say "Removed $UNINSTALLER"
  elif [ -e "$UNINSTALLER" ]; then
    warn "$UNINSTALLER was not written by Deckhand; leaving it alone."
  fi
}

remove_editor_launcher() {
  if editor_launcher_is_ours; then
    rm -f "$EDITOR_LAUNCHER"
    say "Removed $EDITOR_LAUNCHER"
  elif [ -e "$EDITOR_LAUNCHER" ]; then
    warn "$EDITOR_LAUNCHER was not written by Deckhand; leaving it alone."
  fi
}

# --- The editor's desktop entry and icon -------------------------------------

# The desktop file ID: "desktopName" in the installed editor/package.json,
# without ".desktop". Electron reads the same field and reports it as the
# window's Wayland app_id (and X11 WM_CLASS), which is how KDE matches the
# window to this entry and its icon. One copy, so the two cannot disagree.
# Read with sed, not node: uninstall must work with no Node on the machine.
desktop_id() {
  local name
  name="$(sed -n 's/^[[:space:]]*"desktopName":[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/editor/package.json" | head -n 1)"
  printf '%s\n' "${name%.desktop}"
}

desktop_entry_is_ours() {
  [ -f "$1" ] && grep -qxF "$DESKTOP_MARKER" "$1"
}

# KDE notices a new entry by itself; this makes it immediate.
refresh_desktop_caches() {
  if command -v kbuildsycoca6 >/dev/null 2>&1; then kbuildsycoca6 >/dev/null 2>&1 || true; fi
}

# The icon at every size scripts/render-logo-png.mjs renders, plus the master
# SVG as the scalable one, then the entry. Exec is the launcher, so how the
# editor starts stays in one place; with no launcher of ours, no entry.
install_desktop_entry() {
  local id entry
  id="$(desktop_id)"
  entry="$APPLICATIONS_DIR/$id.desktop"
  if ! editor_launcher_is_ours; then
    warn "no Deckhand editor launcher at $EDITOR_LAUNCHER; not writing a desktop entry."
    return
  fi
  # Exec is written double-quoted; these four would need escaping inside it.
  case "$EDITOR_LAUNCHER" in
    *'"'* | *'`'* | *'$'* | *'\'*)
      warn "the launcher's path has a character a desktop entry cannot hold as written; not writing one."
      return
      ;;
  esac
  if [ -e "$entry" ] && ! desktop_entry_is_ours "$entry"; then
    warn "$entry exists and was not written by Deckhand; leaving it alone."
    return
  fi

  local png size
  for png in "$APP_DIR"/assets/logo/png/apps/*.png; do
    size="$(basename "$png" .png)"
    install -D -m 644 "$png" "$ICON_THEME_DIR/${size}x${size}/apps/$id.png"
  done
  install -D -m 644 "$APP_DIR/assets/logo/deckhand.svg" "$ICON_THEME_DIR/scalable/apps/$id.svg"

  mkdir -p "$APPLICATIONS_DIR"
  local tmp="$entry.new.$$"
  cat > "$tmp" <<ENTRY
[Desktop Entry]
$DESKTOP_MARKER
# Written by Deckhand's scripts/install.sh; "scripts/install.sh uninstall" removes it.
Type=Application
Name=Deckhand
GenericName=Stream Deck Editor
Comment=Linux-based Stream Deck key editor
Exec="$EDITOR_LAUNCHER"
Icon=$id
StartupWMClass=$id
Terminal=false
Categories=Utility;
ENTRY
  chmod 644 "$tmp"
  mv "$tmp" "$entry"
  refresh_desktop_caches
  say "Desktop entry installed: $entry"
}

# The entry, if Deckhand wrote it, and the icon files named for its ID.
remove_desktop_entry() {
  local id="$1"
  local entry="$APPLICATIONS_DIR/$id.desktop"
  if desktop_entry_is_ours "$entry"; then
    rm -f "$entry"
    say "Removed $entry"
  elif [ -e "$entry" ]; then
    warn "$entry was not written by Deckhand; leaving it alone."
  fi
  rm -f "$ICON_THEME_DIR"/*/apps/"$id".png "$ICON_THEME_DIR/scalable/apps/$id.svg"
  refresh_desktop_caches
}

remove_cli() {
  if cli_is_ours; then
    rm -f "$CLI_FILE"
    say "Removed $CLI_FILE"
  elif [ -e "$CLI_FILE" ]; then
    warn "$CLI_FILE was not written by Deckhand; leaving it alone."
  fi
}

# --- uninstall ---------------------------------------------------------------

# The AppArmor profile goes with the app: it names a path that no longer
# exists after an uninstall, and root-owned files should not outlive the app.
remove_apparmor_profile() {
  # `return 0`, not a bare `return`: install.sh runs under `set -e`, and a bare
  # one here would hand back the failed `[ -e ]` and abort the uninstall before
  # it reached the udev rule.
  [ -e "$APPARMOR_PROFILE_DST" ] || return 0
  say "Removing AppArmor profile $APPARMOR_PROFILE_DST (needs sudo)"
  # Unload first: removing the file alone leaves the profile loaded until reboot.
  if sudo apparmor_parser -R "$APPARMOR_PROFILE_DST" 2>/dev/null && sudo rm -f "$APPARMOR_PROFILE_DST"; then
    say "AppArmor profile removed"
  elif sudo rm -f "$APPARMOR_PROFILE_DST"; then
    warn "removed $APPARMOR_PROFILE_DST, but could not unload the profile; it stays loaded until the next reboot. It grants nothing except to a binary that is now gone."
  else
    warn "could not remove $APPARMOR_PROFILE_DST. Remove it with:  sudo apparmor_parser -R $APPARMOR_PROFILE_DST && sudo rm $APPARMOR_PROFILE_DST"
  fi
}

remove_udev_rule() {
  [ -e "$UDEV_RULE_DST" ] || { say "No udev rule to remove"; return; }
  say "Removing udev rule $UDEV_RULE_DST (needs sudo)"
  if sudo rm -f "$UDEV_RULE_DST" && sudo udevadm control --reload; then
    # Re-apply rules so the access this rule granted is withdrawn now, not
    # at the next reboot or replug.
    retrigger_udev
    if [ -w /dev/uinput ]; then
      warn "/dev/uinput is still writable by you after removing Deckhand's rule — another package's rule grants it (not Deckhand's to remove)."
    else
      say "/dev/uinput access withdrawn"
    fi
  else
    warn "COULD NOT REMOVE THE UDEV RULE. It still grants uinput access to your user's processes."
    warn "Remove it with:  sudo rm $UDEV_RULE_DST && sudo udevadm control --reload"
  fi
}

cmd_uninstall() {
  local purge=no
  for arg in "$@"; do
    case "$arg" in
      --purge) purge=yes ;;
      *) usage ;;
    esac
  done

  [ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root."
  resolve_locations

  say "Stopping and disabling the service"
  systemctl --user disable --now deckhand >/dev/null 2>&1 || true

  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload

  # Before the app directory goes: the ID is read from it.
  if [ -f "$APP_DIR/editor/package.json" ]; then remove_desktop_entry "$(desktop_id)"; fi
  remove_cli
  remove_editor_launcher
  remove_uninstaller

  say "Removing $APP_DIR"
  rm -rf "$APP_DIR" "$STAGE_DIR" "$PREVIOUS_DIR"
  rm -rf "${TMPDIR:-/tmp}/deckhand-art"

  # App state, not the user's config: removed with the app, never asked about.
  # Said out loud, because it holds the config backups.
  if [ -d "$STATE_DIR" ]; then
    local backup_count
    backup_count="$(find "$STATE_DIR/backups" -maxdepth 1 -name 'config-*.json' 2>/dev/null | wc -l)"
    rm -rf "$STATE_DIR"
    say "Removed $STATE_DIR (app state, including $backup_count config backup(s))"
  fi

  remove_apparmor_profile
  remove_udev_rule

  if [ -d "$CONFIG_DIR" ]; then
    if [ "$purge" = no ] && [ -t 0 ]; then
      local answer
      read -r -p "Also remove your Deckhand config at $CONFIG_DIR? [y/N] " answer
      case "$answer" in [yY]|[yY][eE][sS]) purge=yes ;; esac
    fi
    if [ "$purge" = yes ]; then
      rm -rf "$CONFIG_DIR"
      say "Removed $CONFIG_DIR"
    else
      say "Kept your config at $CONFIG_DIR"
    fi
  fi

  say "Uninstalled."
}

# --- main --------------------------------------------------------------------
#
# Everything above is definitions; the one call is the file's last line. So a
# download cut short runs nothing, and under `curl … | bash` the whole script
# has been read from the pipe before any of it runs.

main() {
  # Piped (`curl … | bash`), stdin is the script — already read to its end by
  # the time this runs. Every prompt, and every command that might read, gets
  # the real terminal instead. With no terminal at all (no controlling tty),
  # stdin stays as it is and the prompts see there is no one to ask.
  if [ ! -t 0 ] && { true </dev/tty; } 2>/dev/null; then
    exec </dev/tty
  fi
  # A release's install line passes no arguments: installing is the default.
  if [ $# -eq 0 ] && is_release; then set -- install; fi
  [ $# -ge 1 ] || usage
  local command="$1"; shift
  case "$command" in
    install|update) cmd_install "$@" ;;
    upgrade)        cmd_upgrade "$@" ;;
    uninstall)      cmd_uninstall "$@" ;;
    check)          cmd_check "$@" ;;
    *)              usage ;;
  esac
}

main "$@"
