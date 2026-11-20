"use strict";

// DM-05 (Ultra-Audit 2026-11-20): a hotkey press the main process gave up
// on must not run when the renderer finally gets to it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const {
  RENDERER_TOGGLE_BUDGET_MS,
  RENDERER_TOGGLE_RETURN_MARGIN_MS,
  toggleNotAfter,
  toggleDispatchScript,
} = require("./renderer-toggle");
const { topLevelFunctionSource } = require("./main-source");

function runInFakeRenderer(script, { now, recording = false }) {
  const dispatched = [];
  const window = {
    __transcriptorLiveStatusSnapshot: () => ({ timerText: "00:01", autoSendEnter: false }),
    __transcriptorIsRecording: recording,
    __transcriptorCurrentRecordingId: recording ? 3 : 0,
    dispatchEvent: (e) => dispatched.push(e),
  };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  const context = {
    window,
    CustomEvent,
    document: { getElementById: () => ({ checked: true }) },
    Date: { now: () => now },
  };
  const result = vm.runInNewContext(script, context);
  return { result, dispatched };
}

test("a press run in time is dispatched", () => {
  const script = toggleDispatchScript({ allowStart: true, notAfter: 10_000 });
  const { result, dispatched } = runInFakeRenderer(script, { now: 9_000 });
  assert.equal(result.dispatched, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "transcriptor-hotkey-toggle");
});

test("a press the renderer reaches after its deadline does nothing", () => {
  const script = toggleDispatchScript({ allowStart: true, notAfter: 10_000 });
  for (const recording of [false, true]) {
    const { result, dispatched } = runInFakeRenderer(script, { now: 10_001, recording });
    assert.equal(result.expired, true);
    assert.equal(result.dispatched, false);
    assert.equal(dispatched.length, 0, "an expired press must neither start nor stop a recording");
  }
});

test("the deadline leaves the answer time to travel back inside main's budget", () => {
  assert.equal(toggleNotAfter(1_000), 1_000 + RENDERER_TOGGLE_BUDGET_MS - RENDERER_TOGGLE_RETURN_MARGIN_MS);
  assert.ok(RENDERER_TOGGLE_RETURN_MARGIN_MS > 0 && RENDERER_TOGGLE_RETURN_MARGIN_MS < RENDERER_TOGGLE_BUDGET_MS);
});

test("main.js dispatches the press through ./renderer-toggle with the same budget", () => {
  const fn = topLevelFunctionSource("dispatchRendererTogglePress");
  assert.match(fn, /toggleDispatchScript\(\{ allowStart, startDetail, notAfter: toggleNotAfter\(\) \}\)/);
  assert.match(fn, /RENDERER_TOGGLE_BUDGET_MS/);
});
