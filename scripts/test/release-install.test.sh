#!/bin/bash
# A release's download, check and unpack: download_and_stage and
# check_release_stage from scripts/install.sh, against a small fake package
# served from a file:// directory. Every way a download can be wrong must stop
# the install with nothing staged; only a package that matches SHA256SUMS,
# says the right version, and loads on this machine is staged.
#
# The fake package is not Deckhand: runtime/node is this machine's node, and
# sharp, node-hid and the Stream Deck library are one-line modules. What is
# real is the script's download, checksum, unpack and load checks.
#
# Usage: bash scripts/test/release-install.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }
VERSION=v9.9.9
ASSET="deckhand-$VERSION-linux-x64.tar.xz"

# make_package <dir> [<version inside>] [<a module that throws>] [<leave out the helper>]
make_package() {
  local out="$1" inside="${2:-$VERSION}" broken="${3:-}" nohelper="${4:-}" app="$S/build/deckhand"
  rm -rf "$S/build"; mkdir -p "$app/runtime" "$app/dist" "$app/helper" "$app/editor/electron" "$out"
  ln -s "$(command -v node)" "$app/runtime/node"
  echo "$inside" > "$app/VERSION"
  echo '// daemon' > "$app/dist/index.js"
  [ -n "$nohelper" ] || { printf '#!/bin/sh\n' > "$app/helper/deckhand-input"; chmod 755 "$app/helper/deckhand-input"; }
  cp "$(type -P true)" "$app/editor/electron/electron"   # a real ELF whose libraries are all here
  for mod in sharp node-hid @elgato-stream-deck/node; do
    mkdir -p "$app/node_modules/$mod"
    if [ "$mod" = "$broken" ]; then echo 'throw new Error("cannot load")' > "$app/node_modules/$mod/index.js"
    else echo 'module.exports = {}' > "$app/node_modules/$mod/index.js"; fi
  done
  tar -C "$S/build" -cJf "$out/$ASSET" deckhand
  (cd "$out" && sha256sum "$ASSET" > SHA256SUMS)
}

# stage '<setup>' — runs download_and_stage against $S/rel, prints its output and "rc=N"
stage() {
  (
    source "$S/fns.sh"
    RELEASE_VERSION="$VERSION"
    STAGE_DIR="$S/stage"
    export DECKHAND_RELEASE_BASE="file://$S/rel" TMPDIR="$S/tmp"
    mkdir -p "$TMPDIR"
    eval "$1"
    download_and_stage
  ) 2>&1
  echo "rc=$?"
}
nothing_staged() { [ ! -e "$S/stage" ] && [ -z "$(ls -A "$S/tmp" 2>/dev/null)" ]; }

make_package "$S/rel"
out="$(stage '')"
grep -q 'rc=0$' <<<"$out" && [ "$(cat "$S/stage/VERSION")" = "$VERSION" ] && [ -x "$S/stage/runtime/node" ] && [ -z "$(ls -A "$S/tmp")" ] \
  && ok "a good package is checked, unpacked and staged; the download is cleaned up" || no "good package — got: $out"
rm -rf "$S/stage"

# One byte changed in the middle of the package.
make_package "$S/rel"
python3 - "$S/rel/$ASSET" <<'PY'
import sys
p = sys.argv[1]; b = bytearray(open(p, 'rb').read()); b[len(b) // 2] ^= 0xFF; open(p, 'wb').write(bytes(b))
PY
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'does not match its checksum' <<<"$out" && nothing_staged \
  && ok "a corrupt package is refused, nothing staged" || no "corrupt — got: $out"

# Cut short, as an interrupted download would be.
make_package "$S/rel"
truncate -s 100 "$S/rel/$ASSET"
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'does not match its checksum' <<<"$out" && nothing_staged \
  && ok "a truncated package is refused, nothing staged" || no "truncated — got: $out"

# SHA256SUMS with no line for this package.
make_package "$S/rel"
echo "$(printf '0%.0s' {1..64})  deckhand-v0.0.1-linux-x64.tar.xz" > "$S/rel/SHA256SUMS"
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'SHA256SUMS has no line for' <<<"$out" && nothing_staged \
  && ok "no checksum line for the package: refused" || no "no line — got: $out"

# No SHA256SUMS at all.
make_package "$S/rel"
rm "$S/rel/SHA256SUMS"
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'could not download .*SHA256SUMS' <<<"$out" && nothing_staged \
  && ok "no SHA256SUMS: refused before the package is fetched" || no "no sums — got: $out"

# A package that matches its checksum but is another version.
make_package "$S/rel" v0.0.1
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'says it is v0.0.1, not v9.9.9' <<<"$out" && nothing_staged \
  && ok "a package of the wrong version is refused" || no "wrong version — got: $out"

# Its native modules do not load here.
make_package "$S/rel" "" node-hid
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'do not load on this machine' <<<"$out" && nothing_staged \
  && ok "modules that do not load: refused before anything installed is touched" || no "no load — got: $out"

# Incomplete: the helper missing.
make_package "$S/rel" "" "" nohelper
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'package is incomplete (helper/deckhand-input missing)' <<<"$out" && nothing_staged \
  && ok "an incomplete package is refused: no helper" || no "incomplete — got: $out"

# Incomplete: no Electron. Looked for by name, because ldd on a missing file
# reports nothing missing.
make_package "$S/rel"
( cd "$S/build" && rm deckhand/editor/electron/electron && tar -cJf "$S/rel/$ASSET" deckhand && cd "$S/rel" && sha256sum "$ASSET" > SHA256SUMS )
out="$(stage '')"
grep -q 'rc=1$' <<<"$out" && grep -q 'package is incomplete (editor/electron/electron missing)' <<<"$out" && nothing_staged \
  && ok "an incomplete package is refused: no Electron" || no "no electron — got: $out"

exit $fail
