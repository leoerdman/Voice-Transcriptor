"use strict";

// Real-Electron probe for ./window-liveness, with its negative control.
// Kills the page process with `webContents.forcefullyCrashRenderer()` while
// the page's backend is down (the 2026-11-21 incident), then brings the
// backend back:
//   - with the owner watching, the page loads again and paints;
//   - without it (PROBE_NO_RECOVERY=1), the window stays dead — the probe
//     must be red, or it proves nothing.
// Needs a display; runs on macOS (the CI desktop job) and skips elsewhere.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const fixture = path.join(__dirname, "test-fixtures", "renderer-recovery", "main.js");

function electronBinary() {
  try {
    const bin = require("electron");
    return typeof bin === "string" ? bin : "";
  } catch {
    return "";
  }
}

const bin = electronBinary();
const skip = process.platform !== "darwin" ? "needs the macOS window server" : !bin ? "electron is not installed" : false;

function runProbe(env = {}) {
  const r = spawnSync(bin, [fixture], {
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "", ...env },
    encoding: "utf8",
    timeout: 30000,
  });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("PROBE "));
  assert.ok(line, `probe printed no verdict (status=${r.status} signal=${r.signal})\n${r.stderr}`);
  return JSON.parse(line.slice("PROBE ".length));
}

test("a crashed page is loaded again once its backend serves, and paints", { skip }, () => {
  const v = runProbe();
  assert.equal(v.ok, true, JSON.stringify(v, null, 2));
  assert.equal(v.restored, true);
  assert.equal(v.painted, true);
  assert.equal(v.loadsWhileDown, 0, "never loaded against the dead backend");
});

test("the renderer's loss arriving before the backend's exit still ends in a painted page", { skip }, () => {
  const v = runProbe({ PROBE_LATE_BACKEND_EXIT: "1" });
  assert.equal(v.ok, true, JSON.stringify(v, null, 2));
  assert.equal(v.painted, true);
});

test("negative control: without the owner the crashed page stays dead", { skip }, () => {
  const v = runProbe({ PROBE_NO_RECOVERY: "1", PROBE_VERDICT_MS: "4000" });
  assert.equal(v.ok, false, JSON.stringify(v, null, 2));
  assert.equal(v.restored, false);
});
