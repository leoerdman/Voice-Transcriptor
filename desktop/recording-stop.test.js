"use strict";

// DM-03 / DM-22 (Ultra-Audit 2026-11-20): a renderer that does not answer
// is still recording, and a recording that goes on keeps its paste target.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { STOP_ACTION, decideMainProcessStop } = require("./recording-stop");
const { topLevelFunctionSource } = require("./main-source");

test("no answer to the state probe keeps the recording, its monitor and its paste target", () => {
  const d = decideMainProcessStop({ snapshot: null });
  assert.equal(d.action, STOP_ACTION.KEEP_RECORDING);
  assert.equal(d.keepsPasteTarget, true);
});

test("a stale stop keeps the recording and its paste target", () => {
  const d = decideMainProcessStop({
    snapshot: { recording: true, recordingId: 4 },
    result: { ok: false, recording: true, stale: true, recordingId: 5, expectedRecordingId: 4 },
  });
  assert.equal(d.action, STOP_ACTION.KEEP_RECORDING);
  assert.equal(d.keepsPasteTarget, true);
});

test("the paths that end the session clear the paste target", () => {
  const rec = { recording: true, recordingId: 4 };
  assert.deepEqual(
    [
      decideMainProcessStop({ snapshot: { recording: false, recordingId: 0 } }),
      decideMainProcessStop({ snapshot: rec, result: null }),
      decideMainProcessStop({ snapshot: rec, result: { ok: true, auto: true, recordingId: 4 } }),
      decideMainProcessStop({ snapshot: rec, result: { ok: true, auto: false, recordingId: 4 } }),
      decideMainProcessStop({ snapshot: rec, result: { ok: false, recording: false } }),
    ].map((d) => [d.action, d.keepsPasteTarget]),
    [
      [STOP_ACTION.SAVED, false],
      [STOP_ACTION.UNCONFIRMED, false],
      [STOP_ACTION.ENQUEUE, false],
      [STOP_ACTION.SAVED, false],
      [STOP_ACTION.SAVED, false],
    ],
  );
});

test("main.js: the state probe reports silence as null and the stop decides through ./recording-stop", () => {
  const probe = topLevelFunctionSource("queryRendererRecordingState");
  assert.doesNotMatch(probe, /\{ recording: false, recordingId: 0 \}/, "no answer must not be read as idle");
  const stop = topLevelFunctionSource("stopRecordingFromMainProcess");
  assert.match(stop, /decideMainProcessStop\(\{ snapshot, result \}\)/);
  assert.doesNotMatch(stop, /queryRendererRecordingState\(\)\.catch/);
  assert.match(stop, /if \(!decision\?\.keepsPasteTarget\) clearCapturedPasteTarget\(\)/);
});
