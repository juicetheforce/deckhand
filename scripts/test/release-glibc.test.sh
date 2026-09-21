#!/bin/bash
# scripts/release.sh's glibc check: check_glibc, run on scratch packages. It is
# the check that turns "does not run on a stranger's older machine" into a
# failed build here, so it must refuse anything over the floor and anything it
# cannot read, and must not pass a package it found nothing in.
#
# Uses the official Node from release.sh's cache (release/cache/node) as the
# binary at the floor, fetching it the way release.sh does if it is not there;
# the others are this machine's: the helper compiled with its cc, and an
# installed C++ library — both newer than the floor on any current distribution.
#
# Usage: bash scripts/test/release-glibc.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }
command -v objdump >/dev/null && command -v cc >/dev/null || { echo "SKIP  needs objdump and cc"; exit 0; }
# An installed library that needs a libstdc++ newer than the floor: the first
# of these that does (Fedora 44: ICU's needs GLIBCXX_3.4.30).
NEW_CXX=""
for f in /usr/lib64/libicuuc.so.* /usr/lib/x86_64-linux-gnu/libicuuc.so.* /usr/lib64/libQt6Core.so.6; do
  [ -f "$f" ] || continue
  v="$(objdump -T "$f" 2>/dev/null | awk '/\*UND\*/' | grep -o 'GLIBCXX_[0-9.]*' | sort -uV | tail -n 1)"
  if [ -n "$v" ] && [ "$(printf '%s\n3.4.25\n' "${v#GLIBCXX_}" | sort -V | tail -n 1)" != 3.4.25 ]; then NEW_CXX="$f"; break; fi
done

sed '/^# --- main ---/,$d' "$REPO/scripts/release.sh" > "$S/fns.sh"
# shellcheck source=/dev/null
source "$S/fns.sh"
set +e

# The official Node: exactly at the floor (glibc 2.28), so it must pass.
OUT_ROOT="$REPO/release" WORK="$S/node-work"
(fetch_node) >/dev/null 2>&1 || { echo "FAIL  could not fetch Node $NODE_VERSION"; exit 1; }
NODE_BIN="$S/node-work/node/bin/node"

# scan <label> — runs check_glibc on $S/<label>/deckhand, prints output and rc=N
scan() {
  ( WORK="$S/$1"; check_glibc ) 2>&1
  echo "rc=$?"
}
package() { rm -rf "$S/$1"; mkdir -p "$S/$1/deckhand/sub"; echo "$S/$1/deckhand"; }

p="$(package atfloor)"; cp "$NODE_BIN" "$p/sub/node"; echo 'not a binary' > "$p/README"
out="$(scan atfloor)"
grep -q 'rc=0$' <<<"$out" && grep -q '1 binaries, none newer' <<<"$out" \
  && ok "the official Node, at glibc 2.28 exactly, passes; text files are skipped" || no "at floor — got: $out"

p="$(package newglibc)"; cp "$NODE_BIN" "$p/node"
cc -O2 -o "$p/sub/deckhand-input" "$REPO/helper/deckhand-input.c" 2>/dev/null
need="$(objdump -T "$p/sub/deckhand-input" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -n 1)"
out="$(scan newglibc)"
grep -q 'rc=1$' <<<"$out" && grep -q "needs glibc ${need#GLIBC_}: sub/deckhand-input" <<<"$out" && ! grep -q 'needs .*: node$' <<<"$out" \
  && ok "the helper compiled here ($need) is refused, and named; the Node beside it is not" || no "new glibc — got: $out"

if [ -n "$NEW_CXX" ]; then
  p="$(package newcxx)"; cp "$NEW_CXX" "$p/lib.so"
  out="$(scan newcxx)"
  grep -q 'rc=1$' <<<"$out" && grep -q 'needs libstdc++ .*: lib.so' <<<"$out" \
    && ok "a library needing this machine's newer libstdc++ ($(basename "$NEW_CXX")) is refused" || no "new libstdc++ — got: $out"
else
  no "no installed library needing a libstdc++ newer than 3.4.25 was found to test with"
fi

p="$(package broken)"; cp "$NODE_BIN" "$p/node"; head -c 64 "$NODE_BIN" > "$p/sub/cut-short"
out="$(scan broken)"
grep -q 'rc=1$' <<<"$out" && grep -q 'cannot read: sub/cut-short' <<<"$out" \
  && ok "an ELF file objdump cannot read is refused" || no "unreadable — got: $out"

p="$(package empty)"; echo 'nothing native' > "$p/README"
out="$(scan empty)"
grep -q 'rc=1$' <<<"$out" && grep -q 'no binaries found' <<<"$out" \
  && ok "a package with no binaries at all is refused (the scan is looking in the wrong place)" || no "empty — got: $out"

exit $fail
