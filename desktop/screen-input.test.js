"use strict";

// Screen mode's native mouse helper (desktop/native/screen-input/).
//
//   * The click-vs-stroke rule (PressClassifier.swift), run through the
//     press sequences a mouse and a trackpad produce — including the
//     trackpad double-tap-and-drag, which must draw, and a tap macOS
//     switches off in the middle of a press.
//   * The whole helper (main.swift: the event tap and its protocol),
//     type-checked with the rule, so a compile error or a CoreGraphics API
//     drift fails here instead of on a release day in build-native.sh.
//
// Both need swiftc, so they run on macOS with the Command Line Tools (CI's
// desktop job runs there) and skip themselves elsewhere.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const swiftc = process.platform === "darwin"
  ? spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" })
  : { status: 1 };
const skip = swiftc.status !== 0 ? "swiftc is not available (macOS + Command Line Tools only)" : false;

const native = path.join(__dirname, "native");
const classifierSource = path.join(native, "screen-input", "PressClassifier.swift");
const helperSource = path.join(native, "screen-input", "main.swift");

// Every case the Swift suite must run, by name. A case that disappears or
// stops printing fails here; a new case is added to this list on purpose.
const CASES = [
  "a click is replayed to the app underneath",
  "a jitter under the threshold is still a click",
  "press and drag is a stroke from the press point",
  "double-tap and drag draws",
  "a double-click without moving stays two clicks",
  "a press on our own control is a tap delivered in-process",
  "a jitter on a control is still a tap",
  "a press that wanders off a control taps nothing",
  "a drag that ends on a control is still a stroke",
  "a drag with no press seen still draws, and its release passes on",
  "a replayed click that comes back re-posted is passed, not pressed again",
  "a release with no press seen passes",
  "a stray release after a click reports no second outcome",
  "a tap switched off mid-stroke ends the stroke and the next drag draws",
  "a held press whose release went past the tap is handed over",
  "a held press still down passes through to its release",
  "a press on a control cut by the tap taps nothing",
  "an idle tap switched off abandons nothing",
];

test("PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process, a switched-off tap abandons its press", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-input-test-"));
  const bin = path.join(dir, "press-classifier-tests");
  const build = spawnSync(
    "xcrun",
    [
      "swiftc",
      "-o", bin,
      classifierSource,
      // The suite's entry point: Swift allows top-level code only in a
      // file named main.swift when several files are compiled together.
      path.join(native, "tests", "press-classifier", "main.swift"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(bin, [], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  const ran = run.stdout.trim().split("\n").map((line) => line.replace(/^ok /, ""));
  assert.deepEqual(ran, CASES);
});

test("the helper (event tap + protocol) compiles with the rule it ships", { skip }, () => {
  const check = spawnSync("xcrun", ["swiftc", "-typecheck", classifierSource, helperSource], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
