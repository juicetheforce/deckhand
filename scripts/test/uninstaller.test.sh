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

# end_twitch_link: before the service stops, a linked Twitch account's link is
# ended at Twitch through the installed CLI — best effort, never failing the
# uninstall. A stub stands in for the bundled node: it logs how it was run and
# answers with $TWITCH_REPLY.
STATE_DIR="$HOME/.local/state/deckhand"; mkdir -p "$STATE_DIR" "$APP_DIR/runtime" "$APP_DIR/dist"
: > "$APP_DIR/dist/cli.js"
CALLS="$S/node-calls"
cat > "$APP_DIR/runtime/node" <<STUB
#!/bin/bash
echo "\$*" >> '$CALLS'
printf '%s' "\$TWITCH_REPLY"
STUB
chmod +x "$APP_DIR/runtime/node"
rm -f "$STATE_DIR/credentials.json" "$CALLS"
out="$(end_twitch_link 2>&1)"; status=$?
[ "$status" = 0 ] && [ -z "$out" ] && [ ! -e "$CALLS" ] && ok "end_twitch_link: nothing linked — asks nothing, says nothing" || no "nothing linked ($status): $out"
printf '{\n  "vts": { "token": "t" }\n}\n' > "$STATE_DIR/credentials.json"
out="$(end_twitch_link 2>&1)"; [ -z "$out" ] && [ ! -e "$CALLS" ] && ok "end_twitch_link: other secrets but no Twitch — asks nothing" || no "no Twitch: $out"
printf '{\n  "twitch": { "refreshToken": "r" }\n}\n' > "$STATE_DIR/credentials.json"
out="$(TWITCH_REPLY='{ "link": "not-set-up", "revoked": true }' end_twitch_link 2>&1)"; status=$?
[ "$status" = 0 ] && grep -q 'Ended the Twitch link at Twitch' <<<"$out" && grep -qx "$APP_DIR/dist/cli.js twitch remove --json" "$CALLS" \
  && ok "end_twitch_link: linked — runs deckhand twitch remove, and says Twitch ended it" || no "linked ($status): $out / $(cat "$CALLS" 2>/dev/null)"
out="$(TWITCH_REPLY='{ "link": "not-set-up", "revoked": false }' end_twitch_link 2>&1)"; status=$?
[ "$status" = 0 ] && grep -q 'did not confirm' <<<"$out" && grep -q 'twitch.tv/settings/connections' <<<"$out" \
  && ok "end_twitch_link: Twitch did not confirm — says so and where to end it, and the uninstall goes on" || no "unconfirmed ($status): $out"
rm -f "$APP_DIR/runtime/node"
out="$(end_twitch_link 2>&1)"; status=$?
[ "$status" = 0 ] && grep -q 'did not confirm' <<<"$out" && ok "end_twitch_link: no CLI to run — says so, and the uninstall goes on" || no "no CLI ($status): $out"
grep -n 'end_twitch_link$' "$REPO/scripts/install.sh" | head -1 | cut -d: -f1 > "$S/call-line"
grep -n 'Stopping and disabling the service' "$REPO/scripts/install.sh" | cut -d: -f1 > "$S/stop-line"
[ "$(cat "$S/call-line")" -lt "$(cat "$S/stop-line")" ] && ok "cmd_uninstall ends the Twitch link before it stops the service, which holds the tokens" || no "end_twitch_link is not called before the service stops"
exit $fail
