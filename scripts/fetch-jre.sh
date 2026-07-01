#!/usr/bin/env bash
#
# fetch-jre.sh — download a Temurin (Eclipse Adoptium) JRE 21 for a target
# platform and normalize it so the java home lives directly at $DEST
# (i.e. $DEST/bin/java or $DEST/bin/java.exe). build-app.sh bundles this so the
# packaged app needs no system Java — true one-click for players.
#
# Usage: ./scripts/fetch-jre.sh <os> <arch> <dest>
#   os   : mac | linux | windows
#   arch : x64 | aarch64
#
# Requires: curl, tar, and (for windows) unzip. Needs network to api.adoptium.net.
set -euo pipefail

OS="${1:?os: mac|linux|windows}"
ARCH="${2:?arch: x64|aarch64}"
DEST="${3:?dest dir}"

URL="https://api.adoptium.net/v3/binary/latest/21/ga/${OS}/${ARCH}/jre/hotspot/normal/eclipse?project=jdk"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/x"

echo "==> Downloading Temurin JRE 21 ($OS/$ARCH)…"
if [[ "$OS" == "windows" ]]; then
  curl -fSL "$URL" -o "$TMP/jre.zip"
  unzip -q "$TMP/jre.zip" -d "$TMP/x"
else
  curl -fSL "$URL" -o "$TMP/jre.tgz"
  tar -xzf "$TMP/jre.tgz" -C "$TMP/x"
fi

# Find the java home (the dir whose bin/ holds the java launcher). On macOS the
# archive nests it under Contents/Home; elsewhere it's the top extracted dir.
LAUNCHER="$(find "$TMP/x" -type f \( -name java -o -name java.exe \) -path '*/bin/*' | head -1)"
[[ -n "$LAUNCHER" ]] || { echo "ERROR: no java launcher found in archive"; exit 1; }
HOME_DIR="$(cd "$(dirname "$LAUNCHER")/.." && pwd)"

echo "==> Staging JRE at $DEST"
rm -rf "$DEST"; mkdir -p "$DEST"
cp -R "$HOME_DIR/." "$DEST/"
echo "==> Done: $("$DEST/bin/java" -version 2>&1 | head -1 || echo 'java (target-arch, not run here)')"
