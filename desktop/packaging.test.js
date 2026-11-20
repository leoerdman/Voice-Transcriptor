"use strict";

// Executable specification for the electron-builder "files" whitelist.
//
// The whitelist is OPT-IN per file: anything required by main.js at
// module load that is not listed is simply absent from the packaged
// app — and the DMG then dies at startup with MODULE_NOT_FOUND before
// a single window exists. No unit test catches that, because tests run
// from the source tree where the file always exists.
//
// This spec closes the class of bug: it parses every local require()
// out of the packaged entrypoints and asserts each resolved file is
// matched by a POSITIVE pattern in build.files. Adding a new local
// module without updating the whitelist fails npm test here, in CI or
// on the dev machine — not in a user's freshly mounted DMG.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DIR = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf8"));

// Entrypoints electron-builder packs and whose ENTIRE local-require
// graph must be covered by build.files (BUG-17: a helper required by
// preload.js would previously escape the top-level-only check).
const ENTRYPOINTS = ["main.js", "preload.js"];

function resolveCandidate(rel) {
  // Node resolution as used by require("./x"): exact file, then .js,
  // then .json (directories are not used by this codebase).
  const base = path.join(DESKTOP_DIR, rel);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return rel;
  for (const ext of [".js", ".json"]) {
    if (fs.existsSync(base + ext)) return rel + ext;
  }
  return null;
}

/** Walk the local-require graph from the entrypoints, cycle-safe. */
function collectLocalRequiresGraph() {
  const seen = new Set();
  const edges = [];
  const queue = ENTRYPOINTS.map((f) => ({ from: f, file: f }));
  while (queue.length) {
    const { from, file } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(DESKTOP_DIR, file), "utf8");
    // require("./name") and require("./name.ext") — relative, literal,
    // single argument. Dynamic/parent-dir requires would be flagged by
    // review; none exist today.
    const re = /require\(\s*["']\.\/([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const resolved = resolveCandidate(m[1]);
      assert.ok(resolved !== null, `${file} requires "./${m[1]}" but no such file exists on disk`);
      edges.push({ from: file, resolved });
      queue.push({ from: file, file: resolved });
    }
  }
  return edges;
}

/**
 * Does one `build.files` pattern (already stripped of its leading "!")
 * match this path?
 *
 * A deliberately small glob: `**` crosses separators, `*` and `?` do not.
 * That is the subset electron-builder's patterns in this manifest use, and
 * anything richer would be a second minimatch to get wrong.
 */
function patternMatches(pattern, resolved) {
  if (pattern === resolved) return true;
  const escaped = (text) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // A trailing "/**" is "everything under this directory", including the
  // directory itself — minimatch's rule and the one build.files relies on.
  if (pattern.endsWith("/**")) {
    return new RegExp(`^${escaped(pattern.slice(0, -3))}(?:/.*)?$`).test(resolved);
  }
  // `escaped` leaves * and ? alone (they are the glob syntax), so the
  // sentinels below are safe: nothing that replaces them reintroduces one.
  const body = escaped(pattern)
    .split("**/").join("<<ANYDIR>>")
    .split("**").join("<<ANY>>")
    .split("*").join("[^/]*")
    .split("?").join("[^/]")
    .split("<<ANYDIR>>").join("(?:.*/)?")
    .split("<<ANY>>").join(".*");
  return new RegExp(`^${body}$`).test(resolved);
}


/**
 * electron-builder applies build.files IN ORDER and the LAST pattern that
 * matches decides, so a "!" entry after a positive one excludes what the
 * positive one included.
 *
 * This used to drop every "!" pattern before matching, which meant the spec
 * could report a module as packaged while the manifest excluded it — the
 * exact MODULE_NOT_FOUND-in-a-user's-DMG failure the file exists to prevent,
 * with a green test on top of it.
 */
function coveredByWhitelist(resolved) {
  let included = false;
  for (const raw of pkg.build?.files || []) {
    const negated = raw.startsWith("!");
    if (!patternMatches(negated ? raw.slice(1) : raw, resolved)) continue;
    included = !negated;
  }
  return included;
}

test("build.files whitelist covers every local require of the packaged entrypoints", () => {
  const problems = [];
  for (const { from, resolved } of collectLocalRequiresGraph()) {
    if (!coveredByWhitelist(resolved)) {
      problems.push(`${from} -> ./${resolved} is MISSING from build.files`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    "packaged app would crash with MODULE_NOT_FOUND:\n  " + problems.join("\n  "),
  );
});

test("the accelerator SSOT module itself is packaged", () => {
  // Regression anchor for the bug this spec was born from: main.js's
  // require of ./accelerator shipped unlisted once already.
  assert.ok(
    coveredByWhitelist("accelerator.js"),
    "accelerator.js must stay in build.files",
  );
});

test("frontend and desktop package versions match the desktop SSOT", () => {
  // desktop/package.json is the version SSOT (AGENTS.md rule 4);
  // frontend/package.json duplicates the number for tooling, and the
  // two have drifted in the past (BUG-75). A release that bumps one
  // and not the other now fails npm test instead of shipping a
  // renderer that reports a different version than the shell.
  const frontendPkg = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, "..", "frontend", "package.json"), "utf8"),
  );
  assert.equal(
    frontendPkg.version,
    pkg.version,
    `version drift: desktop/package.json=${pkg.version}, frontend/package.json=${frontendPkg.version} — bump both together`,
  );
});

test("every file the app reads at runtime is actually shipped as an extraResource", () => {
  // getRepoRoot() is process.resourcesPath in a packaged app, so anything
  // main.js reads relative to it must be listed here or the read fails only
  // on a user's machine. requirements.runtime-lock.txt was the case that
  // proved it: prepare-runtime.sh built the bundle with those constraints,
  // the file was never copied into Resources, and the on-device repair
  // install ("Installing dependencies (first launch)…") could not possibly
  // apply them — it was free to put a numpy or an onnxruntime into the
  // user's environment that the pinned faster-whisper / ctranslate2 pair was
  // never tested against.
  const destinations = new Set(pkg.build.extraResources.map((entry) => entry.to));
  for (const name of ["requirements.txt", "requirements.runtime-lock.txt", ".python-version"]) {
    assert.ok(destinations.has(name), `${name} must be copied into Resources`);
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", name)),
      `${name} is named in extraResources but does not exist`,
    );
  }
});

test("one set of dependency pins: build, CI and the on-device repair all apply the lock", () => {
  // requirements.txt keeps ranges for five direct dependencies on purpose
  // (numpy, urllib3, cryptography, httptools, websockets) and the exact
  // versions live in requirements.runtime-lock.txt. Three installers read
  // those files; all three must apply the same constraints, or a green CI
  // run describes a version set the DMG does not ship.
  const lockName = "requirements.runtime-lock.txt";

  const prepare = fs.readFileSync(path.join(__dirname, "scripts", "prepare-runtime.sh"), "utf8");
  assert.match(prepare, /REQS_LOCK=/, "the release build must resolve the lock");
  assert.match(prepare, /pip_args\+=\(-c "\$\{REQS_LOCK\}"\)/, "the release build must pass it to pip");

  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "tests.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    new RegExp(`pip install -c ${lockName.replace(/\./g, "\\.")} -r requirements\\.txt`),
    "CI must install the version set the release is built with",
  );

  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(mainSource, /const lockPath = path\.join\(repoRoot, "requirements\.runtime-lock\.txt"\)/);
  assert.match(
    mainSource,
    /const constraintArgs = fs\.existsSync\(lockPath\) \? \["-c", lockPath\] : \[\]/,
    "the repair install must apply the lock when it is there",
  );
  // Both pip invocations on the backend-runtime repair path — the first
  // attempt and the --break-system-packages retry — must use the same
  // constraints. A retry that installs a different version set than the
  // attempt it replaces is a second source of truth reachable only from a
  // failure. (The optional-engine install is deliberately not included: it
  // installs requirements-gigaam.txt into its own staging site, and
  // engine-deps.js reconciles that set against the bundle by its own rules.)
  const backendInstalls = [
    ...mainSource.matchAll(/"-m", "pip", "install"(?:(?!runCommand)[\s\S])*?requirementsPath/g),
  ].map((m) => m[0]);
  assert.equal(backendInstalls.length, 2, "expected the attempt and its --break-system-packages retry");
  for (const call of backendInstalls) {
    assert.match(call, /constraintArgs/, `pip call without the lock: ${call}`);
  }
});

test("CI runs the desktop suite where its osacompile tests can execute", () => {
  // applescript.test.js and paste-script.test.js hand the AppleScript the
  // product ships to osacompile and skip themselves off darwin. On
  // ubuntu-latest they had never run once, so the exact failure
  // applescript.test.js was written for — a stray backtick truncating the
  // paste template — would have reached users with CI green.
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "tests.yml"),
    "utf8",
  );
  const desktopJob = workflow.slice(workflow.indexOf("\n  desktop:"));
  assert.match(desktopJob, /runs-on:\s*macos-latest/);
  // A count of the suites in prose went stale at the next added suite
  // ("seventeen" while there were 23); the directory is the count.
  assert.doesNotMatch(workflow, /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[- \w]*) suites are\b/i);

  // ...and those two suites must still be the darwin-gated ones, or the
  // reason for the macOS runner has quietly moved somewhere else.
  const darwinGated = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.js") && f !== path.basename(__filename))
    .filter((f) => fs.readFileSync(path.join(__dirname, f), "utf8").includes('process.platform !== "darwin"'));
  assert.deepEqual(darwinGated.sort(), ["applescript.test.js", "paste-script.test.js"]);

  // AGENTS.md names this a required check before every commit, and CI had
  // never run it.
  assert.match(desktopJob, /node --check main\.js && node --check preload\.js/);

  // The workflow states its token scope and cancels superseded runs.
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("no extraResource is copied to the same destination twice", () => {
  // app-builder-lib CONCATENATES build.<platform>.extraResources onto
  // build.extraResources rather than replacing them
  // (out/fileMatcher.js: addPatterns(config[name]) then
  // addPatterns(options.customBuildOptions[name])), so
  // ../requirements-gigaam.txt and ../ENABLE_GIGAAM were each copied to the
  // same path twice on mac, win and linux, and all six had to be edited
  // together to change one path.
  // The mas target is built from build.mac MERGED with build.mas
  // (macPackager getPlatformConfig → deepAssign, which concatenates
  // arrays), so its list is base + mac + mas.
  const ownLists = {
    mac: [pkg.build.mac],
    mas: [pkg.build.mac, pkg.build.mas],
    win: [pkg.build.win],
    linux: [pkg.build.linux],
  };
  for (const [platform, cfgs] of Object.entries(ownLists)) {
    const combined = [...pkg.build.extraResources, ...cfgs.flatMap((cfg) => (cfg && cfg.extraResources) || [])];
    const destinations = combined.map((entry) => entry.to);
    const duplicated = destinations.filter((to, i) => destinations.indexOf(to) !== i);
    assert.deepEqual(duplicated, [], `${platform}: duplicate extraResources destinations`);
  }
});

test("the artifact name is pinned, not inherited from electron-builder's default", () => {
  // Five independent strings — BUILD.command, notarize-dmg.sh, sign-mas.js,
  // INSTALL_ON_OTHER_MAC.command and docs/INSTALL_OTHER_MAC.md — reproduce
  // electron-builder's DEFAULT artifact name. A default is not a contract:
  // an upstream change to it breaks the release at "Built DMG not found".
  assert.equal(pkg.build.artifactName, "${productName}-${version}-${arch}.${ext}");

  // And the name those five strings expect must be what that template
  // produces, for the arch the mac target ships.
  const expanded = pkg.build.artifactName
    .replace("${productName}", pkg.build.productName)
    .replace("${version}", pkg.version)
    .replace("${arch}", "arm64")
    .replace("${ext}", "dmg");
  assert.equal(expanded, `Transcriptor-${pkg.version}-arm64.dmg`);
  const notarize = fs.readFileSync(path.join(__dirname, "scripts", "notarize-dmg.sh"), "utf8");
  assert.ok(
    notarize.includes("Transcriptor-${APP_VERSION}-arm64.dmg"),
    "notarize-dmg.sh must look for the artifact the manifest now names",
  );
});

test("every npm script that shells out to bash checks bash is there first", () => {
  // require-bash.js was wired to dist:win only. On a Windows or minimal
  // host every other release script died inside `bash` with the shell's own
  // error instead of the one sentence that says what to install.
  for (const [name, body] of Object.entries(pkg.scripts)) {
    if (!/(^|&&\s*)bash\s/.test(body)) continue;
    assert.match(
      body,
      /^node \.\/scripts\/require-bash\.js \S+ &&/,
      `npm script "${name}" runs bash without the guard`,
    );
  }
});

test("the DMG artwork is drawn around the icon positions the manifest declares", () => {
  // The generator carried the icon centres as literals (178 / 482), the same
  // numbers build.dmg.contents declares. Moving an icon left the wells and
  // the arrow behind it pointing where it used to be.
  const generator = fs.readFileSync(
    path.join(__dirname, "scripts", "generate-dmg-background.py"),
    "utf8",
  );
  assert.match(generator, /metadata\["build"\]\["dmg"\]\["contents"\]/);
  // The literal it used to carry was a tuple pairing each centre with its
  // label; nothing may pair a number with those labels any more.
  assert.ok(
    !/\(\s*\d+\s*,\s*"(APP|APPLICATIONS)"/.test(generator),
    "the generator still pairs a hardcoded x with a well label",
  );
  assert.match(generator, /def draw_install_wells\(\s*base[\s\S]*?columns: tuple/);
  assert.match(generator, /draw_install_wells\(canvas, draw, dmg_icon_columns\(metadata\)\)/);
  // ...and the asset it writes is the one package.json points electron-builder at.
  assert.equal(pkg.build.dmg.background, "build/dmg-background.png");
  assert.ok(fs.existsSync(path.join(__dirname, "build", "dmg-background.png")));
});

test("the identity strings that appear outside the manifest are locked to it", () => {
  // These four values have to be spelled out in places that cannot read
  // desktop/package.json — a bash installer, two READMEs, the release
  // env template. That is legitimate; what is not legitimate is nobody
  // noticing when one of them stops matching. The manifest stays the SSOT
  // and this test is what makes the copies followers rather than peers.
  const root = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const readmes = ["README.md", "README.en.md"];

  // appId — the installer refuses to install a bundle whose id it does not
  // recognise, and the READMEs quote it in the `tccutil reset` recipe.
  const installer = read("INSTALL_ON_OTHER_MAC.command");
  assert.match(
    installer,
    new RegExp(`DEFAULT_EXPECTED_BUNDLE_ID="${pkg.build.appId.replace(/\./g, "\\.")}"`),
    "the installer's expected bundle id must be the one the manifest builds",
  );
  for (const name of readmes) {
    assert.ok(read(name).includes(pkg.build.appId), `${name} quotes a different bundle id`);
  }

  // productName — the installer names the .app it copies.
  assert.match(installer, new RegExp(`PRODUCT_NAME="${pkg.build.productName}"`));
  assert.match(installer, new RegExp(`APP_NAME="${pkg.build.productName}\\.app"`));

  // The backend port default: `.env.example` is the SSOT for release
  // environment variables (AGENTS.md rule 4), main.js holds the fallback
  // used when the variable is unset, and the READMEs tell the user which
  // port to expect.
  const envPort = /^#\s*TRANSCRIPTOR_PORT=(\d+)$/m.exec(read(".env.example"));
  assert.ok(envPort, ".env.example must document the default port");
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(
    mainSource,
    new RegExp(`const DEFAULT_BACKEND_PORT = ${envPort[1]};`),
    `main.js's fallback port must be the one .env.example documents (${envPort[1]})`,
  );
  for (const name of readmes) {
    assert.ok(read(name).includes(envPort[1]), `${name} names a different port`);
  }

  // copyright — declared once. electron-builder writes
  // NSHumanReadableCopyright from build.copyright unconditionally
  // (macPackager: `appPlist.NSHumanReadableCopyright = appInfo.copyright`)
  // and then deep-assigns extendInfo over it, so the two extendInfo copies
  // were the same string overriding itself in two more places.
  const manifestSource = fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
  assert.equal(
    manifestSource.split(pkg.build.copyright).length - 1,
    1,
    "the copyright is declared once, in build.copyright",
  );
  for (const platform of ["mac", "mas"]) {
    assert.ok(
      !("NSHumanReadableCopyright" in (pkg.build[platform].extendInfo || {})),
      `build.${platform}.extendInfo must not restate the copyright`,
    );
  }
});

test("a later ! pattern excludes what an earlier one included — matching honours order", () => {
  // The whitelist matcher used to discard "!" patterns entirely, so this
  // manifest shape reported every module as packaged while electron-builder
  // shipped none of them.
  const ordered = (files, resolved) => {
    let included = false;
    for (const raw of files) {
      const negated = raw.startsWith("!");
      if (!patternMatches(negated ? raw.slice(1) : raw, resolved)) continue;
      included = !negated;
    }
    return included;
  };
  assert.equal(ordered(["main.js", "accelerator.js"], "accelerator.js"), true);
  assert.equal(ordered(["main.js", "accelerator.js", "!accelerator.js"], "accelerator.js"), false);
  // ...and a positive after a negative wins again.
  assert.equal(ordered(["**/*", "!lib/**", "lib/keep.js"], "lib/keep.js"), true);
  assert.equal(ordered(["**/*", "!lib/**"], "lib/drop.js"), false);

  // The glob subset itself.
  assert.equal(patternMatches("runtime/**/*", "runtime/mac-arm64/python/bin/python3"), true);
  assert.equal(patternMatches("runtime/**/*", "runtimex/a.js"), false);
  assert.equal(patternMatches("*.js", "main.js"), true);
  assert.equal(patternMatches("*.js", "lib/main.js"), false, "* must not cross a separator");
  assert.equal(patternMatches("lib/**", "lib/deep/a.js"), true);
  assert.equal(patternMatches("icon.png", "icon.png"), true);

  // The manifest's own negative pattern still excludes what it names, and
  // still leaves every packaged module included.
  assert.ok(pkg.build.files.includes("!runtime/**/*"), "the runtime exclusion is part of this contract");
  assert.equal(coveredByWhitelist("runtime/mac-arm64/python/bin/python3"), false);
  for (const entry of pkg.build.files) {
    if (entry.startsWith("!") || entry.includes("*")) continue;
    assert.equal(coveredByWhitelist(entry), true, `${entry} is listed but does not match`);
  }
});

test("the READMEs do not promise a signing mode the default build no longer uses", () => {
  // Both READMEs said "builds are ad-hoc signed". Since the signing work
  // landed, afterPack REFUSES to sign ad-hoc unless TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1,
  // which only the dist:adhoc target sets — so the default `./BUILD.command`
  // path is not ad-hoc at all, and a reader deciding whether to trust a
  // build was reading a description of a different build.
  const root = path.join(__dirname, "..");
  const afterPack = fs.readFileSync(path.join(__dirname, "afterPack.js"), "utf8");
  assert.match(afterPack, /TRANSCRIPTOR_ALLOW_ADHOC_SIGN/, "ad-hoc must stay opt-in");
  const adhocTargets = Object.entries(pkg.scripts)
    .filter(([, body]) => body.includes("TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1"))
    .map(([name]) => name);
  assert.deepEqual(adhocTargets.sort(), ["dist:adhoc", "dist:dir:adhoc"]);

  for (const name of ["README.md", "README.en.md"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    const install = source.slice(0, source.indexOf("###"));
    assert.ok(
      !/ad-hoc signed|подписываются ad-hoc/.test(install),
      `${name} still describes the default build as ad-hoc signed`,
    );
  }
});

test("every mac dist script builds screen mode's helper before electron-builder; the App Store one leaves it out", () => {
  // Without the helper the screen hotkey is silently not offered
  // (controller isSupported() is an existsSync), so a script that packs a
  // mac build without build-native.sh ships a DMG that fails no check.
  const macDist = Object.entries(pkg.scripts).filter(([, body]) => /electron-builder --mac(?! mas)/.test(body));
  assert.ok(macDist.length >= 4, "the mac dist scripts are found");
  for (const [name, body] of macDist) {
    const native = body.indexOf("build-native.sh mac-arm64");
    assert.ok(native >= 0 && native < body.indexOf("electron-builder"), `${name} packs a mac build without building the helper first`);
  }
  // dist:mas: build-mas.sh empties the helper directory build.mac's
  // extraResources hand to the merged mas config, before packing.
  const mas = fs.readFileSync(path.join(DESKTOP_DIR, "scripts", "build-mas.sh"), "utf8");
  const emptied = mas.indexOf("rm -rf ./native/build/mac-arm64");
  assert.ok(emptied >= 0 && emptied < mas.indexOf("npx electron-builder --mac mas"));
  assert.doesNotMatch(mas, /^\s*bash \S*build-native\.sh/m);
});

test("the helper's place in the bundle is one fact across build-native.sh, package.json, main.js and afterPack", () => {
  const { SCREEN_INPUT_HELPER_IN_BUNDLE } = require("./scripts/macos-signing-utils");
  const [dirInBundle, name] = [path.dirname(SCREEN_INPUT_HELPER_IN_BUNDLE), path.basename(SCREEN_INPUT_HELPER_IN_BUNDLE)];
  const buildNative = fs.readFileSync(path.join(DESKTOP_DIR, "scripts", "build-native.sh"), "utf8");
  assert.match(buildNative, new RegExp(`-o "\\$OUT_DIR/${name}"`));
  const entry = pkg.build.mac.extraResources.find((e) => e.from === "native/build/mac-${arch}");
  assert.ok(entry, "build.mac.extraResources copies the helper directory");
  assert.equal(path.join("Contents", "Resources", entry.to), dirInBundle);
  const main = fs.readFileSync(path.join(DESKTOP_DIR, "main.js"), "utf8");
  const segments = entry.to.split("/").concat(name).map((s) => `"${s}"`).join(", ");
  assert.ok(main.includes(`path.join(process.resourcesPath, ${segments})`), "main.js runs the helper from where the bundle has it");
});
