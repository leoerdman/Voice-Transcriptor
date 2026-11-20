"use strict";

// DM-31 (Ultra-Audit 2026-11-20), main-side half of S-02 / DX-03: a screen
// session that finishes starting after its take already ended is ended at
// once, and a failed start is told to the user.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { AFTER_SCREEN_START, decideAfterScreenStart } = require("./screen-session-start");
const { topLevelFunctionSource } = require("./main-source");

test("a take that ended while its session was starting leaves an orphan to end", () => {
  assert.equal(
    decideAfterScreenStart({ started: { ok: true }, renderer: { recording: false, recordingId: 0 }, recordingId: 4 }),
    AFTER_SCREEN_START.END_ORPHAN,
  );
  assert.equal(
    decideAfterScreenStart({ started: { ok: true }, renderer: { recording: true, recordingId: 5 }, recordingId: 4 }),
    AFTER_SCREEN_START.END_ORPHAN,
    "a different take is recording now",
  );
});

test("the live take keeps its session; a silent renderer is not evidence of a stop", () => {
  assert.equal(
    decideAfterScreenStart({ started: { ok: true }, renderer: { recording: true, recordingId: 4 }, recordingId: 4 }),
    AFTER_SCREEN_START.KEEP,
  );
  assert.equal(decideAfterScreenStart({ started: { ok: true }, renderer: null, recordingId: 4 }), AFTER_SCREEN_START.KEEP);
});

test("a failed start is reported", () => {
  assert.equal(decideAfterScreenStart({ started: { ok: false, error: "x" }, renderer: null, recordingId: 4 }), AFTER_SCREEN_START.FAILED);
  assert.equal(decideAfterScreenStart({ started: null, renderer: null, recordingId: 4 }), AFTER_SCREEN_START.FAILED);
});

test("main.js reconciles the session after start and surfaces a failed start", () => {
  const fn = topLevelFunctionSource("toggleRecordingFromShortcut");
  assert.match(fn, /decideAfterScreenStart\(\{/);
  assert.match(fn, /AFTER_SCREEN_START\.END_ORPHAN && screenMode\.isActive\(\)/);
  assert.match(fn, /notifyScreenModeWarning\("start-failed"\)/);
});
