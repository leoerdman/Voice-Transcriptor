#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

die() {
  echo "[mas-build] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_envs() {
  local missing=()
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "Missing required environment variables: ${missing[*]}"
  fi
}

require_envs \
  TRANSCRIPTOR_MAS_APP_ID \
  TRANSCRIPTOR_MAS_SIGNING_IDENTITY \
  TRANSCRIPTOR_MAS_INSTALLER_IDENTITY \
  TRANSCRIPTOR_MAS_PROVISIONING_PROFILE

case "$TRANSCRIPTOR_MAS_APP_ID" in
  local.*)
    die "TRANSCRIPTOR_MAS_APP_ID must be an explicit App Store Connect bundle id, not local.*"
    ;;
esac

[ -f "$TRANSCRIPTOR_MAS_PROVISIONING_PROFILE" ] || \
  die "Provisioning profile not found: $TRANSCRIPTOR_MAS_PROVISIONING_PROFILE"

require_cmd bash
require_cmd node
require_cmd npm
require_cmd npx
require_cmd xcodebuild
require_cmd codesign
require_cmd productbuild
require_cmd security
require_cmd plutil
require_cmd shasum

ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || die "MAS build currently supports arm64 macOS only; got $ARCH"

echo "[mas-build] Running App Store signing preflight"
node ./scripts/sign-mas.js --preflight

echo "[mas-build] Preparing bundled runtime"
bash ./scripts/prepare-runtime.sh mac-arm64

# electron-builder builds the mas target from build.mac MERGED with
# build.mas (app-builder-lib macPackager getPlatformConfig → deepAssign,
# which concatenates arrays), so build.mac.extraResources' screen-mode
# helper entry (native/build/mac-<arch> → runtime/bin) applies here too.
# The App Store build ships no helper — an active CGEventTap cannot run
# in the App Sandbox — so that directory is emptied; afterPack refuses a
# MAS bundle that still carries one. A dev run rebuilds it with
# `bash scripts/build-native.sh mac-arm64` (every mac dist script does).
echo "[mas-build] Leaving screen mode's native helper out of the App Store build"
rm -rf ./native/build/mac-arm64
mkdir -p ./native/build/mac-arm64

echo "[mas-build] Unlocking previous dist outputs"
node ./unlockDist.js

echo "[mas-build] Building frontend"
npm run build:frontend

echo "[mas-build] Packaging unsigned MAS-flavored Electron app"
TRANSCRIPTOR_MAS_EXTERNAL_SIGN=1 \
CSC_IDENTITY_AUTO_DISCOVERY=false \
npx electron-builder --mac mas --arm64 \
  --config.mas.appId="$TRANSCRIPTOR_MAS_APP_ID"

echo "[mas-build] Signing MAS app and creating App Store Connect pkg"
node ./scripts/sign-mas.js

echo "[mas-build] Done"
echo "[mas-build] Upload with: npm --prefix \"$DESKTOP_DIR\" run testflight:upload"
