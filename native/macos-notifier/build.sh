#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$ROOT_DIR/native/AgentSessionNotifier.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICONS_DIR="$ROOT_DIR/media/icons"

# Prefer Command Line Tools when Xcode.app license hasn't been accepted yet.
SWIFTC="swiftc"
SDK_ARGS=()
if ! swiftc --version </dev/null >/dev/null 2>&1; then
  if [ -x "/Library/Developer/CommandLineTools/usr/bin/swiftc" ] && [ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk" ]; then
    export DEVELOPER_DIR="/Library/Developer/CommandLineTools"
    SWIFTC="/Library/Developer/CommandLineTools/usr/bin/swiftc"
    SDK_ARGS=(-sdk "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk")
  fi
fi

# Use a writable module cache under /tmp so builds work cleanly in restricted environments.
MODULE_CACHE="${TMPDIR:-/tmp}/asm-swift-module-cache"
if [ ! -w "${TMPDIR:-/tmp}" ]; then
  MODULE_CACHE="/tmp/asm-swift-module-cache"
fi
mkdir -p "$MODULE_CACHE"
export CLANG_MODULE_CACHE_PATH="$MODULE_CACHE"
export SWIFT_MODULECACHE_PATH="$MODULE_CACHE"
SDK_ARGS+=(-module-cache-path "$MODULE_CACHE")

BUILD_TMP="$(mktemp -d /tmp/asm-notifier-build.XXXXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT

# Generate icons & AppIcon.icns if missing (or when --regen-icons is passed).
if [ "${1:-}" = "--regen-icons" ] || [ ! -f "$ICONS_DIR/AppIcon.icns" ] || [ ! -f "$ICONS_DIR/app.png" ]; then
  echo "Generating icon assets..."
  ICON_GEN_BIN="$BUILD_TMP/asm-icongen"
  "$SWIFTC" -O -swift-version 5 "${SDK_ARGS[@]}" \
    -framework AppKit -framework CoreGraphics -framework CoreText -framework ImageIO -framework UniformTypeIdentifiers \
    "$ICONS_DIR/generate-icons.swift" -o "$ICON_GEN_BIN"
  "$ICON_GEN_BIN" "$ICONS_DIR"
fi

echo "Building AgentSessionNotifier.app (universal: arm64 + x86_64)..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$ICONS_DIR/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
# The app name macOS shows follows the system language.
for LPROJ in "$SCRIPT_DIR"/*.lproj; do
  cp -R "$LPROJ" "$RESOURCES_DIR/"
done

"$SWIFTC" -O -swift-version 5 -target arm64-apple-macos12.0 "${SDK_ARGS[@]}" \
  -framework AppKit -framework UserNotifications \
  "$SCRIPT_DIR/main.swift" -o "$BUILD_TMP/AgentSessionNotifier-arm64"

X86_BUILT=0
for X86_MIN in 12.0 13.0 14.0; do
  if "$SWIFTC" -O -swift-version 5 -target "x86_64-apple-macos${X86_MIN}" "${SDK_ARGS[@]}" \
    -framework AppKit -framework UserNotifications \
    "$SCRIPT_DIR/main.swift" -o "$BUILD_TMP/AgentSessionNotifier-x86_64" 2>"$BUILD_TMP/x86.err"; then
    if [ "$X86_MIN" != "12.0" ]; then
      echo "Note: built x86_64 slice with target x86_64-apple-macos${X86_MIN} (host toolchain lacks x86_64 Swift 5.6 compatibility archive for macOS 12)."
    fi
    X86_BUILT=1
    break
  fi
done
if [ "$X86_BUILT" -ne 1 ]; then
  cat "$BUILD_TMP/x86.err" >&2
  exit 1
fi

lipo -create -output "$MACOS_DIR/AgentSessionNotifier" \
  "$BUILD_TMP/AgentSessionNotifier-arm64" \
  "$BUILD_TMP/AgentSessionNotifier-x86_64"

chmod 755 "$MACOS_DIR/AgentSessionNotifier"

echo "Signing AgentSessionNotifier.app (ad-hoc)..."
codesign --force --deep --sign - "$APP_DIR"

echo "Built: $APP_DIR"
