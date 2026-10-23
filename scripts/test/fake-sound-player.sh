#!/bin/sh
# A stand-in for pw-play and paplay, for offline tests (scripts/smoke-sounds.mjs):
# put it first on PATH under either name. It plays nothing. It appends its name
# and arguments to FAKE_SOUND_LOG, one line per start, then "plays" the file
# for as many milliseconds as the file's text says (5000 if it says none), and
# exits 0. A file whose text starts "bad" is refused as libsndfile refuses one,
# with exit 1 at once; a missing file too.
#
# Sent SIGTERM, it exits as the real ones do, measured 2026-10-22: pw-play
# with exit code 1, paplay with 0 — neither with the signal.
#
# Shell, not Node: Node's ~150 ms start would be counted in every sound's
# length, and the loop's 250 ms floor is measured against that length. Only
# builtins and absolute paths, because the test's PATH holds nothing but fakes.
name=${0##*/}
file=
for arg in "$@"; do file=$arg; done
[ -n "$FAKE_SOUND_LOG" ] && echo "$name $*" >> "$FAKE_SOUND_LOG"
if ! [ -r "$file" ] || ! [ -f "$file" ]; then
  echo "sndfile: failed to open audio file \"$file\": System error : No such file or directory." >&2
  echo "error: open failed: Input/output error" >&2
  exit 1
fi
text=
read -r text < "$file"
case $text in
  bad*)
    echo "sndfile: failed to open audio file \"$file\": File does not exist or is not a regular file (possibly a pipe?)." >&2
    echo "error: open failed: Input/output error" >&2
    exit 1
    ;;
esac
ms=${text:-5000}
seconds=$((ms / 1000)).$(printf '%03d' $((ms % 1000)))
/bin/sleep "$seconds" &
pid=$!
if [ "$name" = paplay ]; then code=0; else code=1; fi
trap 'kill "$pid" 2>/dev/null; exit $code' TERM
wait "$pid"
exit 0
