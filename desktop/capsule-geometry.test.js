"use strict";

// DM-13 / DM-25 (Ultra-Audit 2026-11-20): the capsule window's size is a
// function of the screen-mode flag (no measured size sent back over
// document.title), and it is placed when it appears or changes size — not
// on every level tick, and not on the cursor's display mid-take.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { capsuleWindowSize, capsuleBoundsIn, capsuleNeedsPlacement } = require("./capsule-geometry");
const { mainSource, topLevelFunctionSource } = require("./main-source");

const CAPSULE = { width: 110, maxWidth: 134, height: 30 };

test("screen mode's wider pill gets a window that fits it from the first frame", () => {
  assert.deepEqual(capsuleWindowSize(CAPSULE, false), { width: 110, height: 30 });
  assert.deepEqual(capsuleWindowSize(CAPSULE, true), { width: 134, height: 30 });
});

test("bounds are centred at the bottom of the work area", () => {
  assert.deepEqual(
    capsuleBoundsIn({ x: 100, y: 0, width: 1000, height: 800 }, { width: 110, height: 30 }, 16),
    { x: 545, y: 754, width: 110, height: 30 },
  );
});

test("a status or level tick of a visible capsule does not move it", () => {
  const size = { width: 110, height: 30 };
  assert.equal(capsuleNeedsPlacement({ visible: true, placedSize: size, size }), false);
  assert.equal(capsuleNeedsPlacement({ visible: false, placedSize: size, size }), true, "appearing");
  assert.equal(capsuleNeedsPlacement({ visible: true, placedSize: null, size }), true);
  assert.equal(capsuleNeedsPlacement({ visible: true, placedSize: size, size: { width: 134, height: 30 } }), true, "resized");
});

test("main.js: no measured-geometry channel, and updates place only when needed", () => {
  assert.doesNotMatch(mainSource, /__recording_capsule_geometry__/);
  assert.doesNotMatch(mainSource, /recordingStatusCapsuleGeometry\b/);
  assert.doesNotMatch(mainSource, /geometryPadding/);
  const update = topLevelFunctionSource("updateRecordingStatusCapsule");
  assert.match(update, /capsuleNeedsPlacement\(\{/);
  assert.doesNotMatch(update, /capsuleWindow\.setBounds\(recordingStatusCapsuleBounds\(\), false\)/);
  assert.match(topLevelFunctionSource("getRecordingStatusCapsuleWindowSize"), /capsuleWindowSize\(RECORDING_STATUS_CAPSULE, !!recordingStatusCapsuleState\.screen\)/);
});
