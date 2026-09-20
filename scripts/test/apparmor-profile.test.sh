#!/bin/bash
# The editor's AppArmor profile (Portability, docs/scope.md §7):
# install_apparmor_profile and remove_apparmor_profile from scripts/install.sh,
# against scratch paths and a recording `sudo` stub. Sources install.sh's
# functions (everything above its "main" section), so it tests the real code —
# and nothing here touches /etc or runs anything as root: `sudo` is a stub that
# writes down what it was asked to do and does it inside the scratch directory.
#
# Usage: bash scripts/test/apparmor-profile.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"
source "$S/fns.sh"

fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

# A sudo that records its arguments and then runs them for real, so the effect
# lands on the scratch files rather than on this machine. apparmor_parser is a
# stub for the same reason: loading a profile needs a kernel and root.
mkdir -p "$S/stubs" "$S/sys/kernel"
cat > "$S/stubs/sudo" <<EOF
#!/bin/bash
echo "sudo \$*" >> "$S/calls"
exec "\$@"
EOF
cat > "$S/stubs/apparmor_parser" <<EOF
#!/bin/bash
echo "apparmor_parser \$*" >> "$S/calls"
exit \${STUB_PARSER_RC:-0}
EOF
chmod 755 "$S/stubs/sudo" "$S/stubs/apparmor_parser"
export PATH="$S/stubs:$PATH"

APPARMOR_PROFILE_SRC="$REPO/apparmor/deckhand-editor"
APPARMOR_PROFILE_DST="$S/etc/deckhand-editor"
SYSCTL_DIR="$S/sys"
mkdir -p "$S/etc"
# The default location, which the profile's glob covers.
APP_DIR="/home/tester/.local/share/deckhand"

restricted() { echo "$1" > "$S/sys/kernel/apparmor_restrict_unprivileged_userns"; }
reset() { rm -f "$S/calls" "$APPARMOR_PROFILE_DST"; }

# --- The profile itself --------------------------------------------------------
grep -q 'userns,' "$APPARMOR_PROFILE_SRC" \
  && ok "the profile grants userns" || no "the profile does not grant userns"
grep -q 'flags=(unconfined)' "$APPARMOR_PROFILE_SRC" \
  && ok "it is an unconfined profile, restricting nothing new" || no "not unconfined"
# The attachment path must match where install.sh actually puts Electron.
attach="$(sed -n 's/^profile deckhand-editor \(.*\) flags.*/\1/p' "$APPARMOR_PROFILE_SRC")"
[ "$attach" = "/home/*/.local/share/deckhand/editor/electron/electron" ] \
  && ok "it attaches to the installed Electron's path" || no "attachment path: $attach"
# shellcheck disable=SC2053
[[ "$APP_DIR/editor/electron/electron" == $attach ]] \
  && ok "a default install's Electron matches that glob" || no "default install does not match the glob"

# --- Where it is not needed ----------------------------------------------------
reset; restricted 0
install_apparmor_profile >/dev/null 2>&1
[ ! -e "$APPARMOR_PROFILE_DST" ] && [ ! -e "$S/calls" ] \
  && ok "userns unrestricted (Fedora): nothing installed, no sudo" || no "installed a profile where none is needed"

reset; rm -f "$S/sys/kernel/apparmor_restrict_unprivileged_userns"
install_apparmor_profile >/dev/null 2>&1
[ ! -e "$APPARMOR_PROFILE_DST" ] && [ ! -e "$S/calls" ] \
  && ok "no such sysctl at all: nothing installed, no sudo" || no "installed a profile with no sysctl present"

# --- Where it is needed --------------------------------------------------------
reset; restricted 1
install_apparmor_profile >/dev/null 2>&1
cmp -s "$APPARMOR_PROFILE_SRC" "$APPARMOR_PROFILE_DST" \
  && ok "userns restricted: the profile is installed" || no "profile not installed when needed"
grep -q "^sudo install -m 644" "$S/calls" \
  && ok "installed with sudo, mode 644" || no "install call: $(cat "$S/calls" 2>/dev/null)"
grep -q "^apparmor_parser -r" "$S/calls" \
  && ok "loaded with apparmor_parser -r" || no "not loaded: $(cat "$S/calls" 2>/dev/null)"

# Second run: already current, so it must ask for nothing.
rm -f "$S/calls"
install_apparmor_profile >/dev/null 2>&1
[ ! -e "$S/calls" ] && ok "already current: no sudo, no reload" || no "re-installed an unchanged profile: $(cat "$S/calls")"

# --- An install somewhere the glob does not reach ------------------------------
reset; restricted 1
saved="$APP_DIR"; APP_DIR="/opt/deckhand"
out="$(install_apparmor_profile 2>&1)"
APP_DIR="$saved"
[ ! -e "$APPARMOR_PROFILE_DST" ] && grep -q "not installing the AppArmor profile" <<<"$out" \
  && ok "a non-default location: refuses and says so, rather than a profile that never attaches" \
  || no "non-default location: $out"

# --- When loading fails, the install must not be sunk --------------------------
reset; restricted 1
out="$(STUB_PARSER_RC=1 install_apparmor_profile 2>&1)"
rc=$?
[ "$rc" = 0 ] && grep -q "could not install or load" <<<"$out" \
  && ok "a failed load warns and carries on (the decks do not need it)" || no "failed load: rc=$rc $out"

# --- Removal -------------------------------------------------------------------
reset; restricted 1
install_apparmor_profile >/dev/null 2>&1
rm -f "$S/calls"
remove_apparmor_profile >/dev/null 2>&1
[ ! -e "$APPARMOR_PROFILE_DST" ] && ok "uninstall removes the profile" || no "profile left behind"
grep -q "^apparmor_parser -R" "$S/calls" \
  && ok "it is unloaded before the file goes" || no "not unloaded: $(cat "$S/calls" 2>/dev/null)"

rm -f "$S/calls"
remove_apparmor_profile >/dev/null 2>&1
[ ! -e "$S/calls" ] && ok "nothing to remove: no sudo" || no "asked for sudo with no profile present"

exit $fail
