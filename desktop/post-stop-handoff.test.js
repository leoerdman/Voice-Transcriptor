"use strict";

// DM-15 / S-13 (Ultra-Audit 2026-11-20): the post-stop task has one source
// for "the transcript is ready" — the renderer's recording-final IPC — not
// a second executeJavaScript poll of renderer globals and DOM ids for a
// renderer version that cannot ship with this main process.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { topLevelFunctionSource } = require("./main-source");

test("processPostStopTask reads only the IPC hand-off", () => {
  const fn = topLevelFunctionSource("processPostStopTask");
  assert.ok(fn, "processPostStopTask not found");
  assert.match(fn, /recordingFinalSlot\.peek\(task\.recordingId\)/);
  assert.doesNotMatch(fn, /queryRendererState\(/, "no renderer poll");
  assert.doesNotMatch(fn, /POST_STOP_IPC_GRACE_MS|pollFallbackStarted|heardIpcSignal/);
  assert.doesNotMatch(fn, /state\.status === "Done"|statusLower === "upscaling"/, "no renderer status vocabulary");
  assert.doesNotMatch(fn, /recordingId <= 0/, "no legacy id branch");
});

test("a task with no recording id is refused at admission, not left waiting", () => {
  const fn = topLevelFunctionSource("enqueuePostStopTask");
  assert.match(fn, /if \(!\(task\.recordingId > 0\)\) \{/);
  assert.match(fn, /resetRecordingStatusState\(\)/);
});

test("the renderer snapshot the paste-last lookup reads carries no DOM ids", () => {
  const fn = topLevelFunctionSource("queryRendererState");
  assert.doesNotMatch(fn, /getElementById/);
  assert.doesNotMatch(fn, /__transcriptorFinishedRecords/);
});
