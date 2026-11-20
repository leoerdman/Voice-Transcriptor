"use strict";

// DM-01 (Ultra-Audit 2026-11-20): the paste gate decided "transcript or
// status" by looking inside the user's own words. These cases are the
// dictations it used to throw away, plus the explicit-field rules that
// replace the sniffing, plus a check that main.js decides through this
// module and nowhere else.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  NO_SPEECH_STATUS,
  SIGNAL_OUTCOME,
  isPasteableTranscript,
  isNoSpeechPlaceholder,
  classifyRecordingSignal,
} = require("./transcript-signal");

const { mainSource, topLevelFunctionSource } = require("./main-source");

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
    const verdict = classifyRecordingSignal({ final: true, text, kind: "transcript" });
    assert.equal(verdict.outcome, SIGNAL_OUTCOME.FINAL, text);
    assert.equal(verdict.text, text);
    assert.equal(isPasteableTranscript(text), true, text);
  }
});

test("the pre-upscale publish is best-known text, whatever words it contains", () => {
  for (const text of DICTATIONS_THAT_LOOK_LIKE_STATUSES) {
    const verdict = classifyRecordingSignal({ final: false, text, kind: "status", phase: "upscaling" });
    assert.equal(verdict.outcome, SIGNAL_OUTCOME.PROVISIONAL, text);
    assert.equal(verdict.text, text);
  }
});

test("no-speech is read from the phase or an exact placeholder, never from a substring", () => {
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: NO_SPEECH_STATUS, kind: "status", phase: "no-speech" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: NO_SPEECH_STATUS, upscaling: false },
  );
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: "[ Silence ]", kind: "status" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: NO_SPEECH_STATUS, upscaling: false },
  );
  assert.equal(isNoSpeechPlaceholder("[silence]"), true);
  assert.equal(isNoSpeechPlaceholder("[No speech captured]"), true);
  assert.equal(isNoSpeechPlaceholder("the room was silent, silence detected twice"), false);
  // A final carrying only a placeholder is not something to paste.
  assert.equal(
    classifyRecordingSignal({ final: true, text: "[ silence ]", kind: "transcript" }).outcome,
    SIGNAL_OUTCOME.TERMINAL,
  );
  assert.equal(classifyRecordingSignal({ final: true, text: "  ", kind: "transcript" }).outcome, SIGNAL_OUTCOME.TERMINAL);
});

test("a status or error publish ends the recording and its text is the status", () => {
  const off = "Auto transcribe is off. Audio was saved locally and is ready to review.";
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: off, kind: "status" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: off, upscaling: false },
  );
  assert.deepEqual(
    classifyRecordingSignal({ final: false, text: "Transcription failed.", kind: "error" }),
    { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: "Transcription failed.", upscaling: false },
  );
});

test("a transcript-kind publish the renderer did not mark final is waited past, not dropped", () => {
  const verdict = classifyRecordingSignal({ final: false, text: "HTTP 500 again", kind: "transcript" });
  assert.equal(verdict.outcome, SIGNAL_OUTCOME.PROVISIONAL);
  // Not the upscale phase: the capsule is not told it is upscaling.
  assert.equal(verdict.upscaling, false);
});

test("the pre-upscale publish puts the capsule in Upscaling; nothing else does", () => {
  assert.equal(classifyRecordingSignal({ final: false, text: "hello there", kind: "status", phase: "upscaling" }).upscaling, true);
  // An upscale phase with nothing to paste is an ending, not an upscale.
  assert.equal(classifyRecordingSignal({ final: false, text: "  ", kind: "status", phase: "upscaling" }).upscaling, false);
  assert.equal(classifyRecordingSignal({ final: true, text: "hello there", kind: "transcript", phase: "upscaling" }).upscaling, false);
  assert.equal(classifyRecordingSignal({ final: false, text: "Transcription failed.", kind: "error" }).upscaling, false);
});

test("main.js moves the capsule to Upscaling on the verdict that says so (wiring)", () => {
  // That every handled signal reaches onSignal with its verdict is
  // behaviour-tested in post-stop-handoff.test.js; what onSignal does
  // with it is main.js's.
  const onSignal = /onSignal: \(signal, verdict\) => \{([\s\S]*?)\n {4}\},/.exec(topLevelFunctionSource("processPostStopTask"))?.[1];
  assert.ok(onSignal, "processPostStopTask's onSignal not found in main.js");
  assert.match(
    onSignal,
    /if \(verdict\.upscaling\) \{\s*void setRecordingStatus\("Upscaling", RECORDING_STATUS_KIND\.UPSCALING\)/,
  );
});

test("kind and phase are read from their own fields, not from a label", () => {
  // A label that merely looks like "status:upscaling" is not the phase.
  assert.equal(classifyRecordingSignal({ final: false, text: "hello there", source: "status:upscaling" }).upscaling, false);
  assert.equal(classifyRecordingSignal({ final: false, text: "hello there", kind: "status", phase: "upscaling" }).upscaling, true);
});

test("main.js classifies hand-off signals through ./transcript-signal and sniffs no text", () => {
  // The post-stop wait classifies through ./transcript-signal
  // (post-stop-handoff.test.js runs it on a text that looks like an error).
  assert.match(mainSource, /require\("\.\/post-stop-handoff"\)/);
  assert.doesNotMatch(mainSource, /function isMeaningfulTranscriptText/);
  assert.doesNotMatch(mainSource, /startsWith\("http "\)/);
  assert.doesNotMatch(mainSource, /startsWith\("network error"\)/);
  assert.doesNotMatch(mainSource, /includes\("silence detected"\)/);
  assert.doesNotMatch(mainSource, /includes\("no speech detected"\)/);
});

test("the pasted text keeps its line breaks; only the ends are trimmed (2026-11-21: a screen take pasted as one line)", () => {
  const take = "Диктовка с рисованием по экрану · 1 скрин\nКак читать: …\n\n### Скрин 1 · 00:00–00:05 · shot-01-preview.jpg\nШтрихи: 1 — 40–60% × 40–60%\nВот [✏️1 красный, в центре] это [/1]\n\n### После последнего скрина\nвсё";
  const verdict = classifyRecordingSignal({ final: true, kind: "transcript", text: `\n ${take}\r\n` });
  assert.equal(verdict.outcome, SIGNAL_OUTCOME.FINAL);
  assert.equal(verdict.text, take);
  // Placeholders are still recognised across odd whitespace.
  assert.equal(classifyRecordingSignal({ final: true, kind: "transcript", text: "[ \n silence ]" }).outcome, SIGNAL_OUTCOME.TERMINAL);
});

test("main.js hands the user the paste text, not the comparison form", () => {
  for (const name of ["handlePostStopTranscriptTimeout", "getLatestTranscriptText"]) {
    const src = topLevelFunctionSource(name);
    assert.match(src, /pasteTranscriptText\(/, name);
    assert.doesNotMatch(src, /normalizeTranscriptText\(/, name);
  }
});
