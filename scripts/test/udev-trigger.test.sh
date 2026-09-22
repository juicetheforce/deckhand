#!/bin/bash
# retrigger_udev from scripts/install.sh, with sudo and udevadm stubbed. The
# stub udevadm behaves as the real one did on Nobara: handed a sysfs path that
# does not exist, it fails with "no such device". uinput's sysfs node exists
# only once its module is loaded, so its absence must be normal — no
# warning, no trigger of a path that is not there — while a real failure is
# still reported.
#
# Usage: bash scripts/test/udev-trigger.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

mkdir -p "$S/bin" "$S/sys/uinput" "$S/sys/hidraw/hidraw9"
printf '#!/bin/bash\nexec "$@"\n' > "$S/bin/sudo"
cat > "$S/bin/udevadm" <<'STUB'
#!/bin/bash
echo "udevadm $*" >> "$UDEVADM_LOG"
[ -n "${UDEVADM_BROKEN:-}" ] && { echo "Failed to trigger: something real" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    /*) [ -e "$arg" ] || { echo "Failed to open the device '$arg': no such device" >&2; exit 1; } ;;
  esac
done
STUB
chmod 755 "$S/bin/sudo" "$S/bin/udevadm"

# run '<setup>' — prints retrigger_udev's output (both streams) and rc=N
run() {
  : > "$S/udevadm.log"
  (
    source "$S/fns.sh"
    set +e
    export PATH="$S/bin:$PATH" UDEVADM_LOG="$S/udevadm.log"
    elgato_hidraw_nodes() { :; }   # no decks unless a setup says so
    eval "$1"
    retrigger_udev
  ) 2>&1
  echo "rc=$?"
}

out="$(run 'UINPUT_SYSFS="$S/sys/not-loaded"')"
grep -q 'rc=0$' <<<"$out" && ! grep -q 'warning' <<<"$out" && grep -q 'not loaded yet' <<<"$out" && [ ! -s "$S/udevadm.log" ] \
  && ok "uinput not loaded, no decks: no trigger, no warning, says the module loads on first use" || no "not loaded, no decks — got: $out; log: $(cat "$S/udevadm.log")"

# A deck present: the function hands udevadm /sys/class/hidraw/<node>; the
# stub only records what it was handed (and would fail if the path were absent
# on this machine, which is not what this case is about).
out="$(run 'UINPUT_SYSFS="$S/sys/not-loaded"; elgato_hidraw_nodes() { echo /dev/hidraw9; }')"
if ! grep -q 'uinput' "$S/udevadm.log" && grep -q '/sys/class/hidraw/hidraw9' "$S/udevadm.log" && grep -q 'not loaded yet' <<<"$out"; then
  ok "uinput not loaded, a deck present: only the deck is re-triggered"
else
  no "not loaded, deck — got: $out; log: $(cat "$S/udevadm.log")"
fi

out="$(run 'UINPUT_SYSFS="$S/sys/uinput"')"
grep -q 'rc=0$' <<<"$out" && grep -q "$S/sys/uinput" "$S/udevadm.log" && ! grep -q 'warning' <<<"$out" && ! grep -q 'not loaded yet' <<<"$out" \
  && ok "uinput loaded: re-triggered with it, no warning" || no "loaded — got: $out; log: $(cat "$S/udevadm.log")"

out="$(run 'UINPUT_SYSFS="$S/sys/uinput"; export UDEVADM_BROKEN=1')"
grep -q 'warning:.*udevadm trigger failed' <<<"$out" && grep -q 'something real' <<<"$out" \
  && ok "a real trigger failure is still reported" || no "real failure hidden — got: $out"

exit $fail
