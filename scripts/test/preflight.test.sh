#!/bin/bash
# The install preflight (Ship): preflight_checks, preflight, cmd_check and
# check_electron_libraries from scripts/install.sh, against stub commands and
# scratch paths. Sources install.sh's functions (everything above its "main"
# section), so it tests the real code and touches nothing on this machine.
#
# PATH holds only the stubs and a few basic tools, so a command the test
# removes is really absent — the real node, pactl or busctl cannot stand in.
#
# Usage: bash scripts/test/preflight.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"

fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

# --- A shared library that exists at link time and is then taken away ----------
# Built before PATH is narrowed, with the real compiler.
mkdir -p "$S/lib"
echo 'int deckhand_probe(void) { return 0; }' > "$S/lib/probe.c"
echo 'int deckhand_probe(void); int main(void) { return deckhand_probe(); }' > "$S/lib/main.c"
cc -shared -fPIC -o "$S/lib/libdeckhandprobe.so" "$S/lib/probe.c" \
  && cc -o "$S/lib/links-ok" "$S/lib/main.c" -L"$S/lib" -ldeckhandprobe -Wl,-rpath,"$S/lib" \
  && cc -o "$S/lib/links-gone" "$S/lib/main.c" -L"$S/lib" -ldeckhandprobe -Wl,-rpath,"$S/lib/gone" \
  || { echo "FAIL  could not build the test binaries"; exit 1; }

# --- Basic tools, and stubs ---------------------------------------------------
mkdir -p "$S/base" "$S/stubs.orig"
# cat … ldd are what install.sh's checks use; rm is for the setups below.
for tool in cat cmp sed tr git uname awk sort ldd rm cp chmod; do
  ln -s "$(command -v "$tool")" "$S/base/$tool"
done
stub() { printf '#!/bin/bash\n%s\n' "$2" > "$S/stubs.orig/$1"; chmod 755 "$S/stubs.orig/$1"; }
stub id 'case "$1" in -u) echo "${STUB_UID:-1000}" ;; -un) echo tester ;; esac'
stub systemctl '
case "$*" in
  "--user show-environment") [ -n "${STUB_NO_MANAGER:-}" ] && exit 1; echo XDG_CURRENT_DESKTOP=Test; echo XDG_SESSION_TYPE=wayland ;;
  "--user is-active graphical-session.target") echo "${STUB_GRAPHICAL:-active}" ;;
  *) exit 1 ;;
esac'
stub busctl '
[ -n "${STUB_NO_BUS:-}" ] && exit 1
[ "$1 $2" = "--user status" ] && exit 0
name="${!#}"
case " ${STUB_BUS_ABSENT:-} " in *" $name "*) echo "b false" ;; *) echo "b true" ;; esac'
stub loginctl '
case "$1" in
  show-user) echo "${STUB_DISPLAY-2}" ;;
  show-session) echo "${STUB_SEAT-seat0}" ;;
esac'
stub pactl 'exit "${STUB_PACTL_RC:-0}"'
stub node 'echo "v${STUB_NODE_VERSION:-22.12.0}"'
stub npm 'echo 11.0.0'
for tool in make cc udevadm apparmor_parser; do stub "$tool" 'exit 0'; done
# sudo runs what it is handed: the offer below builds a "sudo <manager> ..."
# command, and the test has to see the manager receive it.
stub sudo 'exec "$@"'

# --- One run -------------------------------------------------------------------
# run '<setup>' — a fresh copy of the stubs and scratch paths, the setup
# evaluated (to remove a stub or change a path), then preflight_checks.
# Prints one line per finding: "M: …" missing, "W: …" warning.
run() {
  rm -rf "$S/stubs" "$S/sys" "$S/seats" "$S/installed.apparmor"
  cp -a "$S/stubs.orig" "$S/stubs"
  mkdir -p "$S/sys/kernel" "$S/sys/user" "$S/seats/seat0"
  touch "$S/uinput.h"
  cp "$REPO/udev/60-deckhand.rules" "$S/installed.rules"
  (
    # Sourced with the real PATH (it resolves REPO_DIR with dirname), then
    # narrowed. It also turns on `set -e`, so a failing setup ends the run
    # early — which the END marker below makes a failure, not a quiet pass.
    # shellcheck source=/dev/null
    source "$S/fns.sh"
    export PATH="$S/stubs:$S/base" HOME="$S/home"
    REPO_DIR="$REPO"; UDEV_RULE_SRC="$REPO/udev/60-deckhand.rules"   # fns.sh would resolve them from $S
    SERVICE_NODE="$S/stubs/node"; UINPUT_NODE=/dev/null   # a character device
    UINPUT_HEADER="$S/uinput.h"; LOGIND_SEATS_DIR="$S/seats"; SYSCTL_DIR="$S/sys"
    UDEV_RULE_DST="$S/installed.rules"
    APPARMOR_PROFILE_SRC="$REPO/apparmor/deckhand-editor"
    APPARMOR_PROFILE_DST="$S/installed.apparmor"   # absent unless a setup puts it there
    eval "$1"
    preflight_checks
    for m in "${PREFLIGHT_MISSING[@]}"; do echo "M: $m"; done
    for w in "${PREFLIGHT_WARNINGS[@]}"; do echo "W: $w"; done
    # "C: ..." is the one command the offer would show. There is none on a
    # machine with no package manager this script knows, which is every run
    # that does not call pm_stub, so the lines above are unaffected.
    if build_install_command; then echo "C: $PREFLIGHT_INSTALL_COMMAND"; fi
    echo END
  )
}

# A run that ended early (a failing setup under set -e) printed no END.
completed() { [ "$(tail -n 1 <<<"$1")" = END ]; }

# expect_missing '<label>' '<setup>' '<text the one missing item must contain>'
expect_missing() {
  local out n
  out="$(run "$2")"
  n="$(grep -c '^M: ' <<<"$out")"
  if completed "$out" && [ "$n" = 1 ] && grep -q "^M: .*$3" <<<"$out"; then ok "$1"; else no "$1 — got: ${out:-nothing}"; fi
}
# expect_clean '<label>' '<setup>' — nothing missing (warnings allowed)
expect_clean() {
  local out
  out="$(run "$2")"
  if completed "$out" && ! grep -q '^M: ' <<<"$out"; then ok "$1"; else no "$1 — got: $out"; fi
}
# expect_warning '<label>' '<setup>' '<text>' — exactly one warning, nothing missing
expect_warning() {
  local out
  out="$(run "$2")"
  if completed "$out" && ! grep -q '^M: ' <<<"$out" && [ "$(grep -c '^W: ' <<<"$out")" = 1 ] && grep -q "^W: .*$3" <<<"$out"; then ok "$1"; else no "$1 — got: ${out:-nothing}"; fi
}

out="$(run '')"
[ "$out" = END ] && ok "everything present: nothing missing, no warnings" || no "everything present — got: $out"

# Each requirement on its own: named, and the only thing named.
expect_missing "root"                        'export STUB_UID=0'                       'Running as root'
expect_missing "no systemd"                  'rm "$S/stubs/systemctl"'                 'systemctl: Deckhand runs'
expect_missing "user manager unreachable"    'export STUB_NO_MANAGER=1'                'systemd user manager'
expect_missing "graphical session inactive"  'export STUB_GRAPHICAL=inactive'          'graphical-session.target is not active'
expect_missing "no busctl"                   'rm "$S/stubs/busctl"'                    'busctl (part of systemd)'
expect_missing "no session bus"              'export STUB_NO_BUS=1'                    'No D-Bus session bus'
expect_missing "no logind"                   'rm -r "$S/seats"'                        'systemd-logind is not running'
expect_missing "no loginctl"                 'rm "$S/stubs/loginctl"'                  'systemd-logind is not running'
expect_missing "no display session"          'export STUB_DISPLAY='                    'no graphical login session on a seat'
expect_missing "display session with no seat" 'export STUB_SEAT='                      'no graphical login session on a seat'
expect_missing "no node"                     'rm "$S/stubs/node"'                      'node: install Node.js'
expect_missing "node on PATH is not the service's" 'SERVICE_NODE=/usr/bin/node-elsewhere' 'node on your PATH is'
expect_missing "node 22.11 is too old"       'export STUB_NODE_VERSION=22.11.9'        'Node.js 22.11.9 is too old'
expect_missing "node 20 is too old"          'export STUB_NODE_VERSION=20.19.0'        'Node.js 20.19.0 is too old'
expect_missing "node version unreadable"     'export STUB_NODE_VERSION=garbage'        'Cannot tell which Node.js'
expect_clean   "node 22.12.0 is enough"      'export STUB_NODE_VERSION=22.12.0'
expect_clean   "node 23.0.0 is enough"       'export STUB_NODE_VERSION=23.0.0'
expect_clean   "node 100.1.0 is enough"      'export STUB_NODE_VERSION=100.1.0'
expect_missing "no npm"                      'rm "$S/stubs/npm"'                       'npm: install it'
expect_missing "no make"                     'rm "$S/stubs/make"'                      'make: needed'
expect_missing "no C compiler"               'rm "$S/stubs/cc"'                        'A C compiler'
expect_missing "no uinput header"            'rm "$S/uinput.h"'                        'uinput.h: the helper'
expect_missing "no /dev/uinput"              'UINPUT_NODE="$S/no-such-node"'           'does not exist, so keystrokes'
expect_missing "/dev/uinput is a plain file" 'UINPUT_NODE="$S/uinput.h"'               'does not exist, so keystrokes'
expect_missing "no pactl"                    'rm "$S/stubs/pactl"'                     'pactl: install'
expect_missing "no sound server"             'export STUB_PACTL_RC=1'                  'cannot reach a sound server'
expect_missing "rule to install, no sudo"    'rm "$S/stubs/sudo" "$S/installed.rules"' 'sudo: needed once'
expect_missing "rule to install, no udevadm" 'rm "$S/stubs/udevadm" "$S/installed.rules"' 'udevadm: needed'
expect_clean   "rule current: no sudo needed" 'rm "$S/stubs/sudo" "$S/stubs/udevadm"'

# Several at once: all named, not only the first.
out="$(run 'rm "$S/stubs/make"; UINPUT_NODE="$S/no-such-node"; export STUB_PACTL_RC=1 STUB_UID=0')"
if completed "$out" && [ "$(grep -c '^M: ' <<<"$out")" = 4 ] && grep -q '^M: make:' <<<"$out" && grep -q 'keystrokes' <<<"$out" \
   && grep -q 'sound server' <<<"$out" && grep -q 'Running as root' <<<"$out"; then
  ok "four missing at once: all four named"
else
  no "four missing at once — got: $out"
fi

# Warnings: named, and the install is not refused for them.
expect_warning "no tray"                      'export STUB_BUS_ABSENT=org.kde.StatusNotifierWatcher' 'No system tray'
expect_warning "no KDE shortcut service"      'export STUB_BUS_ABSENT=org.kde.kglobalaccel'          'No KDE shortcut service'
expect_warning "AppArmor userns restriction"  'echo 1 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"' 'The editor needs an AppArmor profile here'
# The profile this install would add is the answer to that one, so once it is
# in place there is nothing to warn about (docs/scope.md §7, Portability).
expect_clean   "userns restricted but the profile is installed" \
  'echo 1 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; cp "$REPO/apparmor/deckhand-editor" "$S/installed.apparmor"'
out="$(run 'echo 1 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; cp "$REPO/apparmor/deckhand-editor" "$S/installed.apparmor"')"
[ "$out" = END ] && ok "profile installed: no userns warning at all" || no "profile installed — got: $out"
# Installing it needs root and apparmor_parser, and only when it is not current.
expect_missing "no apparmor_parser when the profile is needed" \
  'echo 1 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; rm "$S/stubs/apparmor_parser"' \
  'apparmor_parser: needed to load'
expect_clean   "no apparmor_parser but the profile is current" \
  'echo 1 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; cp "$REPO/apparmor/deckhand-editor" "$S/installed.apparmor"; rm "$S/stubs/apparmor_parser"'
expect_warning "userns_clone off"             'echo 0 > "$S/sys/kernel/unprivileged_userns_clone"'            'unprivileged_userns_clone = 0'
expect_warning "max_user_namespaces 0"        'echo 0 > "$S/sys/user/max_user_namespaces"'                    'max_user_namespaces = 0'
expect_clean   "userns allowed: no warning"   'echo 0 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; echo 1 > "$S/sys/kernel/unprivileged_userns_clone"'
out="$(run 'echo 0 > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; echo 1 > "$S/sys/kernel/unprivileged_userns_clone"; echo 1000 > "$S/sys/user/max_user_namespaces"')"
[ "$out" = END ] && ok "permissive userns sysctls: no warning at all" || no "permissive userns sysctls — got: $out"
# A switch no profile can override still names the symptom, because nothing
# this installer does will fix it.
out="$(run 'echo 0 > "$S/sys/kernel/unprivileged_userns_clone"')"
completed "$out" && grep -q 'SUID sandbox helper' <<<"$out" && ok "the unfixable userns warning names the likely symptom" || no "unfixable userns warning has no symptom"
out="$(run 'echo 0 > "$S/sys/kernel/unprivileged_userns_clone"')"
completed "$out" && grep -q 'will not start' <<<"$out" && ok "the unfixable case says the editor will not start" || no "unfixable case wording — got: $out"
out="$(run 'export STUB_NO_BUS=1')"
completed "$out" && ! grep -q '^W: ' <<<"$out" && ok "no bus: no tray or shortcut warnings on top" || no "no bus — got: $out"

# The two entry points: what stops an install, and check's exit status.
entry() {  # entry '<setup>' '<function>' — prints its output, then "rc=N"
  rm -rf "$S/stubs"; cp -a "$S/stubs.orig" "$S/stubs"; mkdir -p "$S/seats/seat0"; touch "$S/uinput.h"
  cp "$REPO/udev/60-deckhand.rules" "$S/installed.rules"
  (
    source "$S/fns.sh"
    export PATH="$S/stubs:$S/base" HOME="$S/home"
    REPO_DIR="$REPO"; UDEV_RULE_SRC="$REPO/udev/60-deckhand.rules"   # fns.sh would resolve them from $S
    SERVICE_NODE="$S/stubs/node"; UINPUT_NODE=/dev/null; UINPUT_HEADER="$S/uinput.h"
    LOGIND_SEATS_DIR="$S/seats"; SYSCTL_DIR="$S/sys"; UDEV_RULE_DST="$S/installed.rules"
    eval "$1"
    "$2"
  ) 2>&1
  echo "rc=$?"
}
out="$(entry 'export STUB_PACTL_RC=1' preflight)"
grep -q 'rc=1$' <<<"$out" && grep -q 'nothing was changed' <<<"$out" && grep -q 'sound server' <<<"$out" \
  && ok "preflight: something missing stops the install, says so, names it" || no "preflight with a gap — got: $out"
out="$(entry 'export STUB_BUS_ABSENT=org.kde.StatusNotifierWatcher' preflight)"
grep -q 'rc=0$' <<<"$out" && grep -q 'No system tray' <<<"$out" \
  && ok "preflight: a warning is shown and the install goes on" || no "preflight with a warning — got: $out"
out="$(entry 'export STUB_PACTL_RC=1' cmd_check)"
grep -q 'rc=1$' <<<"$out" && grep -q 'distro' <<<"$out" && grep -q 'sound server' <<<"$out" \
  && ok "check: header, the gap named, exit 1" || no "check with a gap — got: $out"
out="$(entry 'export STUB_BUS_ABSENT=org.kde.kglobalaccel' cmd_check)"
grep -q 'rc=0$' <<<"$out" && grep -q 'Every requirement is met' <<<"$out" && grep -q 'KDE shortcut' <<<"$out" \
  && ok "check: warnings only, exit 0" || no "check with a warning — got: $out"

# check_electron_libraries: a binary whose library is gone stops the install, naming it.
out="$( (source "$S/fns.sh"; export PATH="$S/base"; check_electron_libraries "$S/lib/links-ok") 2>&1; echo "rc=$?")"
grep -q 'rc=0$' <<<"$out" && ok "electron libraries: all found, passes" || no "linked binary — got: $out"
out="$( (source "$S/fns.sh"; export PATH="$S/base"; check_electron_libraries "$S/lib/links-gone") 2>&1; echo "rc=$?")"
grep -q 'rc=1$' <<<"$out" && grep -q 'libdeckhandprobe.so' <<<"$out" \
  && ok "electron libraries: a missing one stops the install, named" || no "missing library — got: $out"


# --- The offer to install what is missing (Portability) -----------------------
#
# pm_stub <manager> <name>... — puts a fake package manager on PATH that knows
# exactly those package names, logs any install it is asked to run to $S/pm.log,
# and, for the two names the round-trip test uses, puts the command that package
# provides into the stub directory so a re-check can see it appear.
# Called from a setup string, so it writes into the fresh $S/stubs of that run.
# It lives in a file of its own because the terminal tests below run the
# preflight in a separate shell, which needs the same helper.
cat > "$S/pm-stub.sh" <<'PMEOF'
pm_stub() {
  local manager="$1"; shift
  export PM_KNOWN=" $* " PM_LOG="$S/pm.log" PM_STUBS="$S/stubs"
  case "$manager" in
    dnf)
      cat > "$S/stubs/dnf" <<'EOS'
#!/bin/bash
[ "$1 $2" = "-q list" ] && { case "$PM_KNOWN" in *" $3 "*) exit 0 ;; *) exit 1 ;; esac; }
echo "dnf $*" >> "$PM_LOG"
for a in "$@"; do
  case "$a" in
    pulseaudio-utils) printf '#!/bin/bash\nexit 0\n' > "$PM_STUBS/pactl"; chmod 755 "$PM_STUBS/pactl" ;;
    make) printf '#!/bin/bash\nexit 0\n' > "$PM_STUBS/make"; chmod 755 "$PM_STUBS/make" ;;
  esac
done
EOS
      chmod 755 "$S/stubs/dnf" ;;
    apt)
      # apt-cache policy prints nothing and still exits 0 for a name it does
      # not know, which is why the check reads its output rather than its status.
      cat > "$S/stubs/apt-cache" <<'EOS'
#!/bin/bash
[ "$1" = policy ] || exit 0
case "$PM_KNOWN" in *" $2 "*) echo "$2:"; echo "  Candidate: 1.0" ;; esac
EOS
      cat > "$S/stubs/apt-get" <<'EOS'
#!/bin/bash
echo "apt-get $*" >> "$PM_LOG"
EOS
      chmod 755 "$S/stubs/apt-cache" "$S/stubs/apt-get" ;;
    pacman)
      cat > "$S/stubs/pacman" <<'EOS'
#!/bin/bash
[ "$1" = -Si ] && { case "$PM_KNOWN" in *" $2 "*) exit 0 ;; *) exit 1 ;; esac; }
echo "pacman $*" >> "$PM_LOG"
EOS
      chmod 755 "$S/stubs/pacman" ;;
  esac
}
PMEOF
# shellcheck source=/dev/null
source "$S/pm-stub.sh"

# expect_command '<label>' '<setup>' '<the exact command, or "" for none>'
expect_command() {
  local out got
  out="$(run "$2")"
  got="$(grep '^C: ' <<<"$out" | sed 's/^C: //')"
  if completed "$out" && [ "$got" = "$3" ]; then ok "$1"; else no "$1 — wanted '${3:-no command}', got '${got:-none}' in: $out"; fi
}

# The three managers, each building its own command from the same two gaps.
expect_command "dnf: one command for both gaps" \
  'rm "$S/stubs/pactl" "$S/stubs/make"; pm_stub dnf pulseaudio-utils make' \
  'sudo dnf install -y make pulseaudio-utils'
expect_command "apt: updates first, in the command shown" \
  'rm "$S/stubs/pactl" "$S/stubs/make"; pm_stub apt pulseaudio-utils make' \
  'sudo apt-get update && sudo apt-get install -y make pulseaudio-utils'
expect_command "pacman: -S --needed" \
  'rm "$S/stubs/pactl" "$S/stubs/make"; pm_stub pacman libpulse make' \
  'sudo pacman -S --needed make libpulse'
# Never a database refresh and never a system upgrade: both are the user's call.
out="$(run 'rm "$S/stubs/pactl" "$S/stubs/make"; pm_stub pacman libpulse make')"
if completed "$out" && ! grep -qE '^C: .*-Sy' <<<"$out"; then ok "pacman: no -Sy and no -Syu"; else no "pacman refreshed the database — got: $out"; fi

# The guard. A name this machine does not know is never printed.
expect_command "guard: a manager that knows nothing offers nothing" \
  'rm "$S/stubs/pactl"; pm_stub dnf' \
  ''
expect_command "guard: only the names it does know" \
  'rm "$S/stubs/pactl" "$S/stubs/make"; pm_stub dnf make' \
  'sudo dnf install -y make'
# The Fedora cell that would have been wrong: nodejs does not exist there, and
# the candidate list falls through to the versioned package that does.
expect_command "candidates: falls past a name this release dropped" \
  'rm "$S/stubs/node"; pm_stub dnf nodejs22-bin' \
  'sudo dnf install -y nodejs22-bin'
expect_command "candidates: prefers the newest it finds" \
  'rm "$S/stubs/node"; pm_stub dnf nodejs24-bin nodejs22-bin' \
  'sudo dnf install -y nodejs24-bin'

# What is deliberately not offered.
expect_command "no package manager this script knows: no command" \
  'rm "$S/stubs/pactl" "$S/stubs/make"' \
  ''
expect_command "a node that is present but too old is advice, not a package" \
  'export STUB_NODE_VERSION=20.19.0; pm_stub dnf nodejs24-bin nodejs22-bin npm' \
  ''
expect_command "a node at the wrong path is advice, not a package" \
  'SERVICE_NODE=/usr/bin/node-elsewhere; pm_stub dnf nodejs24-bin' \
  ''
expect_command "/dev/uinput missing: nothing a package fixes" \
  'UINPUT_NODE="$S/no-such-node"; pm_stub dnf pulseaudio-utils make' \
  ''
expect_command "a node that is absent is offered" \
  'rm "$S/stubs/node" "$S/stubs/npm"; pm_stub apt nodejs npm' \
  'sudo apt-get update && sudo apt-get install -y nodejs npm'

# --- What actually runs, and when ---------------------------------------------

# No terminal to ask at: the command is shown, and nothing is run.
out="$(entry 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' preflight)"
if grep -q 'rc=1$' <<<"$out" && grep -q 'no terminal here to ask at' <<<"$out" \
   && grep -q 'sudo dnf install -y pulseaudio-utils' <<<"$out" && [ ! -s "$S/pm.log" ]; then
  ok "no tty: the command is named, nothing is run, the install still refuses"
else
  no "no tty — got: $out; log: $(cat "$S/pm.log" 2>/dev/null)"
fi

# check names the command and never runs it.
out="$(entry 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' cmd_check)"
if grep -q 'rc=1$' <<<"$out" && grep -q 'sudo dnf install -y pulseaudio-utils' <<<"$out" \
   && grep -q 'offers to run it for you' <<<"$out" && [ ! -s "$S/pm.log" ]; then
  ok "check: names the command, runs nothing, exit 1"
else
  no "check with an installable gap — got: $out; log: $(cat "$S/pm.log" 2>/dev/null)"
fi

# Whether the command covers the whole list is said only when it does not.
# This line once fired every time: the caller read the command through $(...),
# so the package list it compared against had been built in a subshell and was
# empty by the time it looked.
out="$(entry 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' preflight)"
if ! grep -q 'does not cover the whole list' <<<"$out"; then
  ok "the command covers everything: no caveat"
else
  no "claimed to be partial while covering everything — got: $out"
fi
out="$(entry 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; UINPUT_NODE="$S/no-such-node"; pm_stub dnf pulseaudio-utils' preflight)"
if grep -q 'does not cover the whole list' <<<"$out"; then
  ok "the command covers part of it: says so"
else
  no "partial coverage went unsaid — got: $out"
fi

# check's header names the manager and what every cell resolves to here —
# with nothing missing. That is the case it exists for: without it, the Nobara
# rehearsal on a machine that already has everything would show no names at all.
out="$(entry 'pm_stub dnf pulseaudio-utils gcc make kernel-headers nodejs22-bin nodejs24-npm-bin' cmd_check)"
if grep -q 'rc=0$' <<<"$out" \
   && grep -qx '  packages  dnf: node=nodejs22-bin npm=nodejs24-npm-bin make=make cc=gcc uinput-header=kernel-headers pactl=pulseaudio-utils' <<<"$out"; then
  ok "check header: every name, though nothing is missing"
else
  no "check header with nothing missing — got: $out"
fi
out="$(entry 'pm_stub dnf gcc make kernel-headers nodejs24-bin nodejs24-npm-bin' cmd_check)"
grep -q '  packages  dnf: .* pactl=?$' <<<"$out" \
  && ok "check header: a name this machine does not know shows as ?" || no "unknown name in header — got: $out"
out="$(entry 'pm_stub apt nodejs npm make gcc linux-libc-dev pulseaudio-utils apparmor' cmd_check)"
grep -q '  packages  apt: .* apparmor-parser=apparmor$' <<<"$out" \
  && ok "check header: apt lists its apparmor cell" || no "apt header — got: $out"
out="$(entry '' cmd_check)"
grep -q '  packages  none this script knows' <<<"$out" \
  && ok "check header: no known manager, said so" || no "no-manager header — got: $out"

# --- The prompt, over a real terminal -----------------------------------------
#
# The claim being tested is the one that makes answering "yes" safe: the command
# printed is the command run. That needs a tty, because the offer deliberately
# does not appear without one, so these drive the script through a pty.
cat > "$S/pty-driver.py" <<'EOS'
import os, pty, select, sys
answer, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
os.write(fd, (answer + "\n").encode())
chunks = []
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    chunks.append(data)
_, status = os.waitpid(pid, 0)
sys.stdout.write(b"".join(chunks).decode(errors="replace").replace("\r", ""))
sys.stdout.write("\nrc=%d\n" % os.waitstatus_to_exitcode(status))
EOS

pty_run() {   # pty_run '<setup>' '<answer>' '<function>' — over a real pty
  rm -rf "$S/stubs" "$S/sys"; cp -a "$S/stubs.orig" "$S/stubs"
  mkdir -p "$S/sys/kernel" "$S/sys/user" "$S/seats/seat0"; touch "$S/uinput.h"
  cp "$REPO/udev/60-deckhand.rules" "$S/installed.rules"
  rm -f "$S/pm.log"
  cat > "$S/pty-run.sh" <<EOS
S="$S"
source "$S/pm-stub.sh"
source "$S/fns.sh"
export PATH="$S/stubs:$S/base" HOME="$S/home"
REPO_DIR="$REPO"; UDEV_RULE_SRC="$REPO/udev/60-deckhand.rules"
SERVICE_NODE="$S/stubs/node"; UINPUT_NODE=/dev/null; UINPUT_HEADER="$S/uinput.h"
LOGIND_SEATS_DIR="$S/seats"; SYSCTL_DIR="$S/sys"; UDEV_RULE_DST="$S/installed.rules"
APPARMOR_PROFILE_SRC="$REPO/apparmor/deckhand-editor"; APPARMOR_PROFILE_DST="$S/installed.apparmor"
$1
$3
EOS
  python3 "$S/pty-driver.py" "$2" bash "$S/pty-run.sh" 2>&1
}

if ! has_python3=$(command -v python3); then
  echo "SKIP  the prompt over a terminal — no python3 to open a pty"
else
  out="$(pty_run 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' y preflight)"
  shown="$(grep -o 'sudo dnf install -y.*' <<<"$out" | head -1)"
  ran="$(sed -n 's/^dnf /sudo dnf /p' "$S/pm.log" 2>/dev/null | head -1)"
  if [ -n "$shown" ] && [ "$shown" = "$ran" ]; then
    ok "yes: the command that was shown is the command that ran"
  else
    no "shown vs ran — shown '$shown', ran '$ran', out: $out"
  fi
  if grep -q 'rc=0$' <<<"$out" && grep -q 'Checking this machine again' <<<"$out" \
     && grep -q 'Every requirement is met' <<<"$out"; then
    ok "yes: the re-check finds the gap closed and the install goes ahead"
  else
    no "round trip — got: $out"
  fi

  out="$(pty_run 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' n preflight)"
  if grep -q 'rc=1$' <<<"$out" && grep -q 'nothing was changed' <<<"$out" && [ ! -s "$S/pm.log" ]; then
    ok "no: nothing is run and the install refuses"
  else
    no "answering no — got: $out; log: $(cat "$S/pm.log" 2>/dev/null)"
  fi

  # Enter alone is no: the prompt is [y/N] and it has to mean it.
  out="$(pty_run 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' '' preflight)"
  if grep -q 'rc=1$' <<<"$out" && [ ! -s "$S/pm.log" ]; then
    ok "just Enter: nothing is run"
  else
    no "answering with Enter — got: $out; log: $(cat "$S/pm.log" 2>/dev/null)"
  fi

  # check changes nothing, and the only way to prove it is over a terminal:
  # without one the offer declines to ask, so a "check" that had started
  # offering would look identical to one that had not. Answer y and require
  # that nothing was asked and nothing was run.
  out="$(pty_run 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf pulseaudio-utils' y cmd_check)"
  if ! grep -q 'Run this now' <<<"$out" && [ ! -s "$S/pm.log" ] && grep -q 'sudo dnf install -y pulseaudio-utils' <<<"$out"; then
    ok "check at a terminal: names the command, never asks, never runs"
  else
    no "check offered to install — got: $out; log: $(cat "$S/pm.log" 2>/dev/null)"
  fi

  # One offer only: a package that did not close the gap is not asked about again.
  out="$(pty_run 'rm -f "$S/pm.log"; rm "$S/stubs/pactl"; pm_stub dnf make' y preflight)"
  if grep -q 'rc=1$' <<<"$out" && [ "$(grep -c 'Run this now' <<<"$out")" -le 1 ]; then
    ok "one offer and one re-check, never a loop"
  else
    no "offered more than once — got: $out"
  fi
fi

exit $fail
