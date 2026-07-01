#!/usr/bin/env bash
#
# build-app.sh — package MTG Lab into a one-click installer for ONE platform.
#
# Bundles (as app resources): bridge.jar, the Forge card-data dir (forge-gui),
# the test decks, and a matching Java runtime — so the installed app needs
# nothing else (no Java install). A stable appId keeps userData (saved decks)
# across updates: install a new build over the old and decks survive.
#
# Build ONE platform per run, on that platform (or a CI runner of that OS).
# Cross-OS builds from a different OS are unreliable, so this script targets the
# host OS by default. For all three platforms at once, use the GitHub Actions
# workflow (.github/workflows/release.yml).
#
# Usage:
#   ./scripts/build-app.sh                 # host OS, auto-download matching JRE
#   ./scripts/build-app.sh --with-jre DIR  # use a local JRE home instead of downloading
#   ./scripts/build-app.sh --no-jre        # rely on the user's system Java (not one-click)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="$(cd "$HERE/.." && pwd)"
APP="$LAB/app"
JRE_MODE="auto"      # auto | none | <path>

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-jre) JRE_MODE="$2"; shift 2 ;;
    --no-jre)   JRE_MODE="none"; shift ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

# Detect host OS/arch and the matching electron-builder + Adoptium identifiers.
case "$(uname -s)" in
  Darwin) EB_FLAG="--mac";   ADOPT_OS="mac" ;;
  Linux)  EB_FLAG="--linux"; ADOPT_OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) EB_FLAG="--win"; ADOPT_OS="windows" ;;
  *) echo "unsupported host OS"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ADOPT_ARCH="aarch64" ;;
  x86_64|amd64)  ADOPT_ARCH="x64" ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

JAR="$LAB/bridge/target/bridge.jar"
FORGE_GUI="$LAB/engine/forge/forge-gui"
[[ -f "$JAR" ]] || { echo "ERROR: $JAR not found — run ./scripts/update-engine.sh first."; exit 1; }
[[ -d "$FORGE_GUI" ]] || { echo "ERROR: $FORGE_GUI not found — run ./scripts/update-engine.sh first."; exit 1; }

echo "==> Building UI bundle (vite)…"
( cd "$APP" && npm run build )

# Stage extraResources under app/ (electron-builder resolves `from` relative to app/).
# Use cp (portable across mac/linux/Windows Git Bash) rather than rsync.
STAGE="$APP/build/res"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$JAR" "$STAGE/bridge.jar"
cp -R "$LAB/bridge/test-decks" "$STAGE/test-decks"
cp -R "$FORGE_GUI" "$STAGE/forge-gui"

JRE_BLOCK=""
if [[ "$JRE_MODE" == "none" ]]; then
  echo "==> No JRE bundled — app will require system Java 21."
elif [[ "$JRE_MODE" == "auto" ]]; then
  "$HERE/fetch-jre.sh" "$ADOPT_OS" "$ADOPT_ARCH" "$STAGE/jre"
  JRE_BLOCK='  - { from: build/res/jre, to: jre }'
else
  echo "==> Bundling JRE from $JRE_MODE"
  mkdir -p "$STAGE/jre"; cp -R "$JRE_MODE/." "$STAGE/jre/"
  JRE_BLOCK='  - { from: build/res/jre, to: jre }'
fi

CONFIG="$APP/build/electron-builder.yml"
mkdir -p "$APP/build"
cat > "$CONFIG" <<YML
appId: com.mtglab.app
productName: MTG Lab
directories:
  output: ../release
files:
  - dist/**
  - electron.cjs
  - preload.cjs
  - package.json
extraResources:
  - { from: build/res/bridge.jar, to: bridge.jar }
  - { from: build/res/test-decks, to: test-decks }
  - { from: build/res/forge-gui, to: forge-gui }
$JRE_BLOCK
mac:
  category: public.app-category.games
  target: pkg
pkg:
  # Install straight to /Applications with no extra wizard pages.
  isRelocatable: false
  installLocation: /Applications
win:
  # One-click NSIS installer (no wizard clicks), per-user so no admin prompt.
  target: nsis
nsis:
  oneClick: true
  perMachine: false
linux:
  target: AppImage
  category: Game
YML

echo "==> Packaging $EB_FLAG with electron-builder…"
( cd "$APP" && npx electron-builder --config build/electron-builder.yml "$EB_FLAG" )

# Collect the finished installer(s) into one shareable folder, one file per OS.
DEST="$LAB/installers"
mkdir -p "$DEST"
shopt -s nullglob
for f in "$LAB"/release/*.pkg "$LAB"/release/*.dmg "$LAB"/release/*.exe "$LAB"/release/*.AppImage; do
  cp "$f" "$DEST/"
done
echo "==> Done. Shareable installers in $DEST:"
ls -lh "$DEST" 2>/dev/null | grep -v '^total' || true
