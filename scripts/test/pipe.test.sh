#!/bin/bash
# The `curl … | bash` stdin trap, tested by actually piping install.sh into
# bash. Under a pipe, stdin is the script, so a prompt that reads stdin either
# sees no terminal or eats the script. The preflight's package offer must still
# appear and take its answer from the terminal; with no terminal at all it
# must say so and stop, not hang.
#
# To have something to offer, pactl is hidden: PATH is a scratch directory of
# links to every command but pactl. The answer is always "n", so nothing is
# ever installed, and the preflight then stops before anything is changed.
#
# Runs the real preflight on this machine, so it needs what an install needs:
# a desktop session with a systemd user manager and a session bus.
#
# Usage: bash scripts/test/pipe.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }
command -v python3 >/dev/null && command -v setsid >/dev/null || { echo "SKIP  needs python3 and setsid"; exit 0; }

# Runs a shell command on a pseudo-terminal, as a person at a terminal would,
# and types "n" once — only after the offer's question has appeared. Prints
# everything the command wrote. (Python's pty module rather than script(1),
# which Fedora does not install by default.)
on_a_terminal() {
  python3 - "$1" <<'DRIVER'
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '-c', sys.argv[1]])
seen, answered = b'', False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if not answered and b'Run this now? [y/N]' in seen:
        os.write(fd, b'n\n')
        answered = True
os.waitpid(pid, 0)
sys.stdout.write(seen.decode('utf-8', 'replace'))
DRIVER
}

mkdir "$S/bin"
IFS=: read -ra dirs <<<"$PATH"
for dir in "${dirs[@]}"; do
  for f in "$dir"/*; do
    name="${f##*/}"
    [ -x "$f" ] && [ "$name" != pactl ] && [ ! -e "$S/bin/$name" ] && ln -s "$f" "$S/bin/$name"
  done
done
[ ! -e "$S/bin/pactl" ] && PATH="$S/bin" command -v bash >/dev/null && ok "scratch PATH: every command but pactl" || no "scratch PATH"

# The script is piped from a file, as curl would pipe it. cwd is scripts/, so
# a piped copy, which has no file of its own, still finds the checkout above.
piped="cd '$REPO/scripts' && cat '$REPO/scripts/install.sh' | PATH='$S/bin' bash -s -- install"

# 1. A terminal: the pipeline runs on a pseudo-terminal, and "n" is typed
#    into it.
out="$(timeout 180 bash -c "$(declare -f on_a_terminal); on_a_terminal \"\$1\"" _ "$piped" 2>&1)"
grep -q 'Run this now? \[y/N\]' <<<"$out" && ok "with a terminal: the offer appears under a pipe" || no "no offer: $(tail -5 <<<"$out")"
grep -q 'no terminal here to ask' <<<"$out" && no "with a terminal: it claimed there was no terminal" || ok "with a terminal: it did not claim there was none"
# After the question, not merely somewhere: "nothing was changed" is printed
# whether or not there was an offer, so only its place proves the answer was
# read and the script went on from there.
grep -q 'nothing was changed' <<<"${out#*Run this now? \[y/N\]}" && [ "${out#*Run this now? \[y/N\]}" != "$out" ] \
  && ok "the answer was read from the terminal, and the script went on from there" || no "nothing after the question: $(tail -5 <<<"$out")"

# 2. No terminal: setsid leaves the pipeline with no controlling terminal, as
#    a launcher or a cron job would.
out="$(timeout 180 setsid -w bash -c "$piped" </dev/null 2>&1)"; status=$?
[ "$status" != 124 ] && ok "with no terminal: it did not hang" || no "timed out"
grep -q 'no terminal here to ask' <<<"$out" && ok "with no terminal: it says there is no one to ask" || no "no-terminal message missing: $(tail -5 <<<"$out")"
[ "$status" != 0 ] && grep -q 'nothing was changed' <<<"$out" && ok "with no terminal: it stops, changing nothing" || no "status $status: $(tail -3 <<<"$out")"
exit $fail
