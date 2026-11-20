"use strict";

// DM-15 / S-13 (Ultra-Audit 2026-11-20): the post-stop task has one source
// for "the transcript is ready" — the renderer's recording-final IPC — not
// a second executeJavaScript poll of renderer globals and DOM ids for a
// renderer version that cannot ship with this main process.
//
// ./post-stop-handoff takes the recording's mailbox and nothing else; it
// is driven here with a real ./recording-final-slot and a fake clock.
// What only main.js's text can show — that processPostStopTask and
// enqueuePostStopTask go through it — is the last test.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  POST_STOP_ADMISSION,
  decidePostStopAdmission,
  awaitRecordingTranscript,
} = require("./post-stop-handoff");
const { createRecordingFinalSlot } = require("./recording-final-slot");
const { NO_SPEECH_STATUS, SIGNAL_OUTCOME } = require("./transcript-signal");
const { topLevelFunctionSource } = require("./main-source");

const REC = 7;

function publish(slot, fields) {
  const signal = slot.set({ recordingId: REC, kind: "transcript", phase: "", final: false, text: "", ...fields });
  assert.ok(signal, "the test published an invalid payload");
  return signal;
}

/** A clock that jumps to the timeout when a wait times out (each real wait is capped at 20 ms). */
function rig() {
  const slot = createRecordingFinalSlot();
  let clock = 1_000;
  const waits = [];
  const fakeSlot = {
    peek: (id) => slot.peek(id),
    waitForSignal: (id, opts) => {
      waits.push(opts);
      return slot.waitForSignal(id, { ...opts, timeoutMs: Math.min(opts.timeoutMs, 20) }).then((s) => {
        if (!s) clock += opts.timeoutMs; // timed out: the deadline passes
        return s;
      });
    },
  };
  const seen = [];
  const run = (deadlineInMs = 30_000) => awaitRecordingTranscript({
    slot: fakeSlot,
    recordingId: REC,
    deadlineAt: clock + deadlineInMs,
    now: () => clock,
    onSignal: (signal, verdict) => seen.push([signal.seq, verdict.outcome, verdict.upscaling]),
  });
  return { slot, run, seen, waits };
}

test("a final published before the wait starts is the transcript, with no wait", async () => {
  const { slot, run, seen, waits } = rig();
  const s = publish(slot, { final: true, text: "  hello   world " });
  assert.deepEqual(await run(), { transcript: "hello world", bestKnownText: "", terminalStatus: "" });
  assert.deepEqual(seen, [[s.seq, SIGNAL_OUTCOME.FINAL, false]]);
  assert.equal(waits.length, 0);
});

test("a final published while waiting ends the wait; provisionals before it are best-known only", async () => {
  const { slot, run, seen } = rig();
  publish(slot, { kind: "status", phase: "upscaling", text: "draft text" });
  const pending = run();
  // Published after the task started waiting.
  await Promise.resolve();
  const fin = publish(slot, { final: true, text: "final text" });
  const result = await pending;
  assert.equal(result.transcript, "final text");
  assert.equal(result.bestKnownText, "draft text");
  // Each signal handled once, in order; the upscaling phase reaches the caller.
  assert.deepEqual(seen, [[1, SIGNAL_OUTCOME.PROVISIONAL, true], [fin.seq, SIGNAL_OUTCOME.FINAL, false]]);
});

test("a provisional is never the transcript: the deadline hands it to the recovery", async () => {
  const { slot, run, seen } = rig();
  publish(slot, { text: "spoken but not paste-ready" });
  assert.deepEqual(await run(5_000), {
    transcript: "",
    bestKnownText: "spoken but not paste-ready",
    terminalStatus: "",
  });
  assert.equal(seen.length, 1, "the same provisional is not handled twice while waiting");
});

test("a terminal publish ends the wait with its status and nothing to paste", async () => {
  const { slot, run } = rig();
  publish(slot, { final: true, text: "", phase: "no-speech" });
  assert.deepEqual(await run(), { transcript: "", bestKnownText: "", terminalStatus: NO_SPEECH_STATUS });
});

test("a dictation that reads like an error is still pasted — the text is never sniffed (DM-01)", async () => {
  const { slot, run } = rig();
  publish(slot, { final: true, text: "HTTP 500 means the server failed" });
  assert.equal((await run()).transcript, "HTTP 500 means the server failed");
});

test("nothing published: the deadline expires with nothing", async () => {
  const { run, waits } = rig();
  assert.deepEqual(await run(4_000), { transcript: "", bestKnownText: "", terminalStatus: "" });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].timeoutMs, 4_000);
});

test("another recording's final is not this recording's transcript", async () => {
  const { slot, run } = rig();
  slot.set({ recordingId: REC + 1, kind: "transcript", phase: "", final: true, text: "someone else" });
  assert.equal((await run(1_000)).transcript, "");
});

test("admission: auto-transcribe off, no recording id, duplicate, admit — in that order", () => {
  const never = () => { throw new Error("asked about duplicates for an inadmissible task"); };
  assert.equal(decidePostStopAdmission({ autoTranscribe: false, recordingId: 3 }, never), POST_STOP_ADMISSION.AUTO_TRANSCRIBE_OFF);
  for (const recordingId of [0, -1, Number.NaN]) {
    assert.equal(decidePostStopAdmission({ autoTranscribe: true, recordingId }, never), POST_STOP_ADMISSION.NO_RECORDING_ID);
  }
  assert.equal(decidePostStopAdmission({ autoTranscribe: true, recordingId: 3 }, () => true), POST_STOP_ADMISSION.DUPLICATE);
  assert.equal(decidePostStopAdmission({ autoTranscribe: true, recordingId: 3 }, () => false), POST_STOP_ADMISSION.ADMIT);
});

// ── Wiring (textual) ─────────────────────────────────────────────────────

test("processPostStopTask waits through ./post-stop-handoff, and enqueue admits through it", () => {
  const fn = topLevelFunctionSource("processPostStopTask");
  assert.ok(fn, "processPostStopTask not found");
  assert.match(fn, /await awaitRecordingTranscript\(\{\s*slot: task\.slot,\s*recordingId: task\.recordingId,/);
  // Absence (a renderer poll must not come back beside the hand-off).
  assert.doesNotMatch(fn, /queryRendererState\(|executeJavaScript\(/, "no renderer poll");
  const enqueue = topLevelFunctionSource("enqueuePostStopTask");
  assert.match(enqueue, /const admission = decidePostStopAdmission\(task, \(\) => _enqueuedRecordings\.has\(key\)\);/);
  for (const outcome of ["AUTO_TRANSCRIBE_OFF", "NO_RECORDING_ID", "DUPLICATE"]) {
    assert.match(enqueue, new RegExp(`if \\(admission === POST_STOP_ADMISSION\\.${outcome}\\)`));
  }
  // A refused task without an id closes the session instead of leaving
  // the capsule on "Transcribing".
  assert.match(enqueue, /POST_STOP_ADMISSION\.NO_RECORDING_ID\) \{[\s\S]*?resetRecordingStatusState\(\)/);
});

test("the renderer snapshot the paste-last lookup reads carries no DOM ids", () => {
  // Absence claim, kept textual: queryRendererState is an
  // executeJavaScript string, so what it reads exists only as text.
  const fn = topLevelFunctionSource("queryRendererState");
  assert.ok(fn, "queryRendererState not found");
  assert.doesNotMatch(fn, /getElementById/);
  assert.doesNotMatch(fn, /__transcriptorFinishedRecords/);
});
