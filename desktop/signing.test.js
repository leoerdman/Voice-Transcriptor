"use strict";

// Executable specification for the macOS signing decision.
//
// Until now the whole signing/packaging surface — afterPack.js,
// afterAllArtifactBuild.js, macos-signing-utils.js, sign-mas.js — had no
// tests at all, which is why a build that could never be notarized (every
// bundled dylib and Python extension signed ad-hoc, without the hardened
// runtime) survived: the local check, `codesign --verify --deep --strict`,
// accepts ad-hoc signatures, and no CI job runs on macOS.
//
// Nothing here needs a keychain or a Mac: the decision and the argument
// list are pure functions, and they are what a notarization failure would
// have been about.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  REQUIRED_USAGE_DESCRIPTION_KEYS,
  SCREEN_INPUT_HELPER_IN_BUNDLE,
  assertScreenInputHelper,
  designatedRequirementIsStable,
  isDeveloperIdIdentity,
  resolveSigningPlan,
  runtimeSignArgs,
  selfSignedEntitlementsPath,
} = require("./scripts/macos-signing-utils");

const packageJson = require("./package.json");
const DEV_ID = "Developer ID Application: Example Corp (AB12CD34EF)";

test("every bundled Mach-O is signed with the real identity, hardened, and timestamped", () => {
  // The regression: dylibs and Python extension bundles (`MH_DYLIB`,
  // `MH_BUNDLE` — every .so in site-packages, libpython itself) were
  // signed ad-hoc with "-" and without --options runtime, while only
  // executables got the requested identity. notarytool rejects such a
  // package file by file ("not signed with a valid Developer ID
  // certificate" / "does not have the hardened runtime enabled").
  for (const kind of ["executable", "dylib"]) {
    const args = runtimeSignArgs({
      filePath: `/tmp/app/Contents/Resources/runtime/x.${kind === "dylib" ? "so" : "bin"}`,
      identity: DEV_ID,
      entitlements: "/tmp/entitlements.mac.inherit.plist",
      timestampArg: "--timestamp",
    });
    assert.deepEqual(args, [
      "--force",
      "--sign", DEV_ID,
      "--options", "runtime",
      "--entitlements", "/tmp/entitlements.mac.inherit.plist",
      "--timestamp",
      `/tmp/app/Contents/Resources/runtime/x.${kind === "dylib" ? "so" : "bin"}`,
    ], `${kind} must carry the same identity, hardened runtime and timestamp`);
  }
});

test("an ad-hoc build signs ad-hoc, and asks for no timestamp it cannot have", () => {
  const args = runtimeSignArgs({
    filePath: "/tmp/x.so",
    identity: "-",
    entitlements: "/tmp/e.plist",
    timestampArg: "--timestamp",
  });
  assert.ok(!args.includes("--timestamp"), "an ad-hoc signature has no certificate to timestamp");
  assert.deepEqual(args.slice(0, 3), ["--force", "--sign", "-"]);
  assert.ok(args.includes("runtime"), "the hardened runtime is not what ad-hoc gives up");
});

test("runtimeSignArgs refuses to build an incomplete command", () => {
  assert.throws(() => runtimeSignArgs({ identity: DEV_ID, entitlements: "e" }), /filePath/);
  assert.throws(() => runtimeSignArgs({ filePath: "f", entitlements: "e" }), /identity/);
  assert.throws(() => runtimeSignArgs({ filePath: "f", identity: DEV_ID }), /entitlements/);
});

test("a build must say what signed it — there is no built-in default identity", () => {
  // The default used to be one developer's self-signed key, named in two
  // source files: ./BUILD.command could not run anywhere else, and the
  // "release" it produced was quietly un-notarizable.
  assert.throws(() => resolveSigningPlan({}), /TRANSCRIPTOR_SIGNING_IDENTITY/);
  assert.throws(() => resolveSigningPlan({ TRANSCRIPTOR_SIGNING_IDENTITY: "   " }), /TRANSCRIPTOR_SIGNING_IDENTITY/);
});

test("a Developer ID identity selects secure timestamps and the strict entitlements profile", () => {
  const plan = resolveSigningPlan({ TRANSCRIPTOR_SIGNING_IDENTITY: DEV_ID });
  assert.equal(plan.identity, DEV_ID);
  assert.equal(plan.developerId, true);
  assert.equal(plan.adhoc, false);
  assert.equal(plan.timestampArg, "--timestamp");
  assert.equal(plan.entitlementsProfile, "developer-id");
});

test("a self-signed identity keeps offline timestamps and the relaxed profile", () => {
  const plan = resolveSigningPlan({ TRANSCRIPTOR_SIGNING_IDENTITY: "InternalDevKey" });
  assert.equal(plan.developerId, false);
  assert.equal(plan.timestampArg, "--timestamp=none");
  assert.equal(plan.entitlementsProfile, "self-signed");
});

test("ad-hoc wins over any identity in the environment", () => {
  const plan = resolveSigningPlan({
    TRANSCRIPTOR_ALLOW_ADHOC_SIGN: "1",
    TRANSCRIPTOR_SIGNING_IDENTITY: DEV_ID,
  });
  assert.equal(plan.identity, "-");
  assert.equal(plan.adhoc, true);
  assert.equal(plan.developerId, false, "an ad-hoc build is never a Developer ID build");
  assert.equal(plan.entitlementsProfile, "self-signed");
});

test("isDeveloperIdIdentity does not mistake an installer or a lookalike name", () => {
  assert.equal(isDeveloperIdIdentity(DEV_ID), true);
  assert.equal(isDeveloperIdIdentity("Developer ID Installer: Example Corp (AB12CD34EF)"), false);
  assert.equal(isDeveloperIdIdentity("Apple Development: someone (X)"), false);
  assert.equal(isDeveloperIdIdentity("My Developer ID Application: fake"), false);
  assert.equal(isDeveloperIdIdentity(""), false);
});

test("the public profile carries no library-validation relaxations", () => {
  // These two entitlements exist only to work around a SELF-SIGNED
  // certificate's empty Team ID. Shipping them in a notarized public
  // binary would permanently disable library validation there.
  const dir = __dirname;
  const strict = fs.readFileSync(path.join(dir, "entitlements.mac.plist"), "utf8");
  const strictInherit = fs.readFileSync(path.join(dir, "entitlements.mac.inherit.plist"), "utf8");
  for (const [name, body] of [["entitlements.mac.plist", strict], ["entitlements.mac.inherit.plist", strictInherit]]) {
    for (const key of ["disable-library-validation", "allow-unsigned-executable-memory"]) {
      assert.ok(!body.includes(`<key>com.apple.security.cs.${key}</key>`), `${name} must not grant ${key}`);
    }
    assert.ok(body.includes("<key>com.apple.security.cs.allow-jit</key>"), `${name} still needs allow-jit for V8`);
  }

  // The self-signed profile is where they belong, and it must exist for
  // every entitlements file package.json declares.
  for (const declared of [packageJson.build.mac.entitlements, packageJson.build.mac.entitlementsInherit]) {
    const variant = selfSignedEntitlementsPath(declared);
    assert.ok(fs.existsSync(path.join(dir, variant)), `${variant} is missing`);
    assert.match(fs.readFileSync(path.join(dir, variant), "utf8"), /disable-library-validation/);
  }
});

test("selfSignedEntitlementsPath derives the variant, and refuses an unexpected name", () => {
  assert.equal(selfSignedEntitlementsPath("entitlements.mac.plist"), "entitlements.mac.selfsigned.plist");
  assert.equal(
    selfSignedEntitlementsPath("entitlements.mac.inherit.plist"),
    "entitlements.mac.selfsigned.inherit.plist",
  );
  assert.throws(() => selfSignedEntitlementsPath("entitlements.mas.plist"), /entitlements\.mac\./);
  assert.throws(() => selfSignedEntitlementsPath(""), /entitlements\.mac\./);
});

test("package.json is the SSOT the hooks read: entitlements and usage strings are declared there", () => {
  // electron-builder skips its own signing path (identity: null), and
  // with it the reading of these keys — so they looked like decoration
  // while the real values were retyped in the hooks. afterPack.js and
  // sign-mas.js now read exactly these.
  for (const platform of ["mac", "mas"]) {
    const cfg = packageJson.build[platform];
    assert.ok(cfg.entitlements, `build.${platform}.entitlements must be declared`);
    assert.ok(cfg.entitlementsInherit, `build.${platform}.entitlementsInherit must be declared`);
    assert.ok(
      fs.existsSync(path.join(__dirname, cfg.entitlements)),
      `build.${platform}.entitlements points at a missing file: ${cfg.entitlements}`,
    );
    assert.ok(
      fs.existsSync(path.join(__dirname, cfg.entitlementsInherit)),
      `build.${platform}.entitlementsInherit points at a missing file: ${cfg.entitlementsInherit}`,
    );
    for (const key of REQUIRED_USAGE_DESCRIPTION_KEYS) {
      assert.ok(
        String((cfg.extendInfo || {})[key] || "").trim(),
        `build.${platform}.extendInfo.${key} is the text macOS shows in the permission prompt`,
      );
    }
  }
});

test("the MAS sandbox may listen on its own loopback backend", () => {
  // The app runs uvicorn on 127.0.0.1. In the App Sandbox, bind() needs
  // network.server; network.client only covers outbound connections, so
  // without it the MAS build cannot start its backend at all.
  const mas = fs.readFileSync(path.join(__dirname, "entitlements.mas.plist"), "utf8");
  assert.match(mas, /<key>com\.apple\.security\.network\.server<\/key>\s*<true\/>/);
  assert.match(mas, /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
});

test("no signing identity is hardcoded in the build hooks any more", () => {
  for (const file of ["afterPack.js", "afterAllArtifactBuild.js", "scripts/macos-signing-utils.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(
      !/DEFAULT_INTERNAL_SIGNING_IDENTITY/.test(source),
      `${file} must not carry a built-in default signing identity`,
    );
  }
});

// ── The signature the user's permissions are keyed to ──────────────────

test("an installable build's designated requirement binds the bundle id to a certificate", () => {
  const appId = packageJson.build.appId;
  // What a build signed with the internal (or any) certificate produces,
  // and the only shape a TCC grant survives a rebuild under.
  const stable =
    `designated => identifier "${appId}" and certificate leaf = H"d1f9138d0b7df1fed158a1bde6ef079979a85498"`;
  assert.equal(designatedRequirementIsStable(stable, appId).ok, true);
  // codesign prints the identifier unquoted when it needs no quoting.
  assert.equal(
    designatedRequirementIsStable(`designated => identifier ${appId} and certificate leaf = H"ab"`, appId).ok,
    true,
  );
  // An ad-hoc bundle: a cdhash of THIS build, so every rebuild is a new
  // identity and every permission the user granted dies with it — while
  // System Settings goes on showing the app as granted.
  const adhoc = designatedRequirementIsStable('designated => cdhash H"1122334455"', appId);
  assert.equal(adhoc.ok, false);
  assert.match(adhoc.reason, /ad-hoc/);
  // Someone else's bundle id is not this app's grant.
  assert.equal(
    designatedRequirementIsStable(`designated => identifier "com.example.other" and certificate leaf = H"ab"`, appId).ok,
    false,
  );
  assert.equal(designatedRequirementIsStable("", appId).ok, false);
  assert.equal(designatedRequirementIsStable("designated => anchor apple", appId).ok, false);
});

test("the install path refuses an ad-hoc bundle, and says why", () => {
  // TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 is a legitimate mode for a throwaway
  // local build — and a permission-destroying one for the copy in
  // /Applications, which is what BUILD.command installs. The guard is a
  // check on the artifact, not on the environment, so it also catches a
  // bundle that lost its signature some other way.
  const adhocPlan = resolveSigningPlan({ TRANSCRIPTOR_ALLOW_ADHOC_SIGN: "1" });
  assert.equal(adhocPlan.identity, "-", "ad-hoc signing produces no certificate to bind to");
  const build = fs.readFileSync(path.join(__dirname, "..", "BUILD.command"), "utf8");
  assert.match(
    build,
    /check-designated-requirement\.js/,
    "BUILD.command must verify the requirement before replacing an installed app",
  );
  const guard = fs.readFileSync(path.join(__dirname, "scripts", "check-designated-requirement.js"), "utf8");
  assert.match(guard, /designatedRequirementIsStable/, "the guard must use the tested decision, not its own regex");
  assert.match(guard, /process\.exit\(1\)/, "the guard must fail the install, not merely warn");
});

test("BUILD.command explains why the signing identity may not drift", () => {
  const build = fs.readFileSync(path.join(__dirname, "..", "BUILD.command"), "utf8");
  assert.match(build, /TCC/, "the header must name the reason: TCC grants are keyed to the signature");
  assert.match(build, /-1743/, "…and the symptom a drifting identity produces");
});

test("no updater metadata is published: the app has no updater", () => {
  // `repository` alone makes electron-builder infer a GitHub publish
  // provider and write Contents/Resources/app-update.yml, while
  // writeUpdateInfo:false deliberately suppresses the other half. There
  // is no electron-updater in the app at all.
  assert.equal(packageJson.build.publish, null);
});

test("afterPack's helper check: a mac build must carry screen-input, an App Store build must not", () => {
  const os = require("node:os");
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "helper-check-")) + "/Transcriptor.app";
  const helper = path.join(app, SCREEN_INPUT_HELPER_IN_BUNDLE);
  try {
    assert.throws(() => assertScreenInputHelper(app, { expected: true }), /missing from the bundle/);
    assert.equal(assertScreenInputHelper(app, { expected: false }), null);
    // A thin 64-bit Mach-O executable header (MH_MAGIC_64, MH_EXECUTE).
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(2, 12);
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, header);
    assert.equal(assertScreenInputHelper(app, { expected: true }), helper);
    assert.throws(() => assertScreenInputHelper(app, { expected: false }), /must not ship/);
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  }
});

test("the install-time requirement check reads the signature without a shell", {
  skip: fs.existsSync("/usr/bin/codesign") ? false : "codesign is macOS-only",
}, () => {
  // The bundle path comes from $TRANSCRIPTOR_INSTALL_DIR. An unsigned
  // bundle sent the old script to `/bin/sh -c "codesign … <path>"`, where
  // `$(…)` in the path ran.
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dr-check-"));
  try {
    const app = path.join(work, "inj-$(touch pwned)", "Unsigned.app");
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.transcriptor.app</string></dict></plist>',
    );
    const run = spawnSync(process.execPath, [path.join(__dirname, "scripts", "check-designated-requirement.js"), app], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(fs.existsSync(path.join(work, "pwned")), false, "a command in the bundle path was executed");
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Refusing to install/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("afterPack runs the helper check for every mac flavour, before signing", () => {
  const afterPack = fs.readFileSync(path.join(__dirname, "afterPack.js"), "utf8");
  const check = afterPack.indexOf("assertScreenInputHelper(appPath, { expected: !isMas })");
  assert.ok(check > 0, "afterPack checks the helper");
  assert.ok(check < afterPack.indexOf("if (isMas) {"), "before the MAS branch returns");
  assert.ok(check < afterPack.indexOf("preSignRuntimeBinaries({"), "before the runtime is signed");
  assert.match(afterPack, /"--verify", "--strict", "--verbose=2", screenInputHelper/);
});
