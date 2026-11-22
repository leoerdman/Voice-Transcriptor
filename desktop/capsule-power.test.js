"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCapsulePower, capsulePressMetricLine } = require("./capsule-power");
const { mainSource, topLevelFunctionSource } = require("./main-source");

function fakeWindow() {
  const calls = [];
  return {
    calls,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    hide() { calls.push("hide"); },
    webContents: { setBackgroundThrottling(on) { calls.push(`throttle:${on}`); } },
  };
}

test("asleep hides the window and turns throttling on; awake turns it off", () => {
  const power = createCapsulePower();
  const w = fakeWindow();
  power.sleep(w);
  power.awake(w);
  assert.deepEqual(w.calls, ["hide", "throttle:true", "throttle:false"]);
});

test("a destroyed or missing window is left alone", () => {
  const power = createCapsulePower();
  const w = fakeWindow();
  w.destroyed = true;
  power.sleep(w);
  power.awake(w);
  power.sleep(null);
  assert.deepEqual(w.calls, []);
});

test("a throttling failure is logged and does not stop the hide", () => {
  const logs = [];
  const power = createCapsulePower({ log: (l) => logs.push(l) });
  const w = fakeWindow();
  w.webContents.setBackgroundThrottling = () => { throw new Error("boom"); };
  power.sleep(w);
  assert.deepEqual(w.calls, ["hide"]);
  assert.match(logs[0], /throttling=true failed: boom/);
});

test("the press metric is one line, and absent without a press time", () => {
  assert.equal(
    capsulePressMetricLine({ pressedAt: 1000, now: 1085, status: "Starting" }),
    '[recording-capsule] press_to_capsule_visible_ms=85 status="Starting"',
  );
  assert.equal(capsulePressMetricLine({ pressedAt: 0, now: 5, status: "x" }), "");
});

test("main.js keeps the capsule window instead of tearing it down on a timer", () => {
  assert.doesNotMatch(mainSource, /RECORDING_STATUS_CAPSULE_TEARDOWN_MS/);
  assert.doesNotMatch(mainSource, /scheduleRecordingStatusCapsuleTeardown/);
  assert.match(topLevelFunctionSource("hideRecordingStatusCapsule"), /capsulePower\.sleep\(/);
  assert.match(topLevelFunctionSource("revealRecordingStatusCapsule"), /capsulePower\.awake\(/);
});
