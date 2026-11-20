#!/bin/bash
# ============================================================================
#  Transcriptor - one-click macOS release build
#
#  Rebuilds the frontend, prepares the bundled runtime, packages the
#  Electron app, and installs the freshly built macOS app bundle.
#  Release artifacts are still written under desktop/dist/.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/desktop/dist"
cd "$SCRIPT_DIR"

cleanup_path() {
  local target="$1"
  if [ -e "$target" ]; then
    chmod -R u+w "$target" 2>/dev/null || true
    rm -rf "$target"
  fi
}

cleanup_release_output() {
  cleanup_path "$DIST_DIR"
}

cleanup_stale_install_backups() {
  local target_root="$1"
  local backup
  [ -d "$target_root" ] || return 0
  [ -w "$target_root" ] || return 0
  for backup in "$target_root"/Transcriptor.app.backup-*; do
    [ -e "$backup" ] || continue
    cleanup_path "$backup"
  done
}

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    BUILDER_ARCH="arm64"
    ;;
  x86_64)
    echo "macOS release builds are arm64-only in this release line." >&2
    echo "Intel Macs are unsupported because the bundled runtime graph is arm64-only." >&2
    exit 1
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

cleanup_release_output
cleanup_stale_install_backups "/Applications"
cleanup_stale_install_backups "$HOME/Applications"

# ---------------------------------------------------------------------------
#  Signing mode - stated, never guessed
# ---------------------------------------------------------------------------
#  The build hooks have no built-in signing identity any more: the name of
#  a specific developer's self-signed key used to be the DEFAULT in two
#  source files, so ./BUILD.command could not run on any other machine and
#  a "release" it produced was quietly self-signed, un-notarized, and
#  installable only by stripping the quarantine attribute.
#
#    TRANSCRIPTOR_SIGNING_IDENTITY="Developer ID Application: ..."  public release
#    TRANSCRIPTOR_SIGNING_IDENTITY="<keychain identity>"            internal build
#    TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1                                throwaway local build
#
#  Default when nothing is set: the internal identity below, which is what
#  this repository's own machine has. It is named here, once, instead of
#  being embedded in the signing code.
#
#  THE IDENTITY MUST STAY THE SAME ACROSS BUILDS.
#  macOS stores every permission the user grants — Accessibility,
#  Automation, Microphone — against the bundle id AND the code signing
#  requirement the app satisfied when the grant was made (TCC's `csreq`).
#  Rebuild under a different certificate, or ad-hoc, and the grant no
#  longer matches: System Settings goes on showing Transcriptor as
#  allowed while macOS refuses it for real — Apple Events come back
#  "Not authorized to send Apple events to System Events. (-1743)" and
#  auto-paste silently stops working, with nothing on screen to explain
#  it. The user's only remedy is `tccutil reset <service> <bundle id>`
#  and a fresh prompt, which is what the app's own "Repair permissions"
#  action does (desktop/paste-capability.js).
#  The install below therefore refuses any bundle whose designated
#  requirement is not `identifier "<bundle id>" and certificate …` — an
#  ad-hoc build, whose requirement is a cdhash of that one build, can be
#  run but never installed over the copy the user has granted.
INTERNAL_SIGNING_IDENTITY="AntigravityTelegramDev"
if [ "${TRANSCRIPTOR_ALLOW_ADHOC_SIGN:-}" != "1" ]; then
  export TRANSCRIPTOR_SIGNING_IDENTITY="${TRANSCRIPTOR_SIGNING_IDENTITY:-$INTERNAL_SIGNING_IDENTITY}"
  case "$TRANSCRIPTOR_SIGNING_IDENTITY" in
    "Developer ID Application: "*)
      echo "Signing identity: $TRANSCRIPTOR_SIGNING_IDENTITY (public release)"
      echo "Remember to notarize before distributing: npm --prefix desktop run notarize:dmg"
      ;;
    *)
      echo "Signing identity: $TRANSCRIPTOR_SIGNING_IDENTITY (internal build)"
      echo "WARNING: this artifact is NOT notarized. Gatekeeper will refuse it on"
      echo "         another Mac unless the installer strips the quarantine attribute."
      echo "         For a public release set TRANSCRIPTOR_SIGNING_IDENTITY to a"
      echo '         "Developer ID Application: ..." certificate and run notarize:dmg.'
      ;;
  esac
fi

npm --prefix frontend ci
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix desktop ci

cd "$SCRIPT_DIR/desktop"
npm run dist -- "$@"

APP_DIR="$DIST_DIR/mac-${BUILDER_ARCH}/Transcriptor.app"
if [ ! -d "$APP_DIR" ]; then
  echo "Built app bundle not found: $APP_DIR" >&2
  exit 1
fi
APP_VERSION="$(node -p "require('./package.json').version")"
APP_ID="$(node -p "require('./package.json').build.appId")"
APP_ARTIFACT_PREFIX="Transcriptor-${APP_VERSION}-${BUILDER_ARCH}"
DMG_PATH="$DIST_DIR/${APP_ARTIFACT_PREFIX}.dmg"
INTERNAL_ZIP="$DIST_DIR/${APP_ARTIFACT_PREFIX}-internal.zip"
RELEASE_DIR="$DIST_DIR/release"
RELEASE_MANIFEST_NAME="TRANSCRIPTOR_RELEASE_MANIFEST.txt"
INSTALL_KIT_NAME="${APP_ARTIFACT_PREFIX}-macos-install"
INSTALL_KIT_DIR="$RELEASE_DIR/$INSTALL_KIT_NAME"
INSTALL_KIT_ZIP="$RELEASE_DIR/${INSTALL_KIT_NAME}.zip"

create_internal_zip() {
  local zip_path="$1"
  cleanup_path "$zip_path"
  (
    cd "$(dirname "$APP_DIR")"
    ditto -c -k --sequesterRsrc --keepParent "$(basename "$APP_DIR")" "$zip_path"
  )
  echo "Created $zip_path"
}

create_internal_zip "$INTERNAL_ZIP"

write_release_manifest() {
  local out="$1"
  cat > "$out" <<EOF
product=Transcriptor
version=$APP_VERSION
arch=$BUILDER_ARCH
app_id=$APP_ID
dmg=$(basename "$DMG_PATH")
internal_zip=$(basename "$INTERNAL_ZIP")
install_zip=$(basename "$INSTALL_KIT_ZIP")
EOF
}

create_release_package() {
  local dmg_base
  local internal_zip_base
  local install_zip_base

  [ -f "$DMG_PATH" ] || {
    echo "Built DMG not found: $DMG_PATH" >&2
    exit 1
  }
  [ -f "$INTERNAL_ZIP" ] || {
    echo "Internal ZIP not found: $INTERNAL_ZIP" >&2
    exit 1
  }
  # Single definition of where the install guide lives. It moved to
  # docs/ during the repo-root cleanup while this script still had the
  # old root path in six places, which broke release packaging. Resolve
  # it once and accept either location so an older checkout still packs.
  INSTALL_DOC="$SCRIPT_DIR/docs/INSTALL_OTHER_MAC.md"
  [ -f "$INSTALL_DOC" ] || INSTALL_DOC="$SCRIPT_DIR/INSTALL_OTHER_MAC.md"

  [ -f "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" ] || {
    echo "Installer script not found: $SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" >&2
    exit 1
  }
  [ -f "$INSTALL_DOC" ] || {
    echo "Install docs not found: $INSTALL_DOC" >&2
    exit 1
  }
  command -v zip >/dev/null 2>&1 || {
    echo "Missing required command: zip" >&2
    exit 1
  }
  command -v shasum >/dev/null 2>&1 || {
    echo "Missing required command: shasum" >&2
    exit 1
  }

  cleanup_path "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  write_release_manifest "$RELEASE_DIR/$RELEASE_MANIFEST_NAME"

  cp "$DMG_PATH" "$RELEASE_DIR/"
  cp "$INTERNAL_ZIP" "$RELEASE_DIR/"
  cp "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" "$RELEASE_DIR/"
  cp "$INSTALL_DOC" "$RELEASE_DIR/"
  chmod +x "$RELEASE_DIR/INSTALL_ON_OTHER_MAC.command"

  cleanup_path "$INSTALL_KIT_DIR"
  mkdir -p "$INSTALL_KIT_DIR"
  cp "$DMG_PATH" "$INSTALL_KIT_DIR/"
  cp "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" "$INSTALL_KIT_DIR/"
  cp "$INSTALL_DOC" "$INSTALL_KIT_DIR/"
  cp "$RELEASE_DIR/$RELEASE_MANIFEST_NAME" "$INSTALL_KIT_DIR/"
  chmod +x "$INSTALL_KIT_DIR/INSTALL_ON_OTHER_MAC.command"

  cleanup_path "$INSTALL_KIT_ZIP"
  (
    cd "$RELEASE_DIR"
    zip -qry -X "$(basename "$INSTALL_KIT_ZIP")" "$(basename "$INSTALL_KIT_DIR")"
  )
  cleanup_path "$INSTALL_KIT_DIR"

  dmg_base="$(basename "$DMG_PATH")"
  internal_zip_base="$(basename "$INTERNAL_ZIP")"
  install_zip_base="$(basename "$INSTALL_KIT_ZIP")"
  (
    cd "$RELEASE_DIR"
    shasum -a 256 \
      "$dmg_base" \
      "$internal_zip_base" \
      "$install_zip_base" \
      "INSTALL_ON_OTHER_MAC.command" \
      "$(basename "$INSTALL_DOC")" \
      "$RELEASE_MANIFEST_NAME" \
      > SHA256SUMS.txt
  )
  # Drop the dist/ copy of the internal zip: release/ already has one.
  #
  # NOTE, measured: release/ still holds three full copies of this
  # version - the DMG, the internal zip (the installer's fallback when a
  # quarantined DMG will not mount) and the install kit zip, which
  # embeds the DMG again. About 750 MB, not the ~470 MB an earlier
  # comment here claimed on the strength of the kit embedding the
  # internal zip - it never did; the kit is built from the DMG, the
  # installer, the doc and the manifest. Which artifacts a release ships
  # is a product decision, so it is left as it is and recorded in the
  # debt ledger rather than changed here.
  cleanup_path "$INTERNAL_ZIP"
  echo "Created release package in $RELEASE_DIR"
}

create_release_package

# ---------------------------------------------------------------------------
#  Never replace a bundle under a running process
# ---------------------------------------------------------------------------
#  Installing over /Applications/Transcriptor.app while that app is
#  running swaps the bundle out from under a live process. From that
#  moment macOS stops validating the process's code identity and refuses
#  every Apple Event it sends with -1743, so auto-paste dies for the rest
#  of that session while System Settings still shows the Automation grant
#  as ON. Observed on 2026-09-05: the bundle was re-signed at 17:56 local,
#  the still-running 1.6.1 process pasted fine at 17:58 and failed every
#  paste from 17:59 on; the very next launch of the very same bundle
#  worked. So: quit first, install, and put it back the way it was.
#
#  RELAUNCHING: `open -a` and nothing else. `open` hands the launch to
#  LaunchServices, so the app is its own responsible process and TCC
#  matches its own bundle id. A binary started straight from this shell
#  (…/Contents/MacOS/Transcriptor &) would inherit THIS terminal as its
#  responsible process, and every permission prompt and grant would be
#  attributed to the terminal instead of to Transcriptor. Evidence that
#  `open -a` is correct here: the 11:00:51Z boot in main.log, launched
#  that way from an agent shell, probed System Events successfully on the
#  first try (`[paste-capability] state=active cause=boot`).
APP_WAS_RUNNING=0

quit_running_app() {
  local target_app="$1"
  local waited=0
  pgrep -f "$target_app/Contents/MacOS/" >/dev/null 2>&1 || return 0
  APP_WAS_RUNNING=1
  echo "Quitting the running Transcriptor before replacing its bundle…"
  osascript -e 'tell application "Transcriptor" to quit' >/dev/null 2>&1 || true
  while [ "$waited" -lt 20 ]; do
    pgrep -f "$target_app/Contents/MacOS/" >/dev/null 2>&1 || return 0
    sleep 1
    waited=$((waited + 1))
  done
  echo "Transcriptor is still running after 20s; quit it and re-run ./BUILD.command." >&2
  exit 1
}

relaunch_app_if_it_was_running() {
  local target_app="$1"
  [ "$APP_WAS_RUNNING" = "1" ] || return 0
  echo "Reopening $target_app"
  open -a "$target_app"
}

install_app_bundle() {
  local target_app="$1"
  local target_root
  local target_name
  local tmp_app
  local backup_app
  target_root="$(dirname "$target_app")"
  target_name="$(basename "$target_app")"
  tmp_app="$target_root/.${target_name}.installing.$$"
  backup_app="$target_app.backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cleanup_tmp_app() {
    cleanup_path "$tmp_app"
  }
  cleanup_backup_app() {
    cleanup_path "$backup_app"
  }
  mkdir -p "$target_root"
  cleanup_tmp_app
  if ! ditto "$APP_DIR" "$tmp_app"; then
    cleanup_tmp_app
    return 1
  fi
  if ! codesign --verify --deep --strict "$tmp_app"; then
    cleanup_tmp_app
    return 1
  fi
  # `codesign --verify` accepts an ad-hoc signature, so it cannot answer
  # the question that matters for an INSTALL: will the permissions this
  # user has already granted still apply to the bundle we are about to
  # put in their /Applications? See the header, and
  # desktop/scripts/check-designated-requirement.js.
  if ! node "$SCRIPT_DIR/desktop/scripts/check-designated-requirement.js" "$tmp_app"; then
    cleanup_tmp_app
    return 1
  fi
  quit_running_app "$target_app"
  if [ -e "$target_app" ]; then
    mv "$target_app" "$backup_app"
  fi
  if ! mv "$tmp_app" "$target_app"; then
    if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then
      mv "$backup_app" "$target_app"
    fi
    cleanup_tmp_app
    return 1
  fi
  cleanup_backup_app
  echo "Installed $target_app"
}

bundle_identifier() {
  local app_path="$1"
  plutil -extract CFBundleIdentifier raw -o - "$app_path/Contents/Info.plist" 2>/dev/null || true
}

retire_duplicate_app_bundle() {
  local duplicate_app="$1"
  local canonical_app="$2"
  local duplicate_id
  local canonical_id
  [ -d "$duplicate_app" ] || return 0
  [ "$duplicate_app" != "$canonical_app" ] || return 0
  duplicate_id="$(bundle_identifier "$duplicate_app")"
  canonical_id="$(bundle_identifier "$canonical_app")"
  if [ -n "$duplicate_id" ] && [ "$duplicate_id" = "$canonical_id" ]; then
    # The duplicate may be the copy that is running: deleting a bundle under
    # a live process is the hazard quit_running_app exists for.
    quit_running_app "$duplicate_app"
    cleanup_path "$duplicate_app"
    echo "Removed duplicate $duplicate_app (same bundle id as $canonical_app)"
    return 0
  fi
  echo "Keeping $duplicate_app because its bundle id differs from $canonical_app" >&2
}

INSTALL_ROOT="${TRANSCRIPTOR_INSTALL_DIR:-/Applications}"
if [ ! -d "$INSTALL_ROOT" ] || [ ! -w "$INSTALL_ROOT" ]; then
  if [ -n "${TRANSCRIPTOR_INSTALL_DIR:-}" ]; then
    echo "Install directory is not writable: $INSTALL_ROOT" >&2
    exit 1
  fi
  if [ -d "/Applications/Transcriptor.app" ]; then
    echo "Existing /Applications/Transcriptor.app cannot be updated without write access." >&2
    echo "Set TRANSCRIPTOR_INSTALL_DIR explicitly or rerun with permissions." >&2
    exit 1
  fi
  INSTALL_ROOT="$HOME/Applications"
fi
PRIMARY_APP="$INSTALL_ROOT/Transcriptor.app"
install_app_bundle "$PRIMARY_APP"

LEGACY_USER_APP="$HOME/Applications/Transcriptor.app"
if [ -d "$LEGACY_USER_APP" ] && [ "$LEGACY_USER_APP" != "$PRIMARY_APP" ]; then
  retire_duplicate_app_bundle "$LEGACY_USER_APP" "$PRIMARY_APP"
fi

relaunch_app_if_it_was_running "$PRIMARY_APP"
