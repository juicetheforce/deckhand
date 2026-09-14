#!/bin/bash
#
# Deckhand install / update / uninstall — for the daemon only.
#
#   scripts/install.sh install [--dirty]
#   scripts/install.sh update  [--dirty]     (same as install)
#   scripts/install.sh uninstall [--purge]
#
# Layout (docs/scope.md §0), per user, nothing under /usr except the udev rule:
#
#   $XDG_DATA_HOME/deckhand/                  the app: dist/, node_modules/,
#                                             helper/deckhand-input, ...
#   $XDG_DATA_HOME/systemd/user/deckhand.service
#   /etc/udev/rules.d/60-deckhand.rules       the only file needing sudo
#   $XDG_CONFIG_HOME/deckhand/                your config — never touched by
#                                             install; uninstall asks
#
# Run it from a git checkout of Deckhand, as your normal user (not root).
# It checks for prerequisites but does not install them.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UDEV_RULE_SRC="$REPO_DIR/udev/60-deckhand.rules"
UDEV_RULE_DST="/etc/udev/rules.d/60-deckhand.rules"

# The unit file used to be copied into ~/.config/systemd/user/ and pointed at a
# checkout in ~/src/deckhand. A unit there overrides the installed one, so an
# old copy has to go. This line identifies that old copy.
LEGACY_EXEC_LINE='ExecStart=/usr/bin/node %h/src/deckhand/dist/index.js'

# How long the service must stay up, without restarting, to count as started.
START_SETTLE_SECONDS=8

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

  APP_DIR="$DATA_HOME/deckhand"
  STAGE_DIR="$DATA_HOME/deckhand.new"
  PREVIOUS_DIR="$DATA_HOME/deckhand.old"
  UNIT_DIR="$DATA_HOME/systemd/user"
  UNIT_FILE="$UNIT_DIR/deckhand.service"
  LEGACY_UNIT="$CONFIG_HOME/systemd/user/deckhand.service"
  LEGACY_BACKUP="$DATA_HOME/deckhand.legacy-unit.bak"
  CONFIG_DIR="$CONFIG_HOME/deckhand"
}

# --- Checks ------------------------------------------------------------------

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed. $2"
}

preflight() {
  [ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root. It asks for sudo only for the udev rule."

  systemctl --user show-environment >/dev/null 2>&1 \
    || die "cannot reach the systemd user manager (systemctl --user). Run this from your desktop session."

  require_command node  "Install Node.js 20 or newer."
  require_command npm   "Install npm."
  require_command make  "Install make."
  require_command cc    "Install gcc."
  require_command pactl "Install pipewire-pulseaudio (it provides pactl)."

  # The unit runs /usr/bin/node. Stop rather than install a unit that points
  # at a node this machine doesn't have.
  local node_path
  node_path="$(command -v node)"
  [ "$node_path" = "/usr/bin/node" ] \
    || die "node is at $node_path, but the service runs /usr/bin/node. Install Node.js from your distribution's packages."

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 20 ] || die "Node.js $node_major is too old; Deckhand needs 20 or newer."

  [ -f "$REPO_DIR/package.json" ] && [ -f "$UDEV_RULE_SRC" ] \
    || die "run this script from inside a Deckhand checkout."
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

# Returns 0 if the unit in ~/.config/systemd/user is the old checkout-pointing
# copy this script is allowed to remove, 1 if there is none, and stops the
# script if there is one it did not write.
legacy_unit_present() {
  [ -e "$LEGACY_UNIT" ] || return 1
  if grep -qxF "$LEGACY_EXEC_LINE" "$LEGACY_UNIT"; then
    return 0
  fi
  die "$LEGACY_UNIT exists and was not written by an earlier Deckhand setup. It would override the installed unit. Move it aside and run this again."
}

# --- install / update --------------------------------------------------------

build_in_checkout() {
  say "Building in $REPO_DIR"
  # tsc never deletes output for source files that no longer exist, so start
  # from an empty dist/ to keep stale files out of the install.
  (cd "$REPO_DIR" && rm -rf dist && npm ci && npm run build:ts && make -C helper)
}

stage_app() {
  say "Staging into $STAGE_DIR"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR/helper"
  cp -r "$REPO_DIR/dist" "$STAGE_DIR/dist"
  cp "$REPO_DIR/helper/deckhand-input" "$STAGE_DIR/helper/deckhand-input"
  cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$REPO_DIR/README.md" "$STAGE_DIR/"
  # Production dependencies only, installed here so the native modules
  # (node-hid, sharp) match this machine's Node.
  (cd "$STAGE_DIR" && npm ci --omit=dev)
}

install_udev_rule() {
  if cmp -s "$UDEV_RULE_SRC" "$UDEV_RULE_DST"; then
    say "udev rule already up to date"
    return
  fi
  say "Installing udev rule to $UDEV_RULE_DST (needs sudo)"
  sudo install -m 644 "$UDEV_RULE_SRC" "$UDEV_RULE_DST"
  sudo udevadm control --reload
  # Re-apply rules to devices that are already present.
  sudo udevadm trigger --action=change /sys/class/misc/uinput /sys/class/hidraw/hidraw* 2>/dev/null || true
}

service_is_up() {
  # Active, and has not restarted since it was started.
  [ "$(systemctl --user is-active deckhand 2>/dev/null)" = active ] \
    && [ "$(systemctl --user show deckhand -p NRestarts --value)" = 0 ]
}

rollback() {
  warn "the new install did not start — rolling back"
  systemctl --user disable --now deckhand >/dev/null 2>&1 || true
  journalctl --user -u deckhand --since "@$1" --no-pager -n 20 >&2 || true

  rm -rf "$APP_DIR"
  if [ -d "$PREVIOUS_DIR" ]; then
    mv "$PREVIOUS_DIR" "$APP_DIR"
  else
    # First install: there was no previous app, only the old unit.
    rm -f "$UNIT_FILE"
  fi
  if [ -f "$LEGACY_BACKUP" ]; then
    mv "$LEGACY_BACKUP" "$LEGACY_UNIT"
  fi

  systemctl --user daemon-reload
  if [ -d "$APP_DIR" ] || [ -f "$LEGACY_UNIT" ]; then
    systemctl --user enable --now deckhand >/dev/null 2>&1 \
      && say "previous version restored and started" \
      || warn "could not restart the previous version — check: systemctl --user status deckhand"
  fi
  die "install failed; see the log above."
}

cmd_install() {
  local allow_dirty=no
  for arg in "$@"; do
    case "$arg" in
      --dirty) allow_dirty=yes ;;
      *) usage ;;
    esac
  done

  preflight
  resolve_locations
  check_clean_checkout "$allow_dirty"
  local migrating_legacy=no
  if legacy_unit_present; then migrating_legacy=yes; fi

  # Nothing below the build touches the running daemon until the swap, so a
  # failed build or npm ci leaves everything as it was.
  build_in_checkout
  stage_app
  install_udev_rule

  say "Stopping the running service"
  systemctl --user stop deckhand 2>/dev/null || true

  if [ "$migrating_legacy" = yes ]; then
    say "Removing the old unit at $LEGACY_UNIT (kept as a backup until the new one starts)"
    systemctl --user disable deckhand >/dev/null 2>&1 || true
    mv "$LEGACY_UNIT" "$LEGACY_BACKUP"
  fi

  rm -rf "$PREVIOUS_DIR"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$PREVIOUS_DIR"; fi
  mv "$STAGE_DIR" "$APP_DIR"

  mkdir -p "$UNIT_DIR"
  install -m 644 "$REPO_DIR/systemd/deckhand.service" "$UNIT_FILE"

  say "Starting the service"
  local started_at
  started_at="$(date +%s)"
  systemctl --user daemon-reload
  systemctl --user enable --now deckhand >/dev/null 2>&1 || rollback "$started_at"

  sleep "$START_SETTLE_SECONDS"
  service_is_up || rollback "$started_at"

  rm -rf "$PREVIOUS_DIR" "$LEGACY_BACKUP"
  say "Installed. Service is running from $APP_DIR"
  journalctl --user -u deckhand --since "@$started_at" --no-pager -o cat | grep -E 'attached|not in config' || \
    warn "no Stream Deck attached yet — is one plugged in?"
}

# --- uninstall ---------------------------------------------------------------

remove_udev_rule() {
  [ -e "$UDEV_RULE_DST" ] || { say "No udev rule to remove"; return; }
  say "Removing udev rule $UDEV_RULE_DST (needs sudo)"
  if sudo rm -f "$UDEV_RULE_DST" && sudo udevadm control --reload; then
    # Re-apply rules so the access this rule granted is withdrawn now, not
    # at the next reboot or replug.
    sudo udevadm trigger --action=change /sys/class/misc/uinput /sys/class/hidraw/hidraw* 2>/dev/null || true
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
  if [ -e "$LEGACY_UNIT" ] && grep -qxF "$LEGACY_EXEC_LINE" "$LEGACY_UNIT"; then
    rm -f "$LEGACY_UNIT"
  fi
  systemctl --user daemon-reload

  say "Removing $APP_DIR"
  rm -rf "$APP_DIR" "$STAGE_DIR" "$PREVIOUS_DIR" "$LEGACY_BACKUP"
  rm -rf "${TMPDIR:-/tmp}/deckhand-art"

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

[ $# -ge 1 ] || usage
command="$1"; shift
case "$command" in
  install|update) cmd_install "$@" ;;
  uninstall)      cmd_uninstall "$@" ;;
  *)              usage ;;
esac
