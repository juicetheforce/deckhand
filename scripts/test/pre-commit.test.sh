#!/bin/bash
# scripts/hooks/pre-commit runs the one-deck check whenever editor/ or src/ is
# staged, however many other files are staged with them. Its test for that was a
# pipeline, `git diff --cached --name-only | grep -q`, under `set -o pipefail`:
# grep -q stops at the first match, git is still writing the rest of the names,
# dies of SIGPIPE, the pipeline fails, and the `!` read that as "nothing under
# editor/ or src/" — so a large commit skipped the check.
#
# Runs the hook in a scratch repository with a stand-in npm that records being
# called; never runs the real check.
#
# Usage: bash scripts/test/pre-commit.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

mkdir -p "$S/bin"
cat > "$S/bin/npm" <<'NPM'
#!/bin/bash
echo called >> "$NPM_CALLS"
exit 0
NPM
chmod +x "$S/bin/npm"
export NPM_CALLS="$S/npm-calls"

# One scratch repository per case: $1 its name; the rest, files to stage.
run_hook() {
  local dir="$S/$1"; shift
  git init -q "$dir"
  ( cd "$dir" && for f in "$@"; do mkdir -p "$(dirname "$f")"; : > "$f"; done && git add -A )
  rm -f "$NPM_CALLS"
  ( cd "$dir" && PATH="$S/bin:$PATH" bash "$REPO/scripts/hooks/pre-commit" ) >/dev/null 2>&1
  local status=$?
  [ -f "$NPM_CALLS" ] && echo "ran $status" || echo "skipped $status"
}

[ "$(run_hook docs-only README.md docs.md)" = "skipped 0" ] && ok "nothing under editor/ or src/: the check is not run" || no "nothing under editor/ or src/: $(run_hook docs-only2 README.md)"
[ "$(run_hook small editor/a.ts README.md)" = "ran 0" ] && ok "editor/ staged: the check runs" || no "editor/ staged: $(run_hook small2 editor/a.ts)"
[ "$(run_hook src-only src/a.ts)" = "ran 0" ] && ok "src/ staged: the check runs" || no "src/ staged"

# Many names after the match: more than a pipe holds (64 KiB), so the writer is
# still writing when the reader has gone.
many=(editor/a.ts)
for i in $(seq 1 3000); do many+=("zz/a-long-directory-name-to-fill-the-pipe-quickly/file-number-$i.txt"); done
result="$(run_hook large "${many[@]}")"
[ "$result" = "ran 0" ] && ok "editor/ staged with 3000 other files: the check still runs" || no "editor/ staged with 3000 other files: $result (the check was skipped)"

[ "$fail" = 0 ] && echo "pre-commit: all checks passed" || echo "pre-commit: FAILURES above"
exit $fail
