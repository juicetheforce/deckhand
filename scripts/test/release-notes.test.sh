#!/bin/bash
# scripts/release.sh's release notes: whatever notes file is given, the notes
# always end with the line that installs or updates Deckhand — Settings ›
# About's "Update available" links to a release's page, so the page must say
# how. Sources release.sh's functions (everything above its main marker).
#
# Usage: bash scripts/test/release-notes.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

sed '/^# --- main ---/,$d' "$REPO/scripts/release.sh" > "$S/fns.sh"
# shellcheck source=/dev/null
source "$S/fns.sh"
LINE='releases/latest/download/install.sh | bash'

out="$(release_notes "")"
[ "$(grep -cF "$LINE" <<<"$out")" = 1 ] && [ "$(wc -l <<<"$out")" = 1 ] && ok "no notes file: the install-or-update line alone" || no "no notes file: $out"

printf '**What is new**\n\n- A thing.\n' > "$S/notes.md"
out="$(release_notes "$S/notes.md")"
[ "$(head -1 <<<"$out")" = '**What is new**' ] && [ "$(tail -1 <<<"$out" | grep -cF "$LINE")" = 1 ] && ok "a notes file: its text first, the line last" || no "a notes file: $out"

{ cat "$S/notes.md"; printf '\n%s\n' "$INSTALL_LINE"; } > "$S/already.md"
out="$(release_notes "$S/already.md")"
[ "$(grep -cF "$LINE" <<<"$out")" = 1 ] && ok "a notes file that already has the line: never twice" || no "already has the line: $(grep -cF "$LINE" <<<"$out") times"

( release_notes "$S/nothing-here.md" ) >/dev/null 2>&1 && no "a notes file that is not there was accepted" || ok "a notes file that is not there is refused"

grep -q 'release_notes "$notes_file" > "$notes"' "$REPO/scripts/release.sh" && grep -q -- '--notes-file "$notes"' "$REPO/scripts/release.sh" && ok "publish sends exactly these notes" || no "publish does not send release_notes' output"

[ "$fail" = 0 ] && echo "release-notes: all checks passed" || echo "release-notes: FAILURES above"
exit $fail
