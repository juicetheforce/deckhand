#!/bin/bash
# deckhand-uninstall: install_uninstaller and remove_uninstaller from
# scripts/install.sh, run against a scratch HOME, and the wrapper they write
# run for real against a stub install.sh standing in for the installed one.
#
# Usage: bash scripts/test/uninstaller.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"
export HOME="$S/home"; mkdir -p "$HOME"
export TMPDIR="$S/tmp"; mkdir -p "$TMPDIR"
source "$S/fns.sh"
set +e   # install.sh sets -e; this test runs commands that are meant to fail
APP_DIR="$HOME/.local/share/deckhand"
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

# A stand-in for the installed install.sh: reports how it was run, then does
# what a real uninstall does to its own surroundings — deletes the app
# directory (its own file included) and the wrapper — and exits 7.
mkdir -p "$APP_DIR"
cat > "$APP_DIR/install.sh" <<STUB
#!/bin/bash
echo "ran as: \$0"
echo "args: \$*"
rm -rf '$APP_DIR' '$UNINSTALLER'
exit 7
STUB

install_uninstaller >/dev/null
[ -x "$UNINSTALLER" ] && grep -qxF "$UNINSTALL_MARKER" "$UNINSTALLER" && ok "wrapper written, with its marker" || no "no wrapper"

out="$("$UNINSTALLER" --purge 2>&1)"; status=$?
ran_as="$(sed -n 's/^ran as: //p' <<<"$out")"
[ -n "$ran_as" ] && [ "$ran_as" != "$APP_DIR/install.sh" ] && [[ "$ran_as" == "$TMPDIR"/deckhand-uninstall.* ]] \
  && ok "ran a temporary copy, not the installed script ($ran_as)" || no "ran as: '$ran_as'"
grep -qx 'args: uninstall --purge' <<<"$out" && ok "passed \"uninstall\" and its arguments" || no "args: $out"
[ "$status" = 7 ] && ok "exit status passed through" || no "exit status $status"
[ -z "$(ls -A "$TMPDIR")" ] && ok "temporary copy removed" || no "left in TMPDIR: $(ls -A "$TMPDIR")"
[ ! -e "$APP_DIR" ] && [ ! -e "$UNINSTALLER" ] && ok "the run could delete the app and the wrapper under itself" || no "app or wrapper still there"

# The installed script gone: says so, removes its copy, fails.
mkdir -p "$APP_DIR"; install_uninstaller >/dev/null; rm -f "$APP_DIR/install.sh"
out="$("$UNINSTALLER" 2>&1)"; status=$?
[ "$status" = 1 ] && grep -q 'install.sh is missing' <<<"$out" && [ -z "$(ls -A "$TMPDIR")" ] \
  && ok "no installed script: says so, exits 1, leaves nothing" || no "missing script ($status): $out"

remove_uninstaller >/dev/null
[ ! -e "$UNINSTALLER" ] && ok "remove_uninstaller removes ours" || no "ours not removed"
printf '#!/bin/sh\necho someone else\n' > "$UNINSTALLER"
install_uninstaller >/dev/null 2>&1; grep -q 'someone else' "$UNINSTALLER" && ok "a foreign file is not overwritten" || no "foreign file overwritten"
remove_uninstaller >/dev/null 2>&1; [ -f "$UNINSTALLER" ] && ok "a foreign file is not removed" || no "foreign file removed"
exit $fail
