// afterPack hook for electron-builder — code signing via @electron/osx-sign.
//
// Runs AFTER electron-builder has staged ``Transcriptor.app`` inside
// ``dist/mac-arm64/`` or ``dist/mac/`` but BEFORE the DMG wrapper is
// built. We take over code signing so we can pin a stable identity
// across rebuilds without re-triggering macOS TCC permission prompts.
//
// Why @electron/osx-sign instead of raw codesign
// ------------------------------------------------
// Our previous attempt used ``codesign --deep --sign X --identifier
// local.transcriptor.app`` which crashed the app at launch with:
//
//     Library not loaded: @rpath/Electron Framework.framework/...
//     mapping process and mapped file (non-platform) have different
//     Team IDs
//
// Two root causes:
//
//   1. ``--deep --identifier Y`` clobbered the signing identifier of
//      every nested Framework/helper/.app as well. After the pass,
//      ``Electron Framework`` claimed the SAME identifier
//      (``local.transcriptor.app``) as the main binary. Hardened
//      runtime library validation refused to load a "framework"
//      that identifies as the main app.
//
//   2. Each Electron helper (.app / Renderer / Plugin / GPU) needs
//      its OWN entitlements subset (renderer gets cs.allow-jit only,
//      the top-level bundle gets the full set including audio-input
//      and automation). Passing one entitlements file to every
//      nested item via ``--deep`` over-privileges helpers and still
//      leaves the top-level bundle misconfigured.
//
// ``@electron/osx-sign`` is the canonical Electron signing tool
// written specifically for this structure. It walks the bundle
// innermost-first, preserves each nested item's natural identifier,
// signs innermost-first, preserves each nested item's natural
// identifier, and lets us apply the top-level entitlements to the
// bundle while applying the inherit entitlement subset to helpers and
// frameworks.
// Library validation passes because every item keeps its own
// identifier and they all share the same signing authority.
//
// Identity selection
// ------------------
// Uses TRANSCRIPTOR_SIGNING_IDENTITY when set; otherwise falls back to
// the internal development identity. Production builds can point this
// at a real "Developer ID Application: ..." certificate without editing
// source. TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 is the only path to ad-hoc
// signing and intentionally forces identity "-" for local/internal
// throwaway builds.
//
// TCC persistence
// ---------------
// macOS TCC indexes permission grants by the signing certificate
// fingerprint + bundle identifier. Using a stable keychain identity
// (instead of ad-hoc ``-``) anchors grants to the certificate, so
// rebuilds keep their Microphone / Accessibility / Apple Events
// grants even though every rebuild produces a different CDHash.

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const {
  assertNoBundledBytecode,
  assertNativeHelpers,
  hardenAppTransportSecurity,
  hasSigningIdentity,
  makeBundledPythonImportsReadOnly,
  normalizeMacPrivacyUsageDescriptions,
  preSignRuntimeBinaries,
  resolveSigningPlan,
  selfSignedEntitlementsPath,
  shouldIgnoreOsxSignPath,
} = require("./scripts/macos-signing-utils");

exports.default = async function afterPack(context) {
  // electron-builder invokes afterPack for every platform. Only
  // touch macOS builds — Windows/Linux ignore codesign.
  const platform = context.electronPlatformName || context.packager.platform.nodeName;
  if (platform !== "darwin" && platform !== "mas") {
    return;
  }
  const isMas = platform === "mas";

  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`afterPack: ${appPath} does not exist`);
  }

  const projectDir = context.packager.info.projectDir;
  // desktop/package.json is the SSOT for which entitlements and which
  // usage descriptions this build carries. `identity: null` keeps
  // electron-builder itself out of the signing path (this hook signs
  // instead), and that ALSO makes it skip reading build.mac.entitlements
  // / entitlementsInherit / extendInfo — so those keys looked like the
  // obvious place to edit while changing nothing at all, and the real
  // values were retyped here and in macos-signing-utils.js. The hook
  // reads them instead of naming files of its own.
  const platformCfg = context.packager.platformSpecificBuildOptions || {};
  const declaredEntitlements = platformCfg.entitlements;
  const declaredInherit = platformCfg.entitlementsInherit;
  if (!declaredEntitlements || !declaredInherit) {
    throw new Error(
      `afterPack: build.${isMas ? "mas" : "mac"}.entitlements and .entitlementsInherit ` +
        "must be declared in desktop/package.json — they are the SSOT for this build's entitlements.",
    );
  }
  hardenAppTransportSecurity(appPath, {
    log: (message) => console.log(message.replace("[macos-signing]", "[afterPack]")),
  });
  normalizeMacPrivacyUsageDescriptions(appPath, {
    extendInfo: platformCfg.extendInfo,
    log: (message) => console.log(message.replace("[macos-signing]", "[afterPack]")),
  });

  // The native helpers ship in every mac build except the App Store one;
  // a build that disagrees fails here instead of shipping a screen hotkey
  // that is silently never offered, pastes that always take the slow
  // AppleScript path, or helpers the sandbox kills.
  const nativeHelpers = assertNativeHelpers(appPath, { expected: !isMas });

  if (isMas) {
    assertNoBundledBytecode(appPath);
    if (process.env.TRANSCRIPTOR_MAS_EXTERNAL_SIGN !== "1") {
      throw new Error(
        "afterPack: MAS builds must use `npm --prefix desktop run dist:mas`. " +
          "That pipeline builds the MAS-flavored Electron app first, then signs it " +
          "with the App Store provisioning profile and installer identity in a " +
          "single audited step.",
      );
    }
    console.log(
      "[afterPack] TRANSCRIPTOR_MAS_EXTERNAL_SIGN=1 — leaving MAS app unsigned " +
        "for scripts/sign-mas.js",
    );
    return;
  }

  // One signing decision, shared with afterAllArtifactBuild.js — which
  // identity, is it a Developer ID, and therefore which timestamp policy
  // and which entitlements profile. Both hooks used to derive this
  // separately, each with its own hardcoded default identity name.
  const plan = resolveSigningPlan(process.env);
  const { identity, requestedIdentity, adhoc: useAdhocIdentity, developerId: isDeveloperIdIdentity } = plan;
  const runtimeTimestampArg = plan.timestampArg;
  if (!useAdhocIdentity && !hasSigningIdentity(requestedIdentity)) {
    throw new Error(
      `afterPack: missing signing identity "${requestedIdentity}". ` +
        "Set TRANSCRIPTOR_SIGNING_IDENTITY to a valid keychain identity, " +
        "or set TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 only for explicit local ad-hoc builds.",
    );
  }

  // A self-signed certificate has an EMPTY Team ID, which makes dyld4
  // reject cross-image loads under hardened-runtime library validation;
  // the two relaxations that work around it must not travel into a
  // public Developer ID build, where they would permanently disable
  // library validation in the shipped binary for a reason that does not
  // apply to it. The profile follows from the identity, so neither can
  // be used for the wrong kind of build.
  const entitlements = path.join(
    projectDir,
    plan.entitlementsProfile === "developer-id" ? declaredEntitlements : selfSignedEntitlementsPath(declaredEntitlements),
  );
  const inheritEntitlements = path.join(
    projectDir,
    plan.entitlementsProfile === "developer-id" ? declaredInherit : selfSignedEntitlementsPath(declaredInherit),
  );
  if (!existsSync(entitlements)) {
    throw new Error(`afterPack: entitlements plist missing at ${entitlements}`);
  }
  if (!existsSync(inheritEntitlements)) {
    throw new Error(`afterPack: inherit entitlements missing at ${inheritEntitlements}`);
  }
  console.log(`[afterPack] Entitlements profile: ${plan.entitlementsProfile}`);

  if (!useAdhocIdentity) {
    console.log(
      `[afterPack] Signing ${appPath} with identity "${requestedIdentity}" via @electron/osx-sign`,
    );
    console.log(
      isDeveloperIdIdentity
        ? "[afterPack] Developer ID identity detected; secure timestamps are enabled for notarization."
        : "[afterPack] Internal identity detected; timestamp service is disabled for offline internal builds.",
    );
    console.log(
      "[afterPack] TCC permissions (microphone, accessibility, Apple Events) will persist across rebuilds.",
    );
  } else {
    console.log(
      "[afterPack] TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 — using ad-hoc signing identity \"-\"",
    );
    console.log(
      "[afterPack] NOTE: ad-hoc rebuilds invalidate TCC grants; the user will see permission prompts every build.",
    );
  }
  console.log(`[afterPack] Top-level entitlements: ${entitlements}`);

  // @electron/osx-sign is the canonical Electron signing tool. It
  // walks the bundle innermost-first, preserves each nested item's
  // natural signing identifier, and applies helper-specific default
  // entitlements from its bundled templates. We pass:
  //
  //   - ``app``                 : the .app bundle to sign
  //   - ``identity``            : keychain cert name or "-" for ad-hoc
  //   - ``identityValidation``  : false so it accepts our self-signed
  //                                cert and the ad-hoc "-" marker
  //                                without trying to validate them
  //                                against Apple's cert chain
  //   - ``optionsForFile``      : per-file hook. For the top-level
  //                                .app we return our custom
  //                                entitlements; every nested item
  //                                gets the tool's default
  //                                helper-specific entitlements
  //                                (returning undefined from the hook
  //                                triggers the default behaviour).
  //   - ``preAutoEntitlements: false``
  //                                disables the mas-specific sandbox
  //                                entitlement injection (we are not
  //                                targeting the Mac App Store).
  //   - ``type: "distribution"`` the hardened-runtime code path.
  //   - ``platform: "darwin"``  non-mas build.
  //
  // Signing helpers with hardened runtime + their own (narrower)
  // entitlements is what fixes the "different Team IDs" launch
  // crash we hit with ``codesign --deep``: each framework keeps its
  // own signing identifier, so library validation sees them as
  // normal dylibs loaded by the main binary rather than duplicate
  // main binaries.

  // Dynamically import @electron/osx-sign so a missing dep gives a
  // clear error message instead of a cryptic MODULE_NOT_FOUND at
  // afterPack time.
  let osxSign;
  try {
    osxSign = require("@electron/osx-sign");
  } catch (e) {
    throw new Error(
      "afterPack: @electron/osx-sign is required for macOS signing. " +
        "Run `npm --prefix desktop install` to install it. " +
        `Underlying error: ${e && e.message ? e.message : String(e)}`,
    );
  }
  const signApp = osxSign.signAsync || osxSign.sign;
  if (typeof signApp !== "function") {
    throw new Error(
      "afterPack: @electron/osx-sign does not expose signAsync/sign — " +
        "incompatible version installed.",
    );
  }

  // STEP 1 — sign bundled runtime binaries BEFORE @electron/osx-sign
  // walks the app. If we sign them after, the Resources envelope
  // (_CodeSignature/CodeResources) computed by osx-sign captures
  // hashes of the still-unsigned files, and the later signing
  // invalidates those hashes → verify --deep --strict fails.
  // Signing first means osx-sign's envelope hashes the final signed
  // bytes of every runtime file.
  const { runtimeRoot } = preSignRuntimeBinaries({
    appPath,
    identity,
    entitlements: inheritEntitlements,
    timestampArg: runtimeTimestampArg,
    log: (message) => console.log(message.replace("[macos-signing]", "[afterPack]")),
  });

  // STEP 2 — main @electron/osx-sign pass (bundle walk + envelope).
  //
  // Timestamp policy:
  //   - Developer ID builds keep @electron/osx-sign's default
  //     ``--timestamp`` behaviour because notarization expects secure
  //     timestamps.
  //   - Internal/self-signed/ad-hoc builds force ``--timestamp=none``
  //     so offline internal builds do not fail on Apple timestamp
  //     service/network outages. These builds are not Gatekeeper-trusted
  //     public artifacts.
  const osxSignTimestamp = isDeveloperIdIdentity ? undefined : "none";
  const perFileTimestamp = () => (
    osxSignTimestamp === undefined ? {} : { timestamp: osxSignTimestamp }
  );
  await signApp({
    app: appPath,
    identity,
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    hardenedRuntime: true,
    preAutoEntitlements: false,
    ignore: (filePath) => shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot),
    // Per-file entitlements hook.
    //
    // Top-level .app bundle gets the full entitlements
    // (microphone, Apple Events, network client + disable-
    // library-validation).
    //
    // Every helper (.app) and framework/dylib gets the INHERIT
    // entitlements (allow-jit, allow-unsigned-executable-memory,
    // audio-input, disable-library-validation).
    //
    // Why force our own entitlements on every nested item instead
    // of letting osx-sign use its bundled defaults:
    //
    //   The default osx-sign templates (default.darwin.renderer.
    //   plist, default.darwin.gpu.plist, default.darwin.plugin.
    //   plist) do NOT contain disable-library-validation. Under
    //   hardened runtime with a self-signed certificate that has
    //   no Team ID, the helpers fail to load Electron Framework
    //   via dyld4 library validation and crash at launch — the
    //   exact "different Team IDs" crash we hit with a raw
    //   codesign --deep pass. Passing our inherit plist
    //   explicitly guarantees the entitlement lands on every
    //   helper that might independently load the framework.
    optionsForFile: (filePath) => {
      if (filePath === appPath) {
        return {
          entitlements,
          hardenedRuntime: true,
          ...perFileTimestamp(),
        };
      }
      return {
        entitlements: inheritEntitlements,
        hardenedRuntime: true,
        ...perFileTimestamp(),
      };
    },
  });

  // Python bytecode caches are not allowed to appear inside the
  // signed .app after install. Python normally treats failed bytecode
  // writes as non-fatal, so make the import trees themselves
  // immutable. This protects the code signature even if a future
  // interpreter build ignores PYTHONDONTWRITEBYTECODE / -B during
  // early bootstrap imports.
  assertNoBundledBytecode(appPath);
  const locked = makeBundledPythonImportsReadOnly(appPath);
  console.log(
    `[afterPack] Locked bundled Python import trees read-only ` +
    `(${locked.fileCount} files + ${locked.dirCount} directories)`,
  );
  assertNoBundledBytecode(appPath);

  // Verify the finished signature. ``--strict`` catches any resource
  // envelope drift, ``--deep`` walks all nested items. On failure
  // this throws and aborts the build.
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" },
  );
  // The helpers live under Resources, which `--deep` covers only by the
  // envelope hash: verify their own signatures too (macOS refuses to give
  // an event tap to an unsigned or broken binary under hardened runtime).
  for (const helper of nativeHelpers) {
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", helper],
      { stdio: "inherit" },
    );
  }

  // Dump the top-level signature identity + authority + runtime flags
  // so the build log shows exactly how the app was signed.
  try {
    execFileSync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", appPath],
      { stdio: "inherit" },
    );
  } catch {
    // Informational only; do not fail on it.
  }

  // Also print the Electron Framework's identifier — if library
  // validation fails at launch, this is the first thing to check.
  const electronFw = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  if (existsSync(electronFw)) {
    try {
      execFileSync(
        "/usr/bin/codesign",
        ["-dv", "--verbose=2", electronFw],
        { stdio: "inherit" },
      );
    } catch {
      // Informational only.
    }
  }

  console.log(`[afterPack] Signed ${appName}.app OK`);
};
