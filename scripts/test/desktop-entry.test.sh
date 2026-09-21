#!/bin/bash
# The editor's desktop entry and icon: install_desktop_entry and
# remove_desktop_entry from scripts/install.sh, run against a scratch HOME.
# Sources install.sh's functions (everything above its "main" section), so it
# tests the real code without building or touching the installed app.
#
# Usage: bash scripts/test/desktop-entry.test.sh   (exit status 0 = all pass)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
sed '/^# --- main ---/,$d' "$REPO/scripts/install.sh" > "$S/fns.sh"
export HOME="$S/home"; mkdir -p "$HOME"
source "$S/fns.sh"
DATA_HOME="$HOME/.local/share"; APP_DIR="$DATA_HOME/deckhand"
APPLICATIONS_DIR="$DATA_HOME/applications"; ICON_THEME_DIR="$DATA_HOME/icons/hicolor"
CLI_DIR="$HOME/.local/bin"; EDITOR_LAUNCHER="$CLI_DIR/deckhand-editor"
mkdir -p "$APP_DIR/editor" "$APP_DIR/assets/logo"
cp "$REPO/editor/package.json" "$APP_DIR/editor/"; cp -r "$REPO/assets/logo/png" "$APP_DIR/assets/logo/"; cp "$REPO/assets/logo/deckhand.svg" "$APP_DIR/assets/logo/"
fail=0; ok() { echo "PASS  $1"; }; no() { echo "FAIL  $1"; fail=1; }
id="$(desktop_id)"; [ "$id" = io.github.juicetheforce.Deckhand ] && ok "id read from package.json: $id" || no "id: $id"
entry="$APPLICATIONS_DIR/$id.desktop"
install_desktop_entry >/dev/null 2>&1; [ ! -e "$entry" ] && ok "no launcher of ours: no entry" || no "entry written without a launcher"
install_editor_launcher >/dev/null
install_desktop_entry >/dev/null
[ -f "$entry" ] && ok "entry written" || no "no entry"
n=$(ls "$ICON_THEME_DIR"/*/apps/$id.* 2>/dev/null | wc -l); [ "$n" = 9 ] && ok "9 icon files (8 sizes + scalable)" || no "icon files: $n"
grep -qx "Exec=\"$EDITOR_LAUNCHER\"" "$entry" && grep -qx "StartupWMClass=$id" "$entry" && grep -qx "Icon=$id" "$entry" && ok "Exec, Icon, StartupWMClass" || no "entry contents"
if command -v desktop-file-validate >/dev/null; then out="$(desktop-file-validate "$entry" 2>&1)"; [ -z "$out" ] && ok "desktop-file-validate clean" || no "desktop-file-validate: $out"; else echo "SKIP  desktop-file-validate not installed"; fi
cmp -s "$APP_DIR/assets/logo/png/apps/16.png" "$ICON_THEME_DIR/16x16/apps/$id.png" && ok "16 px is the small drawing's render" || no "16 px icon"
install_desktop_entry >/dev/null && [ -f "$entry" ] && ok "reinstall over our own entry" || no "reinstall"
remove_desktop_entry "$id" >/dev/null
[ ! -e "$entry" ] && [ -z "$(find "$ICON_THEME_DIR" -type f)" ] && ok "remove: entry and every icon gone" || no "remove left files"
printf '[Desktop Entry]\nName=Someone else\n' > "$entry"
install_desktop_entry >/dev/null 2>&1; grep -q "Someone else" "$entry" && ok "a foreign entry is not overwritten" || no "foreign entry overwritten"
remove_desktop_entry "$id" >/dev/null 2>&1; [ -f "$entry" ] && ok "a foreign entry is not removed" || no "foreign entry removed"
exit $fail
