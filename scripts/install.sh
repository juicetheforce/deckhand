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
#   ~/.local/bin/deckhand                     the CLI: a small wrapper that runs
#                                             dist/cli.js from the app directory
#   /etc/udev/rules.d/60-deckhand.rules       the only file needing sudo
#   $XDG_CONFIG_HOME/deckhand/                your config — never touched by
#                                             install; uninstall asks
#   $XDG_STATE_HOME/deckhand/                 the app's state: rolling config
#                                             backups. Uninstall removes it
#                                             without asking (it goes with the
#                                             app, not with your config)
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

# The CLI wrapper. ~/.local/bin is the XDG location for a user's executables
# and has no environment variable of its own. The marker line is how install
# and uninstall recognise a wrapper they wrote, so an unrelated "deckhand"
# command is never overwritten or deleted.
CLI_DIR="$HOME/.local/bin"
CLI_FILE="$CLI_DIR/deckhand"
CLI_MARKER='# deckhand-cli-wrapper'

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
  # The daemon reads XDG_STATE_HOME from the same user manager environment.
  STATE_HOME="$(manager_env XDG_STATE_HOME)"
  STATE_HOME="${STATE_HOME:-$HOME/.local/state}"

  APP_DIR="$DATA_HOME/deckhand"
  STAGE_DIR="$DATA_HOME/deckhand.new"
  PREVIOUS_DIR="$DATA_HOME/deckhand.old"
  UNIT_DIR="$DATA_HOME/systemd/user"
  UNIT_FILE="$UNIT_DIR/deckhand.service"
  LEGACY_UNIT="$CONFIG_HOME/systemd/user/deckhand.service"
  LEGACY_BACKUP="$DATA_HOME/deckhand.legacy-unit.bak"
  CONFIG_DIR="$CONFIG_HOME/deckhand"
  STATE_DIR="$STATE_HOME/deckhand"
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

  (
    cd "$STAGE_DIR"
    npm ci                    # dev dependencies too: TypeScript is needed to build
    npm run build:ts
    make -C helper
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

  # Nothing below touches the running daemon until the swap, so a failed build
  # or npm ci leaves everything as it was.
  build_and_stage
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
  local started_at main_pid
  started_at="$(date +%s)"
  systemctl --user daemon-reload
  systemctl --user reset-failed deckhand >/dev/null 2>&1 || true
  systemctl --user enable --now deckhand >/dev/null 2>&1 || rollback "$started_at"
  main_pid="$(systemctl --user show deckhand -p MainPID --value)"
  [ "$main_pid" != 0 ] || rollback "$started_at"

  sleep "$START_SETTLE_SECONDS"
  service_is_up "$main_pid" || rollback "$started_at"

  rm -rf "$PREVIOUS_DIR" "$LEGACY_BACKUP"
  say "Installed. Service is running from $APP_DIR"
  # Only after a successful start: a rollback restores an older app that may
  # have no CLI, and the wrapper must not point at one that is not there.
  install_cli
  journalctl --user -u deckhand --since "@$started_at" --no-pager -o cat | grep -E 'attached|not in config' || \
    warn "no Stream Deck attached yet — is one plugged in?"
}

# --- CLI wrapper -------------------------------------------------------------

cli_is_ours() {
  [ -f "$CLI_FILE" ] && grep -qxF "$CLI_MARKER" "$CLI_FILE"
}

# Writes ~/.local/bin/deckhand. The app path is written in as resolved here —
# from the systemd user manager's XDG_DATA_HOME, the same place the unit's %D
# points — rather than read from the environment when the wrapper runs, which
# for a KDE shortcut or a game launcher may not match.
install_cli() {
  case "$APP_DIR" in
    *"'"*)
      warn "the app directory contains a single quote; not writing the CLI wrapper. Run: node '$APP_DIR/dist/cli.js'"
      return
      ;;
  esac
  if [ -e "$CLI_FILE" ] && ! cli_is_ours; then
    warn "$CLI_FILE exists and was not written by Deckhand; leaving it alone."
    warn "The CLI can be run as: /usr/bin/node $APP_DIR/dist/cli.js"
    return
  fi
  mkdir -p "$CLI_DIR"
  local tmp="$CLI_FILE.new.$$"
  cat > "$tmp" <<EOF
#!/bin/sh
$CLI_MARKER
# Written by Deckhand's scripts/install.sh; "scripts/install.sh uninstall" removes it.
exec /usr/bin/node '$APP_DIR/dist/cli.js' "\$@"
EOF
  chmod 755 "$tmp"
  mv "$tmp" "$CLI_FILE"
  say "CLI installed: $CLI_FILE"
  case ":$PATH:" in
    *":$CLI_DIR:"*) ;;
    *) warn "$CLI_DIR is not on PATH in this shell; run $CLI_FILE by its full path, or add $CLI_DIR to PATH." ;;
  esac
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
  if [ -e "$LEGACY_UNIT" ] && grep -qxF "$LEGACY_EXEC_LINE" "$LEGACY_UNIT"; then
    rm -f "$LEGACY_UNIT"
  fi
  systemctl --user daemon-reload

  remove_cli

  say "Removing $APP_DIR"
  rm -rf "$APP_DIR" "$STAGE_DIR" "$PREVIOUS_DIR" "$LEGACY_BACKUP"
  rm -rf "${TMPDIR:-/tmp}/deckhand-art"

  # App state, not the user's config: removed with the app, never asked about
  # (docs/scope.md §0). Said out loud, because it holds the config backups.
  if [ -d "$STATE_DIR" ]; then
    local backup_count
    backup_count="$(find "$STATE_DIR/backups" -maxdepth 1 -name 'config-*.json' 2>/dev/null | wc -l)"
    rm -rf "$STATE_DIR"
    say "Removed $STATE_DIR (app state, including $backup_count config backup(s))"
  fi

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
