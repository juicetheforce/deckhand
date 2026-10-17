#!/bin/bash
# udev/deckhand-touch-access, the root helper the editor runs through pkexec
# when a touchscreen is paired: run here unprivileged in its test mode, against
# a scratch /sys and /dev, stand-ins for udevadm, setfacl and getfacl (ACLs kept
# as files), and its rule file checked with the real `udevadm verify`.
#
# Usage: bash scripts/test/touch-access.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$REPO/udev/deckhand-touch-access"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }

mkdir -p "$T/sys/class/input" "$T/dev/input" "$T/bin" "$T/acl" "$T/props" "$T/rules"
# event15: the panel's touchscreen; event7: the laptop's own; event3: a keyboard.
for n in 15 7 3; do mkdir -p "$T/sys/class/input/event$n"; touch "$T/dev/input/event$n"; done
echo 'ID_INPUT_TOUCHSCREEN=1' > "$T/props/event15"
echo 'ID_INPUT_TOUCHSCREEN=1' > "$T/props/event7"
echo 'ID_INPUT_KEYBOARD=1' > "$T/props/event3"
cat > "$T/bin/udevadm" <<EOF
#!/bin/bash
echo "udevadm \$*" >> "$T/udevadm.log"
if [ "\$1" = info ]; then cat "$T/props/\$(basename "\${@: -1}")"; fi
EOF
cat > "$T/bin/setfacl" <<EOF
#!/bin/bash
f="$T/acl/\$(basename "\$3")"
case "\$1" in
  -m) echo "\${2#u:}" | sed 's/^\([0-9]*\):r\$/user:\1:r--/' >> "\$f" ;;
  -x) [ -f "\$f" ] && sed -i "/^user:\${2#u:}:/d" "\$f" ;;
esac
EOF
cat > "$T/bin/getfacl" <<EOF
#!/bin/bash
cat "$T/acl/\$(basename "\${@: -1}")" 2>/dev/null
EOF
chmod +x "$T/bin/"*
run() { DECKHAND_TOUCH_ACCESS_TEST="$T" PKEXEC_UID=1000 "$@"; }
acl() { cat "$T/acl/$1" 2>/dev/null; }

# Not through pkexec: refused.
out="$(DECKHAND_TOUCH_ACCESS_TEST="$T" bash "$HELPER" set 2>&1)"; rc=$?
[ $rc != 0 ] && grep -q 'run through pkexec' <<<"$out" && ok "without pkexec's user: refused" || no "no user — $rc $out"

# Pairing: every touchscreen not already the user's gets read access, nothing else.
echo 'user:1000:rw-' > "$T/acl/event7"   # already readable (say another rule): left alone
coproc PAIR { run bash "$HELPER" pair 2>&1; }
read -r -t 5 first <&"${PAIR[0]}"
[ "$first" = granted ] && [ "$(acl event15)" = 'user:1000:r--' ] && [ -z "$(acl event3)" ] \
  && ok "pair: temporary read access to the touchscreens, not to the keyboard; says granted" || no "pair grant — $first / $(acl event15) / $(acl event3)"
echo 'set 222a:0001' >&"${PAIR[1]}"
read -r -t 5 second <&"${PAIR[0]}"; wait "$PAIR_PID" 2>/dev/null
rules="$T/rules/61-deckhand-touchscreens.rules"
[ "$second" = done ] && grep -q 'ATTRS{id/vendor}=="222a", ATTRS{id/product}=="0001", TAG+="uaccess"' "$rules" && [ "$(grep -c uaccess "$rules")" = 1 ] \
  && ok "set: one rule, for the paired touchscreen's IDs" || no "set — $second / $(cat "$rules" 2>&1)"
[ -z "$(acl event15)" ] && [ -z "$(acl event7)" ] && grep -q 'trigger --action=change --subsystem-match=input --property-match=ID_INPUT_TOUCHSCREEN=1' "$T/udevadm.log" && grep -q 'control --reload' "$T/udevadm.log" \
  && ok "the temporary access dropped, every touchscreen's taken away and re-applied from the rules" || no "drop — 15:$(acl event15) 7:$(acl event7) $(cat "$T/udevadm.log")"
if command -v udevadm >/dev/null && udevadm verify --help >/dev/null 2>&1; then
  udevadm verify --no-style "$rules" >/dev/null 2>&1 && ok "udevadm verify accepts the rule file" || no "udevadm verify: $(udevadm verify "$rules" 2>&1 | tail -2)"
fi

# Cancelled, by end of input: the temporary access goes, no rule is written.
rm -f "$rules"; rm -f "$T/acl/"*
out="$(echo cancel | run bash "$HELPER" pair 2>&1)"
[ "$out" = "$(printf 'granted\ncancelled')" ] && [ -z "$(acl event15)" ] && [ ! -e "$rules" ] \
  && ok "pair cancelled: access dropped, no rule" || no "cancel — $out / $(acl event15)"
out="$(run bash "$HELPER" pair < /dev/null 2>&1)"
grep -q cancelled <<<"$out" && [ -z "$(acl event15)" ] && ok "pair with its input closed (the editor gone): dropped" || no "eof — $out"
# Killed: the trap drops it.
coproc PAIR2 { exec env DECKHAND_TOUCH_ACCESS_TEST="$T" PKEXEC_UID=1000 bash "$HELPER" pair 2>&1; }
read -r -t 5 first <&"${PAIR2[0]}"
kill -TERM "$PAIR2_PID"; wait "$PAIR2_PID" 2>/dev/null
[ -z "$(acl event15)" ] && ok "pair killed: dropped" || no "killed — $(acl event15)"
# Its own deadline.
out="$( (sleep 5; echo late) | DECKHAND_TOUCH_ACCESS_DEADLINE=1 run bash "$HELPER" pair 2>&1)"
grep -q cancelled <<<"$out" && [ -z "$(acl event15)" ] && ok "pair past its deadline: dropped" || no "deadline — $out"

# A serial: two lines, each with the IDs and the serial.
run bash "$HELPER" set 27c0:0859:9LQ0172005164 222a:0001 >/dev/null
[ "$(grep -c 'uaccess' "$rules")" = 3 ] && grep -q 'ATTRS{uniq}=="9LQ0172005164"' "$rules" && grep -q 'ENV{ID_SERIAL_SHORT}=="9LQ0172005164"' "$rules" \
  && ! grep -E 'uaccess' "$rules" | grep '27c0' | grep -qv '9LQ0172005164' \
  && ok "an entry with a serial is matched only with it; two entries side by side" || no "serial — $(cat "$rules")"

# Removing the last: no rule file left.
run bash "$HELPER" set >/dev/null
[ ! -e "$rules" ] && ok "set with no entries removes the rule file" || no "empty set"

# Refused: anything udev could read as a pattern or a quote, or not hex.
for bad in '222a:0001:*' '222a:0001:a"b' '222A:0001' '222a:01' '222a:0001:has space' "$(printf '222a:0001\nX')"; do
  out="$(run bash "$HELPER" set "$bad" 2>&1)"; rc=$?
  [ $rc != 0 ] && [ ! -e "$rules" ] && grep -q 'not a touchscreen entry' <<<"$out" || { no "accepted a bad entry: $bad"; continue; }
done
ok "bad entries refused, nothing written: a glob, a quote, upper case, short IDs, a space, a newline"

# Never as root in test mode: the test variables are ignored by root (read, not run).
grep -q '"$(id -u)" != 0 ] && \[ -n "${DECKHAND_TOUCH_ACCESS_TEST' "$HELPER" && ok "the test paths apply only when not root" || no "test paths not limited to non-root"

exit $fail
