"use strict";

// What main does with screenMode.start()'s answer (DM-31, S-02 / S-04,
// review D2 / D3): a live session is kept; a take whose stop got there
// first is a normal outcome, not a failure; a failed start makes the take
// a voice take — and main never notifies on its own (the controller owns
// that notification).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SCREEN_START_OUTCOME } = require("./screen-mode-controller");
const { AFTER_SCREEN_START, decideAfterScreenStart } = require("./screen-session-start");
const { topLevelFunctionSource } = require("./main-source");

test("a started session is kept", () => {
  assert.equal(
    decideAfterScreenStart({ ok: true, outcome: SCREEN_START_OUTCOME.STARTED, id: "x" }),
    AFTER_SCREEN_START.KEEP,
  );
});

test("a take that ended before its session started is ENDED, not a failure (D3)", () => {
  assert.equal(decideAfterScreenStart({ ok: false, outcome: SCREEN_START_OUTCOME.ENDED }), AFTER_SCREEN_START.ENDED);
});

test("a failed start makes the take a voice take (S-04)", () => {
  assert.equal(
    decideAfterScreenStart({ ok: false, outcome: SCREEN_START_OUTCOME.FAILED, error: "helper exited" }),
    AFTER_SCREEN_START.VOICE_TAKE,
  );
});

test("an answer that is not a start is never mistaken for a live session", () => {
  for (const started of [null, undefined, {}, { ok: true }, { outcome: SCREEN_START_OUTCOME.STARTED }, "started"]) {
    assert.equal(decideAfterScreenStart(started), AFTER_SCREEN_START.VOICE_TAKE, JSON.stringify(started));
  }
});

// Wiring in main.js (a live Electron is needed to drive it, so the source
// is read — only for which names are called, and in which order).
test("main starts the session before the awaits that used to delay it, and reads the answer after (S-02)", () => {
  const fn = topLevelFunctionSource("toggleRecordingFromShortcut");
  const startAt = fn.indexOf("screenMode.start(startDetail.screenSessionId)");
  assert.ok(startAt > 0, "toggleRecordingFromShortcut starts the screen session");
  assert.ok(startAt < fn.indexOf("await frontAtHotkeyPromise"), "start() waits behind the frontmost-app lookup");
  assert.ok(startAt < fn.indexOf("await beginRecordingStatusSession()"), "start() waits behind the capsule session");
  assert.match(fn, /decideAfterScreenStart\(started\)/);
  assert.match(fn, /AFTER_SCREEN_START\.VOICE_TAKE\) notifyRendererVoiceTake\(/);
});

test("main does not notify a failed start itself, nor re-ask the renderer about an ended take (D2 / D3)", () => {
  const fn = topLevelFunctionSource("toggleRecordingFromShortcut");
  assert.doesNotMatch(fn, /notifyScreenModeWarning\(/);
  assert.doesNotMatch(fn, /END_ORPHAN/);
});

test("a lost renderer retires its take by id, live session or not (DM-31)", () => {
  const fn = topLevelFunctionSource("endScreenModeForLostRenderer");
  assert.match(fn, /screenMode\.finish\(\{ id, discard: false \}\)/);
  assert.doesNotMatch(fn, /isActive\(\)/, "a session still starting is not active yet, and must be retired too");
});
