#!/bin/bash
# Tests what ships, not what it was built from: a release built by
# `scripts/release.sh build <version>`, before it is published. A file left
# out of the package passes every test that runs from the source tree; these
# run against the package and against an install made from it.
#
#   1. The build matches its own SHA256SUMS.
#   2. It loads on the distributions it claims: in a container of each, with
#      only libusb and libudev added, the bundled Node loads the daemon's
#      native modules, sharp renders an image, and the helper finds its
#      libraries. (No display and no decks: this proves the binaries load, not
#      that the app works. Electron's desktop libraries are reported, not
#      required: a minimal image has no desktop.)
#   3. The shipped install.sh, piped into bash as `curl … | bash` pipes it,
#      with pactl hidden so the preflight has something to offer: at a
#      terminal the offer appears and "n" stops it; with no terminal it says so
#      and stops. Nothing is downloaded or installed by either.
#   4. **Installs it on this machine**, the way a user does: the shipped
#      install.sh piped into bash, fetching the package from release/<version>/
#      instead of GitHub. This replaces the installed Deckhand.
#   5. Runs the suites against that install: every daemon smoke test with the
#      installed dist/, node_modules/ and runtime/node, and every editor check
#      against the installed editor and its Electron.
#
# Usage: bash scripts/test/release-ships.sh <vX.Y.Z>   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V="${1:?usage: release-ships.sh <vX.Y.Z>}"
OUT="$REPO/release/$V"
ASSET="deckhand-$V-linux-x64.tar.xz"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }
section() { printf '\n== %s\n' "$1"; }

# --- 1. The build ------------------------------------------------------------------
section "the build"
[ -f "$OUT/$ASSET" ] && [ -f "$OUT/install.sh" ] && [ -f "$OUT/SHA256SUMS" ] || { echo "FAIL  no build of $V in $OUT"; exit 1; }
(cd "$OUT" && sha256sum -c --quiet SHA256SUMS) && ok "the build matches its SHA256SUMS" || no "SHA256SUMS mismatch"
grep -qx "RELEASE_VERSION=\"$V\"" "$OUT/install.sh" && ok "install.sh is stamped $V" || no "install.sh not stamped"
mkdir "$S/pkg" && tar -xJf "$OUT/$ASSET" -C "$S/pkg" --strip-components=1
[ -f "$S/pkg/runtime/node" ] && [ ! -L "$S/pkg/runtime/node" ] && ok "runtime/node is the bundled binary, not a link" || no "runtime/node is not a bundled binary"
[ "$(cat "$S/pkg/VERSION")" = "$V" ] && ok "VERSION is $V" || no "VERSION: $(cat "$S/pkg/VERSION")"

# --- 2. Loads on the targets --------------------------------------------------------
section "loads on the target distributions (containers)"
LOAD='cd /app
node_ok=no; ./runtime/node -e "
  require(\"./node_modules/node-hid\"); require(\"./node_modules/@elgato-stream-deck/node\");
  require(\"./node_modules/sharp\")({ create: { width: 2, height: 2, channels: 3, background: \"#f00\" } }).png().toBuffer()
    .then((b) => { if (b.length > 0) console.log(\"LOADED\"); })
    .catch((e) => { console.error(e.message); process.exit(1); });
" && node_ok=yes
helper_missing=$(ldd helper/deckhand-input | grep -c "not found")
electron_missing=$(ldd editor/electron/electron | grep -c "not found")
echo "RESULT glibc=$(ldd --version | head -n 1 | grep -o "[0-9.]*$") node=$node_ok helper_missing=$helper_missing electron_missing=$electron_missing"'
while read -r image prep; do
  [ -n "$image" ] || continue
  out="$(timeout 900 podman run --rm -v "$S/pkg:/app:ro,Z" "$image" bash -c "$prep >/dev/null 2>&1; $LOAD" 2>&1)"
  result="$(grep '^RESULT' <<<"$out")"
  if grep -q 'LOADED' <<<"$out" && grep -q 'node=yes helper_missing=0' <<<"$result"; then
    ok "$image: ${result#RESULT }"
  else
    no "$image: ${result:-no result} — $(grep -v '^RESULT' <<<"$out" | tail -3 | tr '\n' ' ')"
  fi
done <<'IMAGES'
quay.io/almalinux/almalinux:8 rpm --import https://repo.almalinux.org/almalinux/RPM-GPG-KEY-AlmaLinux && dnf -y install libusb systemd-libs
docker.io/library/debian:11 apt-get update && apt-get install -y libusb-1.0-0 libudev1
docker.io/library/debian:12 apt-get update && apt-get install -y libusb-1.0-0 libudev1
docker.io/library/ubuntu:22.04 apt-get update && apt-get install -y libusb-1.0-0 libudev1
docker.io/library/ubuntu:24.04 apt-get update && apt-get install -y libusb-1.0-0 libudev1
docker.io/library/ubuntu:26.04 apt-get update && apt-get install -y libusb-1.0-0 libudev1
registry.fedoraproject.org/fedora:44 dnf -y install libusb1 systemd-libs
docker.io/library/archlinux:latest pacman -Sy --noconfirm libusb systemd-libs
IMAGES

# --- 3. The shipped installer, piped ------------------------------------------------
section "the shipped install.sh, piped into bash"
mkdir "$S/bin"
IFS=: read -ra dirs <<<"$PATH"
for dir in "${dirs[@]}"; do
  for f in "$dir"/*; do
    name="${f##*/}"
    [ -x "$f" ] && [ "$name" != pactl ] && [ ! -e "$S/bin/$name" ] && ln -s "$f" "$S/bin/$name"
  done
done
piped="cd '$S' && cat '$OUT/install.sh' | DECKHAND_RELEASE_BASE='file://$OUT' PATH='$S/bin' bash"
out="$(timeout 300 python3 - "$piped" <<'DRIVER' 2>&1
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
)"
after="${out#*Run this now? \[y/N\]}"
! grep -qE 'unbound variable|bash: line [0-9]+:' <<<"$out" && ok "no shell errors under the pipe" || no "a shell error under the pipe: $(grep -E 'unbound variable|bash: line [0-9]+:' <<<"$out" | head -2)"
[ "$after" != "$out" ] && grep -q 'nothing was changed' <<<"$after" && ! grep -q 'Downloading' <<<"$out" \
  && ok "at a terminal: the offer appears under the pipe, \"n\" stops it, nothing downloaded" || no "at a terminal: $(tail -4 <<<"$out")"
out="$(timeout 300 setsid -w bash -c "$piped" </dev/null 2>&1)"; status=$?
[ "$status" != 124 ] && [ "$status" != 0 ] && grep -q 'no terminal here to ask' <<<"$out" && ! grep -q 'Downloading' <<<"$out" \
  && ok "with no terminal: says there is no one to ask, stops, nothing downloaded" || no "no terminal ($status): $(tail -4 <<<"$out")"

# --- 4. Install it, as a user would ---------------------------------------------------
section "install from the package (replaces the installed Deckhand)"
APP="$HOME/.local/share/deckhand"
args=""
[ "$(cat "$APP/VERSION" 2>/dev/null)" = "$V" ] && args="-s -- install --reinstall"
out="$(cd "$S" && cat "$OUT/install.sh" | DECKHAND_RELEASE_BASE="file://$OUT" bash $args 2>&1)"; status=$?
echo "$out" | grep -E '==>|warning|error' | sed 's/^/      /'
[ "$status" = 0 ] && ok "installed (exit 0)" || no "install exit $status"
[ "$(cat "$APP/VERSION" 2>/dev/null)" = "$V" ] && [ -f "$APP/runtime/node" ] && [ ! -L "$APP/runtime/node" ] \
  && ok "the installed app is $V with its own Node" || no "installed app is not $V with its own Node"
[ "$(systemctl --user is-active deckhand)" = active ] && ok "the service is running" || no "service not active"
ps -o args= -p "$(systemctl --user show deckhand -p MainPID --value)" | grep -q "^$APP/runtime/node $APP/dist/index.js" \
  && [ ! -L "$APP/runtime/node" ] \
  && ok "the service runs the bundled Node" || no "service command: $(ps -o args= -p "$(systemctl --user show deckhand -p MainPID --value)")"
[ -x "$HOME/.local/bin/deckhand-uninstall" ] && ok "deckhand-uninstall is in place" || no "no deckhand-uninstall"

# --- 5. The suites, against the install -------------------------------------------------
section "the daemon's smoke tests, against the installed dist/ and runtime/node"
T="$S/installed-tree"
mkdir -p "$T"
# Copies of the installed files, byte for byte, not links: the daemon finds its
# built-in icons from its own real location, and a test comparing that with the
# tree's path would fail on a link for no fault of the package. node_modules is
# linked; module resolution follows real paths anyway.
for part in dist assets helper package.json; do cp -a "$APP/$part" "$T/$part"; done
ln -s "$APP/node_modules" "$T/node_modules"
cp -r "$REPO/scripts" "$T/scripts"
export PATH="$APP/runtime:$PATH"   # the fakes' #!/usr/bin/env node finds the bundled one
for smoke in $(node -p "require('$REPO/package.json').scripts.smoke" | grep -o 'scripts/smoke[a-z-]*\.mjs'); do
  (cd "$T" && timeout 600 "$APP/runtime/node" "$smoke" > "$S/smoke.log" 2>&1) \
    && ok "$smoke" || no "$smoke — $(tail -3 "$S/smoke.log" | tr '\n' ' ')"
done

section "the editor checks, against the installed editor and its Electron"
for check in $(node -p "Object.keys(require('$REPO/editor/package.json').scripts).filter(k => k.startsWith('check:')).join(' ')"); do
  script="$(node -p "require('$REPO/editor/package.json').scripts['$check'].match(/scripts\/check-[a-z-]+\.mjs/)[0]")"
  (cd "$REPO/editor" && DECKHAND_CHECK_INSTALLED_EDITOR="$APP/editor" timeout 600 node "$script" > "$S/check.log" 2>&1) \
    && ok "$check" || no "$check — $(tail -3 "$S/check.log" | tr '\n' ' ')"
done

printf '\n'
[ "$fail" = 0 ] && echo "release-ships: $V — all checks passed" || echo "release-ships: $V — FAILURES above"
exit $fail
