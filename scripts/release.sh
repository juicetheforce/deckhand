#!/bin/bash
#
# Builds a Deckhand release: the prebuilt package end users install with one
# line, its SHA256SUMS, and the install.sh that downloads and checks them.
#
#   scripts/release.sh build <vX.Y.Z>     builds into release/<vX.Y.Z>/
#   scripts/release.sh publish <vX.Y.Z>   uploads that build as the GitHub release
#
# Written to run the same way on a maintainer's machine or in CI: everything
# it needs is fetched and checked here, and nothing is read from the machine's
# own Node or compiler for what ships.
#
# What it guarantees, each checked rather than assumed:
#
# - **Only committed code.** The checkout must be clean and exactly at the
#   annotated tag, and the build starts from `git archive` of that tag, so a
#   file that is not in the commit cannot reach the package.
# - **One Node.** The official Node build (nodejs.org, checked against its
#   SHASUMS256.txt) is the one that installs the dependencies and the one that
#   ships in runtime/.
# - **Old enough to run anywhere it claims to.** The one binary compiled here,
#   the key-injection helper, is compiled in an AlmaLinux 8 container
#   (glibc 2.28). Everything else native is an upstream prebuild. Then every
#   ELF file in the package is read, and the build fails if any needs a glibc
#   newer than GLIBC_FLOOR or a libstdc++ newer than GLIBCXX_FLOOR — a failure
#   on this machine instead of on a stranger's.
# - **Licences travel.** Every production package shipped carries its own
#   licence file, or the build fails naming it; Node's LICENSE ships beside it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="$REPO_DIR/release"

# The Node every release runs on. Official builds need glibc 2.28.
NODE_VERSION=24.18.0
# Where the helper is compiled: glibc 2.28, libstdc++ from GCC 8.
BUILDER_IMAGE=quay.io/almalinux/almalinux:8
# The newest symbol versions any binary in a release may need: the builder's.
GLIBC_FLOOR=2.28
GLIBCXX_FLOOR=3.4.25

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Builds and publishes a Deckhand release.

  scripts/release.sh build <vX.Y.Z>     builds into release/<vX.Y.Z>/
  scripts/release.sh publish <vX.Y.Z>   uploads that build as the GitHub release
USAGE
  exit 2
}

# --- Checks before anything is built ------------------------------------------

check_version() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "\"$1\" is not a release version (vMAJOR.MINOR.PATCH)."
}

# A release never contains code that is not in a commit: the checkout is clean,
# HEAD is the tag, and the tag is annotated (install.sh's bug-report line uses
# git describe, which ignores lightweight tags).
check_tagged_checkout() {
  local version="$1"
  git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout."
  if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
    git -C "$REPO_DIR" status --short >&2
    die "the checkout has uncommitted changes (above). A release is built only from a clean, tagged checkout."
  fi
  git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$version" >/dev/null || die "there is no tag $version. Tag the commit first: git tag -a $version -m \"Deckhand $version\""
  [ "$(git -C "$REPO_DIR" cat-file -t "$version")" = tag ] || die "$version is a lightweight tag; releases need an annotated one (git tag -a)."
  [ "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$(git -C "$REPO_DIR" rev-parse "$version^{commit}")" ] \
    || die "HEAD is not $version. Check out the tag, or tag this commit."
}

check_tools() {
  local tool
  for tool in git curl tar xz sha256sum objdump podman; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is needed to build a release."
  done
}

# --- Building -------------------------------------------------------------------

# The official Node, checked against nodejs.org's list before it is unpacked.
# Cached by version, and checked again every time it is used.
fetch_node() {
  local cache="$OUT_ROOT/cache/node" name="node-v$NODE_VERSION-linux-x64.tar.xz"
  mkdir -p "$cache"
  [ -f "$cache/$name" ] || curl -fsSL -o "$cache/$name" "https://nodejs.org/dist/v$NODE_VERSION/$name"
  curl -fsSL -o "$cache/SHASUMS256-v$NODE_VERSION.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$cache" && grep -E "^[0-9a-f]{64}  $name\$" "SHASUMS256-v$NODE_VERSION.txt" | sha256sum -c --quiet -) \
    || die "Node $NODE_VERSION does not match nodejs.org's SHASUMS256.txt."
  mkdir -p "$WORK/node"
  tar -xJf "$cache/$name" -C "$WORK/node" --strip-components=1
}

# install.sh's own build, the one a developer install runs, into the stage —
# with the official Node first on PATH, so it is the Node that installs the
# dependencies and builds everything. The helper it compiles here is replaced
# below by one compiled on the builder image.
build_stage() {
  say "Building from $VERSION's committed tree"
  (
    sed '/^# --- main ---/,$d' "$WORK/src/scripts/install.sh" > "$WORK/install-fns.sh"
    # shellcheck source=/dev/null
    source "$WORK/install-fns.sh"
    export PATH="$WORK/node/bin:$PATH"
    REPO_DIR="$WORK/src"
    STAGE_DIR="$WORK/deckhand"
    SERVICE_NODE="$WORK/node/bin/node"
    build_and_stage
  )
}

# The key-injection helper, compiled where glibc is 2.28. Rootless podman: the
# container's root is this user, so what it writes is ours.
build_helper() {
  say "Compiling the key-injection helper on $BUILDER_IMAGE"
  # The image's AlmaLinux signing key is older than the one its packages are
  # signed with now, so dnf's signature check fails until the current key is
  # imported — over HTTPS, from AlmaLinux. The check stays on.
  podman run --rm -v "$WORK/src/helper:/helper:Z" "$BUILDER_IMAGE" \
    bash -c 'rpm --import https://repo.almalinux.org/almalinux/RPM-GPG-KEY-AlmaLinux \
      && dnf -q -y install gcc make kernel-headers >/dev/null \
      && make -C /helper clean >/dev/null && make -C /helper && ldd --version | head -n 1'
  install -m 755 "$WORK/src/helper/deckhand-input" "$WORK/deckhand/helper/deckhand-input"
}

# What makes the stage a release rather than a developer install: its own Node
# instead of a link to the system's, the stamped installer, the version.
finish_stage() {
  local stage="$WORK/deckhand"
  rm -f "$stage/runtime/node"
  install -m 755 "$WORK/node/bin/node" "$stage/runtime/node"
  install -m 644 "$WORK/node/LICENSE" "$stage/runtime/LICENSE"
  sed "s/^RELEASE_VERSION=\"\"\$/RELEASE_VERSION=\"$VERSION\"/" "$WORK/src/scripts/install.sh" > "$stage/install.sh"
  grep -qx "RELEASE_VERSION=\"$VERSION\"" "$stage/install.sh" || die "could not stamp the version into install.sh."
  chmod 755 "$stage/install.sh"
  echo "$VERSION" > "$stage/VERSION"
}

# --- The checks that refuse a release --------------------------------------------

# Every ELF file in the package, and the newest glibc and libstdc++ symbol
# versions it needs. Strict: one file over either floor fails the release, and
# so does an ELF file objdump cannot read.
check_glibc() {
  local stage="$WORK/deckhand" file versions glibc glibcxx bad=0 count=0
  say "Checking every binary against glibc $GLIBC_FLOOR and libstdc++ $GLIBCXX_FLOOR"
  while IFS= read -r -d '' file; do
    [ "$(head -c 4 "$file" | od -An -c | tr -d ' ')" = '177ELF' ] || continue
    count=$((count + 1))
    versions="$(objdump -T "$file" 2>/dev/null)" || { echo "  cannot read: ${file#"$stage"/}" >&2; bad=1; continue; }
    glibc="$(grep -o 'GLIBC_[0-9.]*' <<<"$versions" | sed 's/GLIBC_//' | sort -V | tail -n 1 || true)"
    glibcxx="$(grep -o 'GLIBCXX_[0-9.]*' <<<"$versions" | sed 's/GLIBCXX_//' | sort -V | tail -n 1 || true)"
    if [ -n "$glibc" ] && [ "$(printf '%s\n%s\n' "$glibc" "$GLIBC_FLOOR" | sort -V | tail -n 1)" != "$GLIBC_FLOOR" ]; then
      echo "  needs glibc $glibc: ${file#"$stage"/}" >&2; bad=1
    fi
    if [ -n "$glibcxx" ] && [ "$(printf '%s\n%s\n' "$glibcxx" "$GLIBCXX_FLOOR" | sort -V | tail -n 1)" != "$GLIBCXX_FLOOR" ]; then
      echo "  needs libstdc++ $glibcxx: ${file#"$stage"/}" >&2; bad=1
    fi
  done < <(find "$stage" -type f -print0)
  [ "$count" -gt 0 ] || die "no binaries found in the package — the scan is not looking where the package is."
  [ "$bad" = 0 ] || die "the package would not run on every machine its glibc $GLIBC_FLOOR floor claims (above). Nothing was published."
  say "$count binaries, none newer than glibc $GLIBC_FLOOR or libstdc++ $GLIBCXX_FLOOR"
}

# Packages whose npm package carries no licence text of its own, each with the
# file in the release that does. sharp-libvips ships prebuilt libvips and its
# dependencies; its README lists each library's licence, many LGPLv3, but the
# package has no licence text.
LICENCE_TEXT_ELSEWHERE=(
  "node_modules/@img/sharp-libvips-linux-x64=licenses/LGPL-3.0.txt"
)

# Every production package the lock says ships, and is on disk, has a licence
# file of its own (LICENSE, LICENSE-MIT.txt, LICENSE.APACHE2, COPYING, ...) or
# is named above with a file that is really in the package. And the licences
# of what is not an npm package: Deckhand's, Node's, Electron's.
check_licences() {
  local stage="$WORK/deckhand" entry
  say "Checking every shipped package carries its licence"
  for entry in "${LICENCE_TEXT_ELSEWHERE[@]}"; do
    [ -f "$stage/${entry#*=}" ] || die "${entry%%=*} relies on ${entry#*=}, which is not in the package."
  done
  (cd "$stage" && DECKHAND_ELSEWHERE="${LICENCE_TEXT_ELSEWHERE[*]}" "$WORK/node/bin/node" -e '
    const fs = require("fs");
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const elsewhere = new Set(process.env.DECKHAND_ELSEWHERE.split(" ").map((e) => e.split("=")[0]));
    const missing = [];
    let count = 0;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === "" || entry.dev || entry.devOptional || !fs.existsSync(key)) continue;
      count++;
      const own = fs.readdirSync(key).some((f) => /^(licen[cs]e|copying)([._-].*)?$/i.test(f));
      if (!own && !elsewhere.has(key)) missing.push(key);
    }
    if (missing.length) { console.error("  no licence file: " + missing.join(", ")); process.exit(1); }
    console.log("    " + count + " packages");
  ') || die "a shipped package has no licence file (above)."
  local file
  for file in LICENSE runtime/LICENSE editor/electron/LICENSE editor/electron/LICENSES.chromium.html editor/dist/THIRD-PARTY-NOTICES.txt; do
    [ -f "$stage/$file" ] || die "$file is missing from the package."
  done
}

# --- Packing -----------------------------------------------------------------------

pack() {
  local out="$1" asset="deckhand-$VERSION-linux-x64.tar.xz" mtime
  # The tag's commit time, and files sorted and owned by nobody in particular,
  # so the same tag packs to the same bytes.
  mtime="$(git -C "$REPO_DIR" log -1 --format=%ct "$VERSION^{commit}")"
  say "Packing $asset"
  tar -C "$WORK" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" -cf - deckhand \
    | xz -T0 -6 > "$out/$asset"
  install -m 755 "$WORK/deckhand/install.sh" "$out/install.sh"
  (cd "$out" && sha256sum "$asset" install.sh > SHA256SUMS)
  say "Built:"
  (cd "$out" && ls -l "$asset" install.sh SHA256SUMS | awk '{printf "  %-40s %s bytes\n", $9, $5}')
}

cmd_build() {
  [ $# -eq 1 ] || usage
  VERSION="$1"
  check_version "$VERSION"
  check_tools
  check_tagged_checkout "$VERSION"
  local out="$OUT_ROOT/$VERSION"
  WORK="$OUT_ROOT/work-$VERSION"
  rm -rf "$WORK" "$out"
  mkdir -p "$WORK/src" "$out"
  git -C "$REPO_DIR" archive "$VERSION" | tar -x -C "$WORK/src"
  fetch_node
  build_stage
  build_helper
  finish_stage
  check_glibc
  check_licences
  pack "$out"
  rm -rf "$WORK"
  say "Next: install it and test what ships (scripts/test/release-ships.sh $VERSION), then: scripts/release.sh publish $VERSION"
}

cmd_publish() {
  [ $# -eq 1 ] || usage
  VERSION="$1"
  check_version "$VERSION"
  check_tagged_checkout "$VERSION"
  local out="$OUT_ROOT/$VERSION" asset="deckhand-$VERSION-linux-x64.tar.xz"
  [ -f "$out/$asset" ] && [ -f "$out/SHA256SUMS" ] && [ -f "$out/install.sh" ] || die "no build of $VERSION in $out; run: scripts/release.sh build $VERSION"
  (cd "$out" && sha256sum -c --quiet SHA256SUMS) || die "the build in $out does not match its own SHA256SUMS."
  command -v gh >/dev/null 2>&1 || die "gh is needed to publish."
  git -C "$REPO_DIR" ls-remote --exit-code --tags origin "refs/tags/$VERSION" >/dev/null || die "$VERSION is not pushed to origin: git push origin $VERSION"
  gh release create "$VERSION" --verify-tag --title "Deckhand $VERSION" \
    --notes "Install or update: \`curl -fsSL https://github.com/juicetheforce/deckhand/releases/latest/download/install.sh | bash\`. SHA256SUMS lets the installer check the download is complete and uncorrupted; it does not prove who made it." \
    "$out/$asset" "$out/install.sh" "$out/SHA256SUMS"
}

# --- main ----------------------------------------------------------------------------

main() {
  [ $# -ge 1 ] || usage
  local command="$1"; shift
  case "$command" in
    build)   cmd_build "$@" ;;
    publish) cmd_publish "$@" ;;
    *)       usage ;;
  esac
}

main "$@"
