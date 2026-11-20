"use strict";

// FU-13c: main applies the renderer's auto-stop setting and owns no
// default numbers of its own.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { AUTO_STOP_OFF, parseAutoStopConfig } = require("./auto-stop-config");
const { mainSource } = require("./main-source");

test("the renderer's published setting is applied as published", () => {
  assert.deepEqual(parseAutoStopConfig({ enabled: true, seconds: 5, thresholdDb: -50 }), {
    enabled: true,
    seconds: 5,
    thresholdDb: -50,
  });
});

test("no answer, a disabled setting or unusable numbers mean off — not main's own defaults", () => {
  for (const raw of [null, undefined, "x", {}, { enabled: false, seconds: 5, thresholdDb: -50 },
    { enabled: true, seconds: "x", thresholdDb: -42 }, { enabled: true, seconds: 0, thresholdDb: -42 },
    { enabled: true, seconds: 2, thresholdDb: NaN }, { enabled: "true", seconds: 2, thresholdDb: -42 }]) {
    assert.deepEqual(parseAutoStopConfig(raw), AUTO_STOP_OFF, JSON.stringify(raw));
  }
});

test("main.js keeps no copy of the renderer's auto-stop defaults", () => {
  assert.doesNotMatch(mainSource, /DEFAULT_RECORDING_AUTO_STOP_CONFIG/);
  assert.match(mainSource, /parseAutoStopConfig\(/);
});
