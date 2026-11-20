#!/usr/bin/env node
"use strict";

// Refuse to install a bundle whose signature cannot carry the user's
// permissions forward.
//
//   node desktop/scripts/check-designated-requirement.js <path to .app>
//
// macOS keys every TCC grant (Accessibility, Automation, Microphone) to
// the bundle id AND the designated requirement of the signature that
// earned it. Installing a bundle with a different requirement over one
// the user has already granted leaves the row switched ON in System
// Settings and the app refused in practice — Apple Events come back
// "Not authorized to send Apple events" (-1743) — with nothing on screen
// to explain it. An ad-hoc signature guarantees that outcome on EVERY
// rebuild, because its requirement is a cdhash of one exact build.
//
// The decision is `designatedRequirementIsStable` in
// ./macos-signing-utils.js (pure, tested by desktop/signing.test.js);
// this script is the two side effects it needs: read the signature, read
// the bundle id.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { designatedRequirementIsStable } = require("./macos-signing-utils");
const { parseBundleIdentity } = require("../paste-capability");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const appPath = process.argv[2];
if (!appPath) fail("usage: check-designated-requirement.js <path to .app>");
if (!fs.existsSync(appPath)) fail(`check-designated-requirement: no such bundle: ${appPath}`);

let bundleId = "";
try {
  bundleId = parseBundleIdentity(
    fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8"),
  ).bundleId;
} catch (e) {
  fail(`check-designated-requirement: cannot read ${appPath}/Contents/Info.plist: ${e?.message || e}`);
}
if (!bundleId) fail(`check-designated-requirement: ${appPath} declares no CFBundleIdentifier`);

// One read, no shell: the requirement is printed on stdout and the
// diagnosis (unsigned, unreadable) on stderr, so both streams are kept
// and handed to the decision as one text.
const read = spawnSync("/usr/bin/codesign", ["-d", "--requirements", "-", appPath], { encoding: "utf8" });
if (read.error) fail(`check-designated-requirement: cannot run codesign: ${read.error.message}`);
const requirements = `${read.stdout || ""}\n${read.stderr || ""}`;

const verdict = designatedRequirementIsStable(requirements, bundleId);
if (!verdict.ok) {
  fail(
    `Refusing to install ${appPath}: ${verdict.reason}\n` +
      "Every macOS permission the user has granted Transcriptor would stop working, " +
      "while System Settings kept showing it as granted.\n" +
      "Build with the same signing certificate every time " +
      "(TRANSCRIPTOR_SIGNING_IDENTITY), and never install a TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 build.",
  );
}
process.stdout.write(
  `Designated requirement binds identifier "${bundleId}" to a certificate: ` +
    "granted permissions survive this install.\n",
);
