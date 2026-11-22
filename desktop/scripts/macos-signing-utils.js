const { execFileSync, execSync } = require("node:child_process");
const {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} = require("node:fs");
const path = require("node:path");

const PYTHON_IMPORT_TREES = Object.freeze([
  path.join("Contents", "Resources", "runtime", "python"),
  path.join("Contents", "Resources", "backend"),
]);

function walkTree(root, visitor) {
  const visit = (entryPath) => {
    let st;
    try { st = lstatSync(entryPath); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(entryPath); } catch { return; }
      for (const name of entries) visit(path.join(entryPath, name));
      visitor(entryPath, st);
      return;
    }
    if (st.isFile()) visitor(entryPath, st);
  };
  visit(root);
}

function pathIsInside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function classifyMacho(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch { return "non-macho"; }
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n < 16) return "non-macho";
    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
      const filetype = buf.readUInt32LE(12);
      if (filetype === 2) return "executable";
      if (filetype === 6 || filetype === 8) return "dylib";
      return "macho-other";
    }
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
      const fatHdr = Buffer.alloc(24);
      if (readSync(fd, fatHdr, 0, 24, 0) < 24) return "macho-other";
      const firstOff = magicBE === 0xcafebabf
        ? Number(fatHdr.readBigUInt64BE(16))
        : fatHdr.readUInt32BE(16);
      if (!Number.isSafeInteger(firstOff) || firstOff <= 0) return "macho-other";
      const thinHdr = Buffer.alloc(16);
      if (readSync(fd, thinHdr, 0, 16, firstOff) < 16) return "macho-other";
      const thinMagic = thinHdr.readUInt32LE(0);
      if (thinMagic !== 0xfeedfacf && thinMagic !== 0xfeedface) return "macho-other";
      const filetype = thinHdr.readUInt32LE(12);
      if (filetype === 2) return "executable";
      if (filetype === 6 || filetype === 8) return "dylib";
      return "macho-other";
    }
    return "non-macho";
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot) {
  if (filePath === appPath) return false;
  if (pathIsInside(filePath, runtimeRoot)) return true;
  if (filePath.endsWith(".app") || filePath.endsWith(".framework")) return false;
  let st;
  try { st = lstatSync(filePath); } catch { return true; }
  if (!st.isFile()) return false;
  const kind = classifyMacho(filePath);
  return kind === "non-macho" || kind === "macho-other";
}

// The native helpers, as they sit in a mac bundle: build-native.sh writes
// `screen-input` (screen mode's mouse tap) and `dictation-helper` (paste,
// clipboard and record hotkeys) into native/build/mac-<arch>,
// package.json build.mac.extraResources copies that directory to
// runtime/bin, and main.js screenModeHelperPath() / dictationHelperPath()
// run them from there. packaging.test.js holds those statements together.
const SCREEN_INPUT_HELPER_IN_BUNDLE = path.join("Contents", "Resources", "runtime", "bin", "screen-input");
const DICTATION_HELPER_IN_BUNDLE = path.join("Contents", "Resources", "runtime", "bin", "dictation-helper");
const NATIVE_HELPERS_IN_BUNDLE = Object.freeze([SCREEN_INPUT_HELPER_IN_BUNDLE, DICTATION_HELPER_IN_BUNDLE]);

/**
 * A Developer-ID/internal mac build must carry both helpers (without
 * screen-input the screen hotkey is silently not offered; without
 * dictation-helper every paste falls back to AppleScript); an App Store
 * build must carry neither (an active CGEventTap and CGEventPost into
 * other apps cannot run in the App Sandbox). Throws when the bundle says
 * otherwise; returns the helpers' paths when they are expected and there.
 */
function assertNativeHelpers(appPath, { expected }) {
  const found = [];
  for (const rel of NATIVE_HELPERS_IN_BUNDLE) {
    const helper = path.join(appPath, rel);
    const name = path.basename(rel);
    const kind = classifyMacho(helper);
    if (expected && kind !== "executable") {
      throw new Error(
        `the native helper ${name} is missing from the bundle (${helper}: ${kind}). ` +
          "Run `bash desktop/scripts/build-native.sh mac-arm64` before electron-builder — every mac dist script does.",
      );
    }
    if (!expected && existsSync(helper)) {
      throw new Error(
        `the native helper ${name} must not ship in this build (${helper}): its event tap and event posting cannot run in the App Sandbox.`,
      );
    }
    if (expected) found.push(helper);
  }
  return found;
}

function assertNoBundledBytecode(appPath) {
  const offenders = [];
  for (const relRoot of PYTHON_IMPORT_TREES) {
    const root = path.join(appPath, relRoot);
    if (!existsSync(root)) continue;
    walkTree(root, (entryPath, st) => {
      if (
        (st.isDirectory() && path.basename(entryPath) === "__pycache__") ||
        (st.isFile() && entryPath.endsWith(".pyc"))
      ) {
        offenders.push(entryPath);
      }
    });
  }
  if (offenders.length > 0) {
    throw new Error(
      "bundled Python bytecode is forbidden inside the signed app. " +
        `First offenders:\n${offenders.slice(0, 20).join("\n")}`,
    );
  }
}

function makeBundledPythonImportsReadOnly(appPath) {
  let fileCount = 0;
  let dirCount = 0;
  for (const relRoot of PYTHON_IMPORT_TREES) {
    const root = path.join(appPath, relRoot);
    if (!existsSync(root)) continue;
    walkTree(root, (entryPath, st) => {
      const executable = (st.mode & 0o111) !== 0;
      const mode = st.isDirectory() ? 0o555 : (executable ? 0o555 : 0o444);
      chmodSync(entryPath, mode);
      if (st.isDirectory()) dirCount += 1;
      if (st.isFile()) fileCount += 1;
    });
  }
  return { fileCount, dirCount };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── One signing decision, in one place ────────────────────────────────
//
// "Which identity, is it a Developer ID, and therefore which timestamp
// policy and which entitlements profile" was derived independently in
// afterPack.js and afterAllArtifactBuild.js, each with its own hardcoded
// default identity name. Two copies of one decision is how a release
// ends up half self-signed. Both hooks now call resolveSigningPlan.
//
// There is deliberately NO built-in default identity: a build must say
// what it is signing with. BUILD.command names the internal identity for
// internal builds; a public release sets TRANSCRIPTOR_SIGNING_IDENTITY to
// a "Developer ID Application: …" certificate.

/** True for a real Apple Developer ID Application certificate name. */
function isDeveloperIdIdentity(identity) {
  return /^Developer ID Application:/i.test(String(identity || "").trim());
}

/**
 * The whole signing decision, derived from the environment. Pure: no
 * keychain access, so it is testable without a Mac keychain. The caller
 * is responsible for checking the identity actually exists
 * (`hasSigningIdentity`), because that is the part that needs a keychain.
 *
 * @returns {{identity: string, requestedIdentity: string, adhoc: boolean,
 *            developerId: boolean, timestampArg: string,
 *            entitlementsProfile: "developer-id"|"self-signed"}}
 */
function resolveSigningPlan(env = process.env) {
  const requestedIdentity = String(env.TRANSCRIPTOR_SIGNING_IDENTITY || "").trim();
  const adhoc = env.TRANSCRIPTOR_ALLOW_ADHOC_SIGN === "1";
  if (!adhoc && !requestedIdentity) {
    throw new Error(
      "macOS signing: set TRANSCRIPTOR_SIGNING_IDENTITY to the certificate to sign with " +
        '("Developer ID Application: …" for a public release), or set ' +
        "TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 for a throwaway local build. " +
        "There is no built-in default identity: a build must say what signed it.",
    );
  }
  const developerId = !adhoc && isDeveloperIdIdentity(requestedIdentity);
  return {
    identity: adhoc ? "-" : requestedIdentity,
    requestedIdentity,
    adhoc,
    developerId,
    // Notarization requires secure timestamps. Internal/self-signed and
    // ad-hoc builds are not Gatekeeper-trusted artifacts and must not
    // fail on an Apple timestamp-service outage.
    timestampArg: developerId ? "--timestamp" : "--timestamp=none",
    // Only a self-signed certificate (empty Team ID) needs the library
    // validation relaxations — see entitlements.mac.selfsigned.plist.
    entitlementsProfile: developerId ? "developer-id" : "self-signed",
  };
}

// ── Why the identity may not drift between builds ──────────────────────
//
// macOS stores every permission the user grants — Accessibility,
// Automation, Microphone — against the bundle id AND the code signing
// requirement the app satisfied when the grant was made. A build signed
// with a different certificate, or ad-hoc, does not satisfy the old
// requirement: the row stays visible and switched ON in System Settings
// while macOS refuses the app for real (Apple Events come back
// errAEEventNotPermitted, -1743). The user cannot see the difference and
// the app cannot repair it without dropping the grant.
//
// An ad-hoc signature is the worst case, because it has no certificate
// at all: its designated requirement is a bare cdhash of THIS build, so
// every rebuild is a new identity and every grant dies with the build
// that earned it. That is why an ad-hoc bundle must never be installed
// over a real one — see the install guard in BUILD.command.

/** The designated requirement a grant can survive a rebuild under. */
function stableDesignatedRequirementPattern(bundleId) {
  const id = String(bundleId || "").trim();
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`identifier\\s+(?:"${escaped}"|${escaped})\\s+and\\s+certificate\\b`, "i");
}

/**
 * Does this bundle's designated requirement bind its grants to a name
 * that survives a rebuild?
 *
 * @param {string} requirementText  output of `codesign -d --requirements -`
 * @param {string} bundleId
 * @returns {{ok: boolean, reason: string}}
 */
function designatedRequirementIsStable(requirementText, bundleId) {
  const text = String(requirementText || "");
  const id = String(bundleId || "").trim();
  if (!id) return { ok: false, reason: "no bundle id to check the requirement against" };
  const line = text.split(/\r?\n/).find((l) => /designated\s*=>/.test(l)) || "";
  if (!line) {
    return { ok: false, reason: "no designated requirement in the codesign output" };
  }
  if (stableDesignatedRequirementPattern(id).test(line)) return { ok: true, reason: "" };
  if (/cdhash/i.test(line)) {
    return {
      ok: false,
      reason:
        "the bundle is signed ad-hoc: its designated requirement is a cdhash of this " +
        "exact build, so every macOS permission the user grants dies with it " +
        `(${line.trim()})`,
    };
  }
  return {
    ok: false,
    reason:
      `the designated requirement does not bind identifier "${id}" to a certificate, ` +
      `so permissions granted to it will not survive a rebuild (${line.trim()})`,
  };
}

/**
 * The self-signed variant of an entitlements filename declared in
 * package.json: `entitlements.mac.plist` ->
 * `entitlements.mac.selfsigned.plist`, `entitlements.mac.inherit.plist`
 * -> `entitlements.mac.selfsigned.inherit.plist`.
 *
 * One derivation rule rather than a second list of filenames, so adding
 * a profile cannot leave the two lists disagreeing.
 */
function selfSignedEntitlementsPath(declaredPath) {
  const name = String(declaredPath || "");
  if (!/^entitlements\.mac\./.test(name)) {
    throw new Error(
      `macOS signing: cannot derive a self-signed entitlements profile from "${name}" — ` +
        'expected a name beginning "entitlements.mac.".',
    );
  }
  return name.replace(/^entitlements\.mac\./, "entitlements.mac.selfsigned.");
}

/**
 * The exact `codesign` argument list for ONE bundled Mach-O file.
 *
 * Every Mach-O inside the app — executables, dylibs and Python extension
 * bundles alike — must carry the SAME identity, the hardened runtime and
 * the same entitlements, or notarization rejects the package file by
 * file ("not signed with a valid Developer ID certificate" / "does not
 * have the hardened runtime enabled"). This used to sign executables
 * with the requested identity and everything else — every `.so` in
 * site-packages, `libpython` itself — ad-hoc with "-", and added
 * `--options runtime` only to the executables. Locally that is invisible:
 * `codesign --verify --deep --strict` accepts ad-hoc signatures, so the
 * build looked clean and only notarization would have found it.
 */
function runtimeSignArgs({ filePath, identity, entitlements, timestampArg = "--timestamp" }) {
  if (!filePath) throw new Error("runtimeSignArgs: filePath is required");
  if (!identity) throw new Error("runtimeSignArgs: identity is required");
  if (!entitlements) throw new Error("runtimeSignArgs: entitlements is required");
  const args = ["--force", "--sign", identity, "--options", "runtime", "--entitlements", entitlements];
  // An ad-hoc signature has no certificate to timestamp against.
  if (identity !== "-") args.push(timestampArg);
  args.push(filePath);
  return args;
}

/**
 * Names of the codesigning identities the keychain currently offers.
 * `security find-identity` prints them as `  1) <sha1> "<name>"`.
 *
 * A failure of `security` itself (locked keychain, missing binary) is
 * NOT "the identity is absent": reporting it as such told a user who had
 * set TRANSCRIPTOR_SIGNING_IDENTITY correctly to go and set it. It is
 * raised so the real cause reaches the build log.
 */
function listSigningIdentities() {
  let out;
  try {
    out = execSync("/usr/bin/security find-identity -v -p codesigning", { encoding: "utf8" });
  } catch (e) {
    const stderr = e && e.stderr ? e.stderr.toString().trim() : "";
    throw new Error(
      "macOS signing: could not read the keychain's codesigning identities " +
        "(`security find-identity -v -p codesigning` failed — a locked keychain is the usual cause). " +
        `${stderr || (e && e.message) || e}`,
    );
  }
  return [...String(out).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Whether the keychain holds an identity with exactly this name.
 * Exact, not substring: "Developer ID Application: Acme" must not be
 * satisfied by "Developer ID Application: Acme Holdings".
 */
function hasSigningIdentity(identity) {
  const wanted = String(identity || "").trim();
  if (!wanted) return false;
  return listSigningIdentities().includes(wanted);
}

function hasCertificateIdentity(identity) {
  const wanted = String(identity || "").trim();
  if (!wanted) return false;
  try {
    const out = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-c", wanted, "-Z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes(`"alis"<blob>="${wanted}"`) || out.includes(`"labl"<blob>="${wanted}"`);
  } catch {
    return false;
  }
}

function runPlistBuddy(plistPath, command, { optional = false } = {}) {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"],
    }).trim();
  } catch (e) {
    if (optional) return "";
    const stderr = e && e.stderr ? e.stderr.toString() : "";
    throw new Error(`PlistBuddy failed for ${plistPath}: ${command}\n${stderr || (e.message || e)}`);
  }
}

function hardenAppTransportSecurity(appPath, { log = console.log } = {}) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlist)) {
    throw new Error(`Info.plist not found: ${infoPlist}`);
  }

  // Electron injects a broad NSAllowsArbitraryLoads=true default for
  // compatibility. Transcriptor only needs insecure HTTP for its local
  // loopback backend; App Store and production builds should keep ATS
  // tight for all external traffic.
  runPlistBuddy(infoPlist, "Delete :NSAppTransportSecurity", { optional: true });
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity dict");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSExceptionDomains dict");

  for (const host of ["127.0.0.1", "localhost"]) {
    const base = `:NSAppTransportSecurity:NSExceptionDomains:${host}`;
    runPlistBuddy(infoPlist, `Add ${base} dict`);
    runPlistBuddy(infoPlist, `Add ${base}:NSIncludesSubdomains bool false`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionAllowsInsecureHTTPLoads bool true`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionAllowsInsecureHTTPSLoads bool false`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionMinimumTLSVersion string 1.2`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionRequiresForwardSecrecy bool true`);
  }

  const arbitraryLoads = runPlistBuddy(
    infoPlist,
    "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads",
  );
  const localNetworking = runPlistBuddy(
    infoPlist,
    "Print :NSAppTransportSecurity:NSAllowsLocalNetworking",
  );
  if (arbitraryLoads !== "false" || localNetworking !== "true") {
    throw new Error(
      `ATS hardening verification failed for ${infoPlist}: ` +
        `NSAllowsArbitraryLoads=${arbitraryLoads}, NSAllowsLocalNetworking=${localNetworking}`,
    );
  }
  log(`[macos-signing] Hardened App Transport Security in ${infoPlist}`);
}

function plistSetString(plistPath, key, value) {
  runPlistBuddy(plistPath, `Delete :${key}`, { optional: true });
  runPlistBuddy(plistPath, `Add :${key} string ${value}`);
}

/** Info.plist keys whose text is declared by build.<platform>.extendInfo. */
const REQUIRED_USAGE_DESCRIPTION_KEYS = Object.freeze([
  "NSMicrophoneUsageDescription",
  "NSAppleEventsUsageDescription",
]);

/**
 * @param {object} extendInfo `build.mac.extendInfo` / `build.mas.extendInfo`
 *   from desktop/package.json — the SSOT for these strings. They used to
 *   be retyped here as JS literals, which silently overwrote whatever
 *   electron-builder had already written from extendInfo: editing the
 *   obvious place (package.json) changed nothing in the shipped bundle,
 *   and the first localisation or App Review rewording would have looked
 *   like "the change did not apply".
 */
function normalizeMacPrivacyUsageDescriptions(appPath, { extendInfo, log = console.log } = {}) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlist)) {
    throw new Error(`Info.plist not found: ${infoPlist}`);
  }

  const declared = extendInfo && typeof extendInfo === "object" ? extendInfo : {};
  for (const key of REQUIRED_USAGE_DESCRIPTION_KEYS) {
    const value = String(declared[key] || "").trim();
    if (!value) {
      throw new Error(
        `build.<platform>.extendInfo.${key} is required in desktop/package.json — ` +
          "it is the source of the string macOS shows in the permission prompt.",
      );
    }
    plistSetString(infoPlist, key, value);
  }
  // Electron's audio-capture prompt reuses the microphone wording; it is
  // the same permission being explained, so it is derived, not declared.
  plistSetString(infoPlist, "NSAudioCaptureUsageDescription", declared.NSMicrophoneUsageDescription);

  // Electron injects generic Camera/Bluetooth prompts by default, but
  // Transcriptor only captures microphone audio. Shipping unused usage
  // descriptions makes App Store privacy review noisier and implies
  // capabilities that are not part of the product contract.
  for (const key of [
    "NSCameraUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
  ]) {
    runPlistBuddy(infoPlist, `Delete :${key}`, { optional: true });
  }

  const camera = runPlistBuddy(infoPlist, "Print :NSCameraUsageDescription", { optional: true });
  const bluetoothAlways = runPlistBuddy(
    infoPlist,
    "Print :NSBluetoothAlwaysUsageDescription",
    { optional: true },
  );
  const bluetoothPeripheral = runPlistBuddy(
    infoPlist,
    "Print :NSBluetoothPeripheralUsageDescription",
    { optional: true },
  );
  if (camera || bluetoothAlways || bluetoothPeripheral) {
    throw new Error(`Privacy usage description normalization failed for ${infoPlist}`);
  }
  log(`[macos-signing] Normalized macOS privacy usage descriptions in ${infoPlist}`);
}

function preSignRuntimeBinaries({ appPath, identity, entitlements, timestampArg = "--timestamp", log = console.log }) {
  const runtimeRoot = path.join(appPath, "Contents", "Resources", "runtime");
  if (!existsSync(runtimeRoot)) {
    return { runtimeRoot, signedCount: 0, execCount: 0, dylibCount: 0 };
  }
  log(`[macos-signing] Pre-signing bundled runtime binaries under ${runtimeRoot}`);
  let signedCount = 0;
  let execCount = 0;
  let dylibCount = 0;
  const removeExistingSignature = (filePath) => {
    try {
      execFileSync("/usr/bin/codesign", ["--remove-signature", filePath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Unsigned Mach-O files are expected in third-party wheels.
    }
  };
  const removeBuildOnlyXattrs = (filePath) => {
    for (const attr of ["com.apple.provenance"]) {
      try {
        execFileSync("/usr/bin/xattr", ["-d", attr, filePath], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        // Missing xattrs are fine; the packaged source file is left untouched.
      }
    }
  };
  const signOne = (filePath, kind) => {
    // One identity, one options set, for every Mach-O — see runtimeSignArgs.
    const args = runtimeSignArgs({ filePath, identity, entitlements, timestampArg });
    if (kind === "executable") execCount += 1;
    else dylibCount += 1;
    // Every attempt's stderr is kept: codesign's first failure is often
    // the informative one (wrong entitlements, unreadable file) and the
    // later ones only say "resource busy". Keeping just the last one
    // threw away the diagnosis for a build that is now dead anyway.
    const failures = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      removeExistingSignature(filePath);
      removeBuildOnlyXattrs(filePath);
      try {
        execFileSync("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
        signedCount += 1;
        return;
      } catch (e) {
        const stderr = e && e.stderr ? e.stderr.toString().trim() : "";
        failures.push(`attempt ${attempt}: ${stderr || (e.message || String(e))}`);
        if (attempt < 5) sleepMs(150 * attempt);
      }
    }
    throw new Error(
      `codesign failed for ${filePath}\n  args: ${args.join(" ")}\n${failures.join("\n")}`,
    );
  };
  walkTree(runtimeRoot, (entryPath, st) => {
    if (!st.isFile()) return;
    const kind = classifyMacho(entryPath);
    if (kind === "non-macho" || kind === "macho-other") return;
    signOne(entryPath, kind);
  });
  log(
    `[macos-signing] Pre-signed ${signedCount} runtime binaries ` +
    `(${execCount} executables + ${dylibCount} dylibs/bundles)`,
  );
  return { runtimeRoot, signedCount, execCount, dylibCount };
}

module.exports = {
  REQUIRED_USAGE_DESCRIPTION_KEYS,
  SCREEN_INPUT_HELPER_IN_BUNDLE,
  DICTATION_HELPER_IN_BUNDLE,
  NATIVE_HELPERS_IN_BUNDLE,
  assertNoBundledBytecode,
  assertNativeHelpers,
  classifyMacho,
  designatedRequirementIsStable,
  hardenAppTransportSecurity,
  hasCertificateIdentity,
  hasSigningIdentity,
  isDeveloperIdIdentity,
  listSigningIdentities,
  makeBundledPythonImportsReadOnly,
  normalizeMacPrivacyUsageDescriptions,
  pathIsInside,
  preSignRuntimeBinaries,
  resolveSigningPlan,
  runtimeSignArgs,
  selfSignedEntitlementsPath,
  shouldIgnoreOsxSignPath,
  stableDesignatedRequirementPattern,
  walkTree,
};
