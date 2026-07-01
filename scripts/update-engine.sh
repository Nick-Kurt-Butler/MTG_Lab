#!/usr/bin/env bash
#
# update-engine.sh — pull the latest Forge ENGINE from upstream and rebuild the
# bridge. Fully automated: no hand-merging of Forge code, ever.
#
# Forge is a big monorepo (desktop GUI, mobile, adventure mode, installer, …) but
# the Lab only needs the engine: forge-core, forge-game, forge-ai, forge-gui.
# This script shallow-clones upstream, copies in ONLY those engine modules, then
# installs + rebuilds the bridge against them. Your UI/app code is never touched.
#
# Layout it maintains:
#   MTG_Lab/engine/forge/   ← engine modules (kept in sync with upstream)
#
# Usage:
#   ./scripts/update-engine.sh            # fetch upstream master, refresh engine, rebuild
#   FORGE_REF=v2.0.14 ./scripts/update-engine.sh   # pin a tag/branch
#
# Requirements: git, rsync, Maven, JDK 21 (JAVA_HOME or on PATH). Needs network
# access to github.com (a corporate proxy may block this — if the clone fails,
# run it from a network that can reach GitHub).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="$(cd "$HERE/.." && pwd)"
ENGINE="$LAB/engine/forge"
BRIDGE="$LAB/bridge"
REPO_URL="${FORGE_REPO:-https://github.com/Card-Forge/forge.git}"
REF="${FORGE_REF:-master}"

# Only these top-level dirs/files are the "engine piece" we keep.
ENGINE_PARTS=(forge-core forge-game forge-ai forge-gui pom.xml)

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "==> Cloning $REPO_URL ($REF), engine modules only…"
git clone --depth 1 --branch "$REF" --filter=blob:none --sparse "$REPO_URL" "$TMP/forge"
git -C "$TMP/forge" sparse-checkout set "${ENGINE_PARTS[@]}"

echo "==> Refreshing $ENGINE"
mkdir -p "$ENGINE"
for part in "${ENGINE_PARTS[@]}"; do
  if [[ -e "$TMP/forge/$part" ]]; then
    rsync -a --delete "$TMP/forge/$part" "$ENGINE/"
  fi
done

# Sync the bridge's compile-time Forge version to whatever upstream now is.
FORGE_VER="$(mvn -q -f "$ENGINE/pom.xml" help:evaluate -Dexpression=project.version -DforceStdout 2>/dev/null | tail -1 || true)"
if [[ -n "$FORGE_VER" ]]; then
  echo "==> Forge version: $FORGE_VER  → syncing bridge/pom.xml"
  perl -0pi -e "s|(<forge\.version>)[^<]*(</forge\.version>)|\${1}$FORGE_VER\${2}|" "$BRIDGE/pom.xml"
fi

echo "==> Installing engine modules to local Maven repo (slow part)…"
mvn -q -f "$ENGINE/pom.xml" -pl forge-ai,forge-gui -am install -DskipTests

echo "==> Rebuilding bridge.jar…"
mvn -q -f "$BRIDGE/pom.xml" clean package

echo "==> Done. Engine updated to $FORGE_VER and bridge rebuilt."
echo "    Relaunch the app to use it. Your UI/app code and saved decks are untouched."
