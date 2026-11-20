"use strict";

// Executable specification for the recording-capsule status SSOT.
//
// The point of this file is the table at the bottom: every status string
// either process actually produces, with the state it must be drawn as.
// There was no such test, and that is how two independent substring
// ladders — one for the mode, one for the tone — drifted into
// classifying the same string two different ways, and how terminal
// errors ended up drawn as work still in progress.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  RECORDING_STATUS_KIND: K,
  RECORDING_STATUS_PRESENTATION,
  RENDERER_STATUS_VOCABULARY,
  classifyRecordingStatusText,
  isRecordingStatusKind,
  recordingStatusPresentation,
  recordingStatusIsLive,
} = require("./recording-status");

test("mode and tone are two views of one value and cannot disagree", () => {
  for (const kind of Object.values(K)) {
    const p = RECORDING_STATUS_PRESENTATION[kind];
    assert.ok(p, `${kind} has no presentation`);
    assert.equal(typeof p.mode, "string");
    assert.equal(typeof p.tone, "string");
  }
  // The specific disagreements the two ladders had accumulated: a status
  // that was a failure by mode and a warning by tone, and one that was a
  // recording by mode with a neutral tone.
  assert.equal(RECORDING_STATUS_PRESENTATION[K.FAIL].tone, "error");
  assert.equal(RECORDING_STATUS_PRESENTATION[K.WARN].mode, "fail");
  assert.equal(RECORDING_STATUS_PRESENTATION[K.WARN].tone, "warning");
  assert.equal(RECORDING_STATUS_PRESENTATION[K.STARTING].tone, "recording");
});

test("the timer and waveform run for exactly the live kinds", () => {
  // "autostop" is live: the take is still running, the countdown can be
  // cancelled by speaking. That is why the capsule keeps its timer.
  assert.equal(recordingStatusIsLive(K.RECORDING), true);
  assert.equal(recordingStatusIsLive(K.STARTING), true);
  assert.equal(recordingStatusIsLive(K.AUTOSTOP), true);
  for (const kind of [K.IDLE, K.TRANSCRIBING, K.UPSCALING, K.OK, K.WARN, K.FAIL]) {
    assert.equal(recordingStatusIsLive(kind), false, kind);
  }
});

test("an explicit kind wins over the text; an invalid one falls back to it", () => {
  // The whole point: a producer that knows what state it is in is not
  // second-guessed by a substring match on its own wording.
  assert.equal(recordingStatusPresentation("Mic Not Started", K.FAIL).kind, K.FAIL);
  assert.equal(recordingStatusPresentation("anything at all", K.OK).mode, "ok");
  assert.equal(recordingStatusPresentation("Recording", "not-a-kind").kind, K.RECORDING);
  assert.equal(recordingStatusPresentation("Recording", "").kind, K.RECORDING);
  assert.equal(isRecordingStatusKind("nope"), false);
  assert.equal(isRecordingStatusKind(K.AUTOSTOP), true);
});

test("the renderer's own status copy classifies correctly", () => {
  // The renderer sends TEXT, so its UI copywriting is a de-facto input to
  // the capsule. Listing it here is what makes that coupling visible.
  for (const { text, kind } of RENDERER_STATUS_VOCABULARY) {
    assert.equal(classifyRecordingStatusText(text), kind, text);
  }
});

test("the renderer's status strings still exist in the renderer", () => {
  // If someone rewords one of these in frontend/src/main.tsx, the capsule
  // silently repaints. Fail here instead, so the vocabulary above is
  // updated deliberately.
  const rendererPath = path.join(__dirname, "..", "frontend", "src", "main.tsx");
  if (!fs.existsSync(rendererPath)) return; // desktop-only checkout
  const source = fs.readFileSync(rendererPath, "utf8");
  for (const { text, rendererSource } of RENDERER_STATUS_VOCABULARY) {
    assert.ok(
      source.includes(rendererSource || text),
      `frontend/src/main.tsx no longer contains "${text}" — update RENDERER_STATUS_VOCABULARY ` +
      "and check the capsule still classifies the new wording",
    );
  }
});

test("every status the main process produces gets the state it means", () => {
  // These are the exact strings desktop/main.js publishes. The kinds are
  // now passed explicitly at each call site; this table is the record of
  // what each one MEANS, and of the eight cases the old ladders got
  // wrong (marked).
  const cases = [
    ["", K.IDLE],
    ["Recording", K.RECORDING],
    ["Starting", K.STARTING],                    // was: recording mode, NEUTRAL tone
    ["Auto stop in 3s", K.AUTOSTOP],             // was: unreachable — nothing produced it
    ["Transcribing", K.TRANSCRIBING],
    ["Upscaling", K.UPSCALING],
    ["Pasting", K.TRANSCRIBING],                 // was: transcribing mode, neutral tone
    ["Pasted", K.OK],
    ["Paste Sent", K.OK],
    ["Sent", K.OK],
    ["Saved To App", K.OK],
    ["Recording completed, no speech detected.", K.OK],
    ["App Loading", K.WARN],                     // was: fail mode + warning tone
    ["Grant Access", K.WARN],                    // was: fail mode + warning tone
    ["App Not Ready", K.WARN],                   // was: TRANSCRIBING mode (a default)
    ["Mic Not Started", K.FAIL],                 // was: TRANSCRIBING mode, neutral tone
    ["No Text", K.FAIL],
    ["In Clipboard", K.WARN],
    ["In Clipboard · Accessibility", K.WARN],
    ["In Clipboard · Automation", K.WARN],
    ["In Clipboard · No Focus", K.WARN],
    ["Clipboard Error", K.WARN],
    ["Send Failed", K.FAIL],
    ["Send Failed · Automation", K.FAIL],
    ["Send Failed · No Focus", K.FAIL],
    ["Timed out, but transcript is on your clipboard.", K.WARN],
    ["Timed out with no transcript to recover.", K.FAIL],
  ];
  for (const [text, kind] of cases) {
    assert.equal(classifyRecordingStatusText(text), kind, JSON.stringify(text));
  }
});

test("an unrecognised status is treated as work in progress, not as a verdict", () => {
  assert.equal(classifyRecordingStatusText("something nobody wrote yet"), K.TRANSCRIBING);
  assert.equal(classifyRecordingStatusText(null), K.IDLE);
  assert.equal(classifyRecordingStatusText("   "), K.IDLE);
});

test("main.js no longer carries a second status classifier", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.ok(
    !/function recordingStatusMode\s*\(/.test(source),
    "the mode ladder must come from ./recording-status",
  );
  assert.ok(
    !/function recordingStatusTone\s*\(/.test(source),
    "the tone ladder must come from ./recording-status",
  );
  assert.match(source, /require\("\.\/recording-status"\)/);
});
