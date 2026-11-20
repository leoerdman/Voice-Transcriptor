"use strict";

// The click-vs-stroke rule of screen mode's native mouse helper
// (desktop/native/screen-input/PressClassifier.swift), run through the
// press sequences a mouse and a trackpad produce — including the trackpad
// double-tap-and-drag, which must draw. Compiles a test binary with
// swiftc, so it runs on macOS with the Command Line Tools (CI's desktop
// job runs there) and skips itself elsewhere.

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

test("PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-input-test-"));
  const bin = path.join(dir, "press-classifier-tests");
  const native = path.join(__dirname, "native");
  const build = spawnSync(
    "xcrun",
    [
      "swiftc",
      "-o", bin,
      path.join(native, "screen-input", "PressClassifier.swift"),
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
  assert.match(run.stdout, /ok double-tap and drag draws/);
  assert.match(run.stdout, /ok a press on our own control is a tap delivered in-process/);
  assert.match(run.stdout, /ok a drag with no press seen still draws/);
  assert.equal(run.stdout.trim().split("\n").length, 11);
});
