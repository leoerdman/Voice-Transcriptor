"use strict";

// DM-14 (Ultra-Audit 2026-11-20), main-side half: the recording-state
// monitor must not queue a new renderer evaluation every tick while the
// previous one is still pending (a wedged renderer would collect an
// unbounded number of them). Its doc must state its real rate.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

test("the monitor keeps at most one renderer probe in flight", () => {
  const fn = topLevelFunctionSource("startRecordingStateMonitor");
  assert.match(fn, /if \(probeInFlight\) return;\s*probeInFlight = true;/);
  assert.match(fn, /\.finally\(\(\) => \{ probeInFlight = false; \}\)/);
});

test("no comment calls the ~5.5 Hz monitor a 1 Hz monitor", () => {
  assert.doesNotMatch(mainSource, /1 Hz (recording-state )?monitor/);
});
