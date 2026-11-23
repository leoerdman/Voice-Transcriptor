"use strict";

// The window's HTTP cache is capped before `ready` (it held 746 MB of
// recording audio on 2026-11-23). main.js cannot be required outside
// Electron, so the wiring is checked in its source.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mainSource } = require("./main-source");

test("the HTTP disk cache is capped at module load, before the single-instance lock", () => {
  const cap = mainSource.indexOf('app.commandLine.appendSwitch("disk-cache-size"');
  const lock = mainSource.indexOf("app.requestSingleInstanceLock()");
  assert.ok(cap > 0, "disk-cache-size switch is set");
  assert.ok(cap < lock, "the switch is set before the app can reach ready");
  const m = /const HTTP_DISK_CACHE_MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(mainSource);
  assert.ok(m, "the cap is one named constant");
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 128, "the cap is a small bound, in MB");
});
