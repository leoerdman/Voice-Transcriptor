#!/usr/bin/env bash
# ============================================================================
#  Transcriptor - installer for another Apple Silicon Mac
#
#  Put this file next to either:
#    - Transcriptor-<version>-arm64.dmg
#    - Transcriptor-<version>-arm64-internal.zip
#    - Transcriptor.app
#
#  Then run:
#    bash INSTALL_ON_OTHER_MAC.command
# ============================================================================
set -euo pipefail

PRODUCT_NAME="Transcriptor"
APP_NAME="Transcriptor.app"
DMG_PATTERN="Transcriptor-*-arm64.dmg"
ZIP_PATTERN="Transcriptor-*-arm64-internal.zip"
RELEASE_MANIFEST_NAME="TRANSCRIPTOR_RELEASE_MANIFEST.txt"
DEFAULT_EXPECTED_BUNDLE_ID="local.transcriptor.app"
TARGET_ROOT="${TRANSCRIPTOR_INSTALL_DIR:-/Applications}"
TARGET_APP="${TARGET_ROOT}/${APP_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR=""
MOUNT_DIR=""
SOURCE_APP=""
EXPECTED_BUNDLE_ID="${TRANSCRIPTOR_EXPECTED_BUNDLE_ID:-$DEFAULT_EXPECTED_BUNDLE_ID}"
MANIFEST_DMG_NAME=""
MANIFEST_ZIP_NAME=""
# Set in main() once it knows whether the install root is writable.
NEEDS_SUDO=0

log() {
  printf '[Transcriptor installer] %s\n' "$*"
}

die() {
  printf '[Transcriptor installer] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    chmod -R u+w "$TMP_DIR" 2>/dev/null || true
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

run_privileged() {
  if [ "${NEEDS_SUDO}" = "1" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

remove_path_privileged() {
  local target="$1"
  [ -e "$target" ] || return 0
  run_privileged chmod -R u+w "$target" 2>/dev/null || true
  run_privileged rm -rf "$target"
}

verify_app() {
  local app_path="$1"
  [ -d "$app_path" ] || die "App bundle not found: $app_path"
  if ! codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1; then
    codesign --verify --deep --strict --verbose=2 "$app_path"
    die "Code signature verification failed: $app_path"
  fi
  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  [ "$bundle_id" = "$EXPECTED_BUNDLE_ID" ] || die "Unexpected bundle id: ${bundle_id:-unknown}; expected ${EXPECTED_BUNDLE_ID}"
}

# Empty when the bundle is unsigned or has no explicit requirement.
designated_requirement() {
  local out
  out="$(codesign -d --requirements - "$1" 2>/dev/null || true)"
  printf '%s\n' "$out" | sed -n 's/^designated => //p'
}

is_adhoc_signed() {
  local info
  info="$(codesign -dv "$1" 2>&1 || true)"
  case "$info" in
    *"Signature=adhoc"*) return 0 ;;
  esac
  return 1
}

# macOS keys every permission grant (Accessibility, Automation, Microphone)
# to the bundle id AND the designated requirement of the signature that
# earned it. Installing a bundle signed by another certificate — or ad hoc,
# whose requirement is the hash of one exact build — over a copy the user
# has already granted leaves every switch ON in System Settings and the app
# refused in practice. `codesign --verify` accepts both, so this is checked
# here, as BUILD.command does with check-designated-requirement.js.
verify_identity_continuity() {
  local new_app="$1"
  local installed_app="$2"
  local new_req
  local installed_req
  if is_adhoc_signed "$new_app"; then
    die "$(basename "$new_app") is ad-hoc signed: every permission granted to it would stop working at the next install. Use a build signed with the release certificate."
  fi
  new_req="$(designated_requirement "$new_app")"
  [ -n "$new_req" ] || die "Cannot read the signature requirement of $new_app"
  [ -d "$installed_app" ] || return 0
  # An unsigned or ad-hoc installed copy had no grants that could survive.
  if is_adhoc_signed "$installed_app"; then
    return 0
  fi
  installed_req="$(designated_requirement "$installed_app")"
  [ -n "$installed_req" ] || return 0
  if [ "$new_req" != "$installed_req" ]; then
    die "This build is signed by a different certificate than the installed ${installed_app}. Installing it would leave every permission you granted switched on in System Settings but refused. If you mean to switch certificates, remove ${installed_app} first and grant the permissions again."
  fi
}

read_manifest_value() {
  local key="$1"
  local manifest_path="${SCRIPT_DIR}/${RELEASE_MANIFEST_NAME}"
  [ -f "$manifest_path" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$manifest_path"
}

validate_manifest_basename() {
  local label="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  case "$value" in
    */*|*..*)
      die "Invalid ${label} in ${RELEASE_MANIFEST_NAME}: ${value}"
      ;;
  esac
}

load_release_manifest() {
  local manifest_path="${SCRIPT_DIR}/${RELEASE_MANIFEST_NAME}"
  local manifest_app_id
  [ -f "$manifest_path" ] || return 0
  manifest_app_id="$(read_manifest_value "app_id")"
  if [ -n "$manifest_app_id" ]; then
    EXPECTED_BUNDLE_ID="$manifest_app_id"
  fi
  MANIFEST_DMG_NAME="$(read_manifest_value "dmg")"
  MANIFEST_ZIP_NAME="$(read_manifest_value "internal_zip")"
  validate_manifest_basename "DMG name" "$MANIFEST_DMG_NAME"
  validate_manifest_basename "internal ZIP name" "$MANIFEST_ZIP_NAME"
  log "Using release manifest ${RELEASE_MANIFEST_NAME}"
}

artifact_from_manifest_or_pattern() {
  local manifest_name="$1"
  local pattern="$2"
  local label="$3"
  if [ -n "$manifest_name" ]; then
    local manifest_path="${SCRIPT_DIR}/${manifest_name}"
    [ -f "$manifest_path" ] || die "${RELEASE_MANIFEST_NAME} expects missing ${label}: ${manifest_name}"
    printf '%s\n' "$manifest_path"
    return 0
  fi
  find_single_artifact "$pattern" "$label"
}

find_single_artifact() {
  local pattern="$1"
  local label="$2"
  local old_nullglob
  local -a matches=()
  old_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  matches=("${SCRIPT_DIR}"/${pattern})
  if [ -n "$old_nullglob" ]; then
    eval "$old_nullglob"
  else
    shopt -u nullglob
  fi
  if [ "${#matches[@]}" -gt 1 ]; then
    printf '[Transcriptor installer] ERROR: multiple %s artifacts found:\n' "$label" >&2
    printf '  %s\n' "${matches[@]}" >&2
    exit 1
  fi
  if [ "${#matches[@]}" -eq 1 ]; then
    printf '%s\n' "${matches[0]}"
  fi
  return 0
}

prepare_source_app() {
  TMP_DIR="$(mktemp -d)"

  local dmg_path
  dmg_path="$(artifact_from_manifest_or_pattern "$MANIFEST_DMG_NAME" "$DMG_PATTERN" "DMG")"
  if [ -n "$dmg_path" ]; then
    MOUNT_DIR="$(mktemp -d)"
    log "Mounting $(basename "$dmg_path")"
    xattr -dr com.apple.quarantine "$dmg_path" 2>/dev/null || true
    if ! hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$MOUNT_DIR" -quiet; then
      die "Failed to mount $(basename "$dmg_path"). Run: xattr -dr com.apple.quarantine \"$dmg_path\"; or install from the matching internal ZIP."
    fi
    SOURCE_APP="${MOUNT_DIR}/${APP_NAME}"
    return
  fi

  local zip_path
  zip_path="$(artifact_from_manifest_or_pattern "$MANIFEST_ZIP_NAME" "$ZIP_PATTERN" "internal ZIP")"
  if [ -n "$zip_path" ]; then
    log "Unpacking $(basename "$zip_path")"
    xattr -dr com.apple.quarantine "$zip_path" 2>/dev/null || true
    unzip -q "$zip_path" -d "$TMP_DIR"
    SOURCE_APP="${TMP_DIR}/${APP_NAME}"
    return
  fi

  if [ -d "${SCRIPT_DIR}/${APP_NAME}" ]; then
    SOURCE_APP="${SCRIPT_DIR}/${APP_NAME}"
    return
  fi

  die "Put ${DMG_PATTERN}, ${ZIP_PATTERN}, or ${APP_NAME} next to this installer."
}

quit_existing_app() {
  osascript -e "tell application \"${PRODUCT_NAME}\" to quit" >/dev/null 2>&1 || true
  local deadline=$((SECONDS + 12))
  local killed=0
  while pgrep -x "$PRODUCT_NAME" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      # Replacing a bundle under a live process is exactly what this step
      # exists to prevent: stop it, and refuse to go on if it will not go.
      [ "$killed" = "0" ] || die "${PRODUCT_NAME} is still running; quit it and run the installer again."
      log "Stopping still-running ${PRODUCT_NAME} process"
      pkill -x "$PRODUCT_NAME" >/dev/null 2>&1 || true
      killed=1
      deadline=$((SECONDS + 5))
    fi
    sleep 1
  done
}

install_app() {
  local target_root="$1"
  local target_app="$2"
  local stamp
  local installing_app
  local backup_app
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  installing_app="${target_root}/.${APP_NAME}.installing.$$"
  backup_app="${target_app}.backup-${stamp}"

  run_privileged mkdir -p "$target_root"
  remove_path_privileged "$installing_app"

  log "Copying ${APP_NAME} to ${target_root}"
  run_privileged ditto "$SOURCE_APP" "$installing_app"
  run_privileged xattr -dr com.apple.quarantine "$installing_app" 2>/dev/null || true

  verify_app "$installing_app"

  if [ -e "$target_app" ]; then
    log "Replacing existing ${target_app}"
    remove_path_privileged "$backup_app"
    run_privileged mv "$target_app" "$backup_app"
  fi

  if ! run_privileged mv "$installing_app" "$target_app"; then
    if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then
      run_privileged mv "$backup_app" "$target_app"
    fi
    remove_path_privileged "$installing_app"
    die "Failed to move app into ${target_app}"
  fi

  run_privileged xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
  verify_app "$target_app"

  if [ -e "$backup_app" ]; then
    remove_path_privileged "$backup_app"
  fi
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."
  [ "$(uname -m)" = "arm64" ] || die "This build is for Apple Silicon Macs only."
  require_cmd hdiutil
  require_cmd unzip
  require_cmd ditto
  require_cmd codesign
  require_cmd xattr
  require_cmd osascript
  require_cmd pgrep

  load_release_manifest
  prepare_source_app
  verify_app "$SOURCE_APP"
  verify_identity_continuity "$SOURCE_APP" "$TARGET_APP"

  local target_parent
  target_parent="$(dirname "$TARGET_ROOT")"
  if { [ -d "$TARGET_ROOT" ] && [ -w "$TARGET_ROOT" ]; } || { [ ! -d "$TARGET_ROOT" ] && [ -w "$target_parent" ]; }; then
    NEEDS_SUDO=0
  else
    NEEDS_SUDO=1
    log "${TARGET_ROOT} needs administrator permission; sudo may ask for your password."
    sudo -v
  fi

  quit_existing_app
  install_app "$TARGET_ROOT" "$TARGET_APP"

  log "Installed: ${TARGET_APP}"
  if [ "${TRANSCRIPTOR_SKIP_OPEN:-0}" = "1" ]; then
    log "Open skipped because TRANSCRIPTOR_SKIP_OPEN=1"
  else
    log "Opening ${PRODUCT_NAME}"
    open "$TARGET_APP"
    log "If macOS asks, grant Microphone, Accessibility, and Automation permissions."
  fi
}

# Run when executed; when sourced (desktop/packaging.test.js drives single
# functions) define the functions only.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
