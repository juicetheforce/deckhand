#!/bin/bash
# scripts/install.sh upgrade, against a local origin in a scratch directory.
# Runs the real install.sh from this checkout as the *old* release; the newer
# release's install.sh is a stub that only reports it ran, so the hand-off is
# visible and nothing is built or installed.
#
# Origin's tags: v0.9.0 (the real install.sh), v0.10.0 (stub "new") — so a
# plain text sort would pick the wrong one — and v0.11.0-rc1 (stub "rc"),
# a pre-release that must be ignored. Release checkouts are made the way the
# README makes one: a shallow clone of one tag.
#
# Usage: bash scripts/test/upgrade.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
# No personal git config (signing, hooks, default branch) in the scratch repos.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

stub() {   # stub <word>: an install.sh that says it ran, with its arguments
  printf '#!/bin/bash\necho "stub %s ran: $*"\n' "$1"
}

origin="$S/origin"
mkdir -p "$origin/scripts"
git -C "$origin" init --quiet -b main
cp "$REPO/scripts/install.sh" "$origin/scripts/install.sh"
git -C "$origin" add -A && git -C "$origin" commit --quiet -m one
git -C "$origin" tag -a v0.9.0 -m v0.9.0
stub new > "$origin/scripts/install.sh"
git -C "$origin" commit --quiet -am two
git -C "$origin" tag -a v0.10.0 -m v0.10.0
stub rc > "$origin/scripts/install.sh"
git -C "$origin" commit --quiet -am three
git -C "$origin" tag -a v0.11.0-rc1 -m v0.11.0-rc1

release_clone() {   # release_clone <dir> <tag>
  git clone --quiet -c advice.detachedHead=false --depth 1 --branch "$2" "file://$origin" "$1"
}
tag_of() { git -C "$1" describe --tags --exact-match HEAD 2>/dev/null || echo "(not at a tag)"; }

# 1. The upgrade: lands on v0.10.0 and hands over to its install.sh.
release_clone "$S/a" v0.9.0
out="$(bash "$S/a/scripts/install.sh" upgrade 2>&1)"; status=$?
[ $status -eq 0 ] && ok "upgrade exits 0" || no "upgrade exit $status: $out"
[ "$(tag_of "$S/a")" = v0.10.0 ] && ok "checkout moved to v0.10.0 (version sort, pre-release ignored)" || no "checkout at $(tag_of "$S/a")"
grep -qx 'stub new ran: update' <<<"$out" && ok "handed over: the new install.sh ran \"update\"" || no "hand-off: $out"
grep -q 'stub rc' <<<"$out" && no "the pre-release's script ran" || ok "the pre-release's script did not run"
[ "$(tail -n 1 <<<"$out")" = 'stub new ran: update' ] && ok "nothing ran after the hand-off" || no "output after the hand-off: $out"

# 2. Already on the newest release: says so, exits 0, moves nothing.
#    Needs the real script at the newest release, so a second origin whose
#    newest release is v0.9.0 and whose only newer tag is a pre-release.
origin2="$S/origin2"
git clone --quiet "file://$origin" "$origin2"
git -C "$origin2" checkout --quiet -B main v0.9.0
git -C "$origin2" tag -d v0.10.0 >/dev/null
git -C "$origin2" tag -d v0.11.0-rc1 >/dev/null
stub rc > "$origin2/scripts/install.sh"
git -C "$origin2" commit --quiet -am rc
git -C "$origin2" tag -a v0.10.0-rc1 -m v0.10.0-rc1
git clone --quiet -c advice.detachedHead=false --depth 1 --branch v0.9.0 "file://$origin2" "$S/b"
out="$(bash "$S/b/scripts/install.sh" upgrade 2>&1)"; status=$?
[ $status -eq 0 ] && grep -q 'Already up to date: v0.9.0' <<<"$out" && ok "already up to date: says so, exit 0" || no "up to date ($status): $out"
[ "$(tag_of "$S/b")" = v0.9.0 ] && ok "up to date: checkout not moved" || no "up to date: moved to $(tag_of "$S/b")"
grep -q 'stub' <<<"$out" && no "up to date: a stub ran" || ok "up to date: no hand-off"

# 3. A checkout on a branch is refused and told to use update.
git clone --quiet "file://$origin" "$S/c"
git -C "$S/c" checkout --quiet -B main v0.9.0
out="$(bash "$S/c/scripts/install.sh" upgrade 2>&1)"; status=$?
[ $status -ne 0 ] && grep -q 'on the branch "main"' <<<"$out" && grep -q 'install.sh update' <<<"$out" && ok "on a branch: refused, pointed at update" || no "branch ($status): $out"
[ "$(git -C "$S/c" symbolic-ref --short HEAD 2>/dev/null)" = main ] && [ "$(tag_of "$S/c")" = v0.9.0 ] && ok "on a branch: still on main at v0.9.0" || no "branch: HEAD moved"

# 4. A dirty release checkout is refused; there is no --dirty.
release_clone "$S/d" v0.9.0
echo "# local change" >> "$S/d/scripts/install.sh"
out="$(bash "$S/d/scripts/install.sh" upgrade 2>&1)"; status=$?
[ $status -ne 0 ] && grep -q 'uncommitted changes' <<<"$out" && ok "dirty: refused" || no "dirty ($status): $out"
[ "$(tag_of "$S/d")" = v0.9.0 ] && ok "dirty: checkout not moved" || no "dirty: moved to $(tag_of "$S/d")"
# On a clean checkout, so that only the argument can be what refuses it.
release_clone "$S/d2" v0.9.0
out="$(bash "$S/d2/scripts/install.sh" upgrade --dirty 2>&1)"; status=$?
[ $status -eq 2 ] && [ "$(tag_of "$S/d2")" = v0.9.0 ] && ok "--dirty is not an upgrade option (usage, not moved)" || no "--dirty ($status): $out"

# 5. No release tag at all: a message, not a silent exit.
origin3="$S/origin3"
git clone --quiet "file://$origin2" "$origin3"
git -C "$origin3" checkout --quiet -B main v0.9.0
git -C "$origin3" tag -d v0.9.0 >/dev/null
git -C "$origin3" tag -a nightly -m nightly
git clone --quiet -c advice.detachedHead=false --depth 1 --branch nightly "file://$origin3" "$S/e"
out="$(bash "$S/e/scripts/install.sh" upgrade 2>&1)"; status=$?
[ $status -ne 0 ] && grep -q 'no release tags found' <<<"$out" && ok "no release tags: says so" || no "no tags ($status): $out"

exit $fail
