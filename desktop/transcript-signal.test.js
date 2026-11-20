"use strict";

// DM-01 (Ultra-Audit 2026-11-20): the paste gate decided "transcript or
// status" by looking inside the user's own words. These cases are the
// dictations it used to throw away, plus the explicit-field rules that
// replace the sniffing, plus a check that main.js decides through this
// module and nowhere else.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  NO_SPEECH_STATUS,
  SIGNAL_OUTCOME,
  isPasteableTranscript,
  isNoSpeechPlaceholder,
  parseSignalSource,
  classifyRecordingSignal,
} = require("./transcript-signal");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

const DICTATIONS_THAT_LOOK_LIKE_STATUSES = [
  "HTTP server returns 500 when the cache is cold",
  "http requests time out after thirty seconds",
  "Network error handling is flaky in the client",
  "The log says silence detected even though I was talking",
  "If no speech detected appears again, restart the device",
  "Nothing in the no speech captured branch is reachable",
];

test("a final transcript is pasted whatever words it contains", () => {
  for (const text of DICTATIONS_THAT_LOOK_LIKE_STATUSES) {
    const verdict = classifyRecordingSignal({ final: true, text, source: "transcript" });
    assert.equal(verdict.outcome, SIGNAL_OUTCOME.FINAL, text);
    assert.equal(verdict.text, text);
    assert.equal(isPasteableTranscript(text), true, text);
  }
});

test("the pre-upscale publish is best-known text, whatever words it contains", () => {
  for (const text of DICTATIONS_THAT_LOOK_LIKE_STATUSES) {
    const verdict = classifyRecordingSignal({ final: false, text, source: "status:upscaling" });
    assert.equal(verdict.outcome, SIGNAL_OUTCOME.PROVISIONAL, text);
    assert.equal(verdict.text, text);
  }
});

test("no-speech is read from the phase or an exact placeholder, never from a substring", () => {
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: NO_SPEECH_STATUS, source: "status:no-speech" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: NO_SPEECH_STATUS },
  );
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: "[ Silence ]", source: "status" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: NO_SPEECH_STATUS },
  );
  assert.equal(isNoSpeechPlaceholder("[silence]"), true);
  assert.equal(isNoSpeechPlaceholder("[No speech captured]"), true);
  assert.equal(isNoSpeechPlaceholder("the room was silent, silence detected twice"), false);
  // A final carrying only a placeholder is not something to paste.
  assert.equal(
    classifyRecordingSignal({ final: true, text: "[ silence ]", source: "transcript" }).outcome,
    SIGNAL_OUTCOME.TERMINAL,
  );
  assert.equal(classifyRecordingSignal({ final: true, text: "  ", source: "transcript" }).outcome, SIGNAL_OUTCOME.TERMINAL);
});

test("a status or error publish ends the recording and its text is the status", () => {
  const off = "Auto transcribe is off. Audio was saved locally and is ready to review.";
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: off, source: "status" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: off },
  );
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: "Transcription failed.", source: "error" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: "Transcription failed." },
  );
});

test("a transcript-kind publish the renderer did not mark final is waited past, not dropped", () => {
  const verdict = classifyRecordingSignal({ final: false, text: "HTTP 500 again", source: "transcript" });
  assert.equal(verdict.outcome, SIGNAL_OUTCOME.PROVISIONAL);
});

test("the source label splits into kind and phase", () => {
  assert.deepEqual(parseSignalSource("status:upscaling"), { kind: "status", phase: "upscaling" });
  assert.deepEqual(parseSignalSource("Transcript"), { kind: "transcript", phase: "" });
  assert.deepEqual(parseSignalSource(undefined), { kind: "", phase: "" });
});

test("main.js classifies hand-off signals through ./transcript-signal and sniffs no text", () => {
  assert.match(mainSource, /require\("\.\/transcript-signal"\)/);
  assert.match(mainSource, /classifyRecordingSignal\(signal\)/);
  assert.doesNotMatch(mainSource, /function isMeaningfulTranscriptText/);
  assert.doesNotMatch(mainSource, /startsWith\("http "\)/);
  assert.doesNotMatch(mainSource, /startsWith\("network error"\)/);
  assert.doesNotMatch(mainSource, /includes\("silence detected"\)/);
  assert.doesNotMatch(mainSource, /includes\("no speech detected"\)/);
});
