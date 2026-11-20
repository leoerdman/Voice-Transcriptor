#!/usr/bin/env bash
# Builds the native helpers the desktop shell ships beside the Python
# runtime. Today that is one: `screen-input`, the CGEventTap that lets
# screen mode tell a click (passed through to the app underneath) from a
# press-and-drag (a stroke drawn on the overlay). Source:
# desktop/native/screen-input/ (main.swift: the tap; PressClassifier.swift: the rule).
#
# Output: desktop/native/build/<target>/ — copied by electron-builder to
# Contents/Resources/runtime/bin, inside the runtime root, so afterPack's
# runtime pre-sign pass signs it with the same identity and options as
# every other bundled Mach-O.
#
# Usage: build-native.sh <target>   (mac-arm64 | win-x64 | linux-x64)
# macOS release builds are arm64-only (BUILD.command, prepare-runtime.sh).
set -euo pipefail

TARGET="${1:?usage: build-native.sh <target>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/native/build/$TARGET"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

case "$TARGET" in
  mac-arm64) ARCH="arm64" ;;
  mac-*)
    echo "[build-native] $TARGET: macOS builds are arm64-only" >&2
    exit 1
    ;;
  *)
    # Screen mode is macOS-only; other targets ship an empty directory so
    # the packaging layout is the same everywhere.
    echo "[build-native] $TARGET: no native helpers"
    exit 0
    ;;
esac

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "[build-native] swiftc not found — install the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

xcrun swiftc -O \
  -target "${ARCH}-apple-macos12" \
  "$DESKTOP_DIR/native/screen-input/PressClassifier.swift" \
  "$DESKTOP_DIR/native/screen-input/main.swift" \
  -o "$OUT_DIR/screen-input"
chmod 755 "$OUT_DIR/screen-input"
echo "[build-native] built $OUT_DIR/screen-input"
