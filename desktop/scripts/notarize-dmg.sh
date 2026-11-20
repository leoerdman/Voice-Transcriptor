#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

die() {
  echo "[notarize-dmg] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

signature_info() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 || return 1
}

require_developer_id_signature() {
  local path="$1"
  local label="$2"
  local info
  info="$(signature_info "$path")" || die "$label is not code-signed: $path"
  if ! grep -q '^Authority=Developer ID Application:' <<<"$info"; then
    die "$label must be signed with a Developer ID Application identity before notarization: $path"
  fi
  echo "$info"
}

require_hardened_runtime() {
  local path="$1"
  local info="$2"
  if ! grep -q 'flags=.*runtime' <<<"$info"; then
    die "App bundle is missing hardened runtime; rebuild with the Developer ID signing pipeline: $path"
  fi
}

require_cmd node
require_cmd xcrun
require_cmd spctl
require_cmd codesign

APP_VERSION="$(node -p "require('./package.json').version")"
APP_PATH="${TRANSCRIPTOR_APP_PATH:-$DESKTOP_DIR/dist/mac-arm64/Transcriptor.app}"
DMG_PATH="${TRANSCRIPTOR_DMG_PATH:-$DESKTOP_DIR/dist/Transcriptor-${APP_VERSION}-arm64.dmg}"
WAIT_TIMEOUT="${TRANSCRIPTOR_NOTARY_WAIT_TIMEOUT:-45m}"

[ -d "$APP_PATH" ] || die "App bundle not found: $APP_PATH"
[ -f "$DMG_PATH" ] || die "DMG artifact not found: $DMG_PATH"

APP_SIGNATURE="$(require_developer_id_signature "$APP_PATH" "App bundle")"
require_hardened_runtime "$APP_PATH" "$APP_SIGNATURE"
require_developer_id_signature "$DMG_PATH" "DMG artifact" >/dev/null

auth_args=()
if [ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]; then
  auth_args+=(--keychain-profile "$NOTARYTOOL_KEYCHAIN_PROFILE")
  [ -z "${NOTARYTOOL_KEYCHAIN:-}" ] || auth_args+=(--keychain "$NOTARYTOOL_KEYCHAIN")
elif [ -n "${NOTARYTOOL_KEY:-}${NOTARYTOOL_KEY_ID:-}${NOTARYTOOL_ISSUER:-}" ]; then
  [ -n "${NOTARYTOOL_KEY:-}" ] || die "Missing NOTARYTOOL_KEY for App Store Connect API key notarization"
  [ -n "${NOTARYTOOL_KEY_ID:-}" ] || die "Missing NOTARYTOOL_KEY_ID for App Store Connect API key notarization"
  auth_args+=(--key "$NOTARYTOOL_KEY" --key-id "$NOTARYTOOL_KEY_ID")
  [ -z "${NOTARYTOOL_ISSUER:-}" ] || auth_args+=(--issuer "$NOTARYTOOL_ISSUER")
else
  # No Apple ID + password branch (DX-21): `--password` puts the secret on
  # the command line, readable in `ps` for the whole --wait.
  die "Set NOTARYTOOL_KEYCHAIN_PROFILE (Apple ID credentials stored once with \`xcrun notarytool store-credentials\`), or NOTARYTOOL_KEY + NOTARYTOOL_KEY_ID."
fi

echo "[notarize-dmg] Submitting $DMG_PATH"
SUBMIT_RESULT="$(xcrun notarytool submit "$DMG_PATH" "${auth_args[@]}" --wait --timeout "$WAIT_TIMEOUT" --output-format json)"
echo "$SUBMIT_RESULT"
SUBMIT_STATUS="$(printf '%s' "$SUBMIT_RESULT" | node -e 'const fs = require("fs"); const input = fs.readFileSync(0, "utf8"); try { process.stdout.write(JSON.parse(input).status || ""); } catch { process.exit(2); }')"
SUBMIT_ID="$(printf '%s' "$SUBMIT_RESULT" | node -e 'const fs = require("fs"); const input = fs.readFileSync(0, "utf8"); try { process.stdout.write(JSON.parse(input).id || ""); } catch { process.exit(2); }')"
if [ "$SUBMIT_STATUS" != "Accepted" ]; then
  if [ -n "$SUBMIT_ID" ]; then
    LOG_PATH="${DMG_PATH}.notary-log.json"
    echo "[notarize-dmg] Fetching rejection log to $LOG_PATH" >&2
    # `| tee ... || true` under `set -euo pipefail` swallowed the whole
    # pipeline, so a failure to FETCH the log looked identical to a log with
    # nothing in it: the script then said "Notarization did not succeed:
    # Invalid" with no reason and no hint that the reason was unavailable.
    # Say which of the two happened.
    if xcrun notarytool log "$SUBMIT_ID" "${auth_args[@]}" --output-format json \
        > "$LOG_PATH" 2> "${LOG_PATH}.err"; then
      cat "$LOG_PATH" >&2
      rm -f "${LOG_PATH}.err"
    else
      echo "[notarize-dmg] Could not fetch the notarization log for submission $SUBMIT_ID:" >&2
      cat "${LOG_PATH}.err" >&2 || true
      echo "[notarize-dmg] Retry by hand: xcrun notarytool log $SUBMIT_ID <auth args>" >&2
    fi
  fi
  die "Notarization did not succeed: ${SUBMIT_STATUS:-unknown}"
fi

echo "[notarize-dmg] Stapling ticket"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "[notarize-dmg] Gatekeeper validation"
spctl -a -vv -t open --context context:primary-signature "$DMG_PATH"

echo "[notarize-dmg] Notarized and stapled: $DMG_PATH"
