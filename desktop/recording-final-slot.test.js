"use strict";

// Executable specification for desktop/recording-final-slot.js — the
// renderer → main transcript hand-off (BUGS_AUDIT_2026-09-03 §6.7/§6.8).
// Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  RECORDING_SIGNAL_KINDS,
  validateRecordingFinalPayload,
  createRecordingFinalSlot,
} = require("./recording-final-slot");

// ---------------------------------------------------------------- validator

test("validator accepts the contract shape and drops unknown keys", () => {
  assert.deepEqual(
    validateRecordingFinalPayload({
      recordingId: 7,
      text: "hello world",
      final: true,
      kind: "transcript",
      // Anything else the renderer happens to attach is not part of the
      // contract and must not reach the paste path.
      pasteNow: true,
      nested: { evil: 1 },
    }),
    { recordingId: 7, text: "hello world", final: true, kind: "transcript", phase: "" },
  );
});

test("validator accepts a provisional payload and an empty text", () => {
  assert.deepEqual(
    validateRecordingFinalPayload({ recordingId: 1, text: "", final: false, kind: "status", phase: "no-speech" }),
    { recordingId: 1, text: "", final: false, kind: "status", phase: "no-speech" },
  );
});

test("validator rejects a recordingId that is not a positive safe integer", () => {
  for (const recordingId of [0, -1, 1.5, NaN, Infinity, Number.MAX_VALUE, "7", null, undefined]) {
    assert.equal(
      validateRecordingFinalPayload({ recordingId, text: "x", final: true }),
      null,
      `recordingId ${String(recordingId)} must be rejected`,
    );
  }
});

test("validator rejects a non-string text and a non-boolean final", () => {
  assert.equal(validateRecordingFinalPayload({ recordingId: 1, text: 42, final: true }), null);
  assert.equal(validateRecordingFinalPayload({ recordingId: 1, text: null, final: true }), null);
  // §6.8 in one assertion: only a real boolean may claim finality. A
  // truthy stand-in (what a wall-clock timer produced) is not finality.
  assert.equal(validateRecordingFinalPayload({ recordingId: 1, text: "x", final: "true" }), null);
  assert.equal(validateRecordingFinalPayload({ recordingId: 1, text: "x", final: 1 }), null);
  assert.equal(validateRecordingFinalPayload({ recordingId: 1, text: "x" }), null);
});

test("validator rejects non-objects", () => {
  for (const raw of [null, undefined, "", "text", 7, true, [], [{ recordingId: 1 }]]) {
    assert.equal(validateRecordingFinalPayload(raw), null);
  }
});

test("validator requires an explicit kind and a well-formed phase (no label parsing)", () => {
  const base = { recordingId: 1, text: "x", final: true };
  for (const kind of RECORDING_SIGNAL_KINDS) {
    assert.equal(validateRecordingFinalPayload({ ...base, kind }).kind, kind);
  }
  // The old free-form label is not a kind: a payload carrying only it is
  // not a hand-off.
  assert.equal(validateRecordingFinalPayload({ ...base, source: "transcript" }), null);
  assert.equal(validateRecordingFinalPayload({ ...base, kind: "Transcript" }), null);
  assert.equal(validateRecordingFinalPayload({ ...base, kind: "status:upscaling" }), null);
  assert.equal(validateRecordingFinalPayload({ ...base, kind: "status", phase: "upscaling" }).phase, "upscaling");
  assert.equal(validateRecordingFinalPayload({ ...base, kind: "status" }).phase, "");
  for (const phase of [42, "Upscaling", "up scaling", "x".repeat(40), null]) {
    assert.equal(validateRecordingFinalPayload({ ...base, kind: "status", phase }), null, String(phase));
  }
});

// --------------------------------------------------------------------- slot

test("slot ignores an invalid payload entirely", () => {
  const slot = createRecordingFinalSlot();
  assert.equal(slot.set({ recordingId: 0, text: "x", final: true }), null);
  assert.equal(slot.set(null), null);
  assert.equal(slot.size(), 0);
  assert.equal(slot.peek(0), null);
});

test("set-before-wait: a signal published before anyone waits is not lost", async () => {
  const slot = createRecordingFinalSlot();
  slot.set({ recordingId: 5, text: "paste me", final: true, kind: "transcript" });
  // The post-stop task starts waiting only after the queue reaches it —
  // by then the renderer may already have published. The wait must
  // resolve immediately from the stored value, not hang for its timeout.
  const started = Date.now();
  const signal = await slot.waitForSignal(5, { timeoutMs: 5000 });
  assert.equal(signal.text, "paste me");
  assert.equal(signal.final, true);
  assert.ok(Date.now() - started < 250, "must resolve from the stored value, not the timer");
  assert.equal(slot.peek(5).final.text, "paste me");
});

test("wait-before-set: a waiter is woken by the signal that arrives later", async () => {
  const slot = createRecordingFinalSlot();
  const pending = slot.waitForSignal(9, { timeoutMs: 5000 });
  setTimeout(() => slot.set({ recordingId: 9, text: "late", final: true, kind: "transcript" }), 20);
  const signal = await pending;
  assert.equal(signal.text, "late");
  assert.equal(signal.final, true);
});

test("a provisional wakes the waiter, and the following final wakes the next one", async () => {
  const slot = createRecordingFinalSlot();
  const first = slot.waitForSignal(3, { timeoutMs: 5000 });
  slot.set({ recordingId: 3, text: "before upscale", final: false, kind: "status", phase: "upscaling" });
  const provisional = await first;
  assert.equal(provisional.final, false);
  assert.equal(provisional.text, "before upscale");

  // The caller resumes waiting from the sequence it has already seen, so
  // the provisional it just handled cannot wake it a second time.
  const second = slot.waitForSignal(3, { sinceSeq: provisional.seq, timeoutMs: 5000 });
  slot.set({ recordingId: 3, text: "after upscale", final: true, kind: "transcript" });
  const final = await second;
  assert.equal(final.final, true);
  assert.equal(final.text, "after upscale");
  assert.ok(final.seq > provisional.seq);

  // Both kinds stay readable: the provisional remains the best-known
  // text (§6.9) even after the final has landed.
  assert.equal(slot.peek(3).provisional.text, "before upscale");
  assert.equal(slot.peek(3).final.text, "after upscale");
});

test("sinceSeq is honoured on a set-before-wait read", async () => {
  const slot = createRecordingFinalSlot();
  const stored = slot.set({ recordingId: 4, text: "seen already", final: false, kind: "status" });
  // Already handled — waiting from its own seq must not return it again.
  const started = Date.now();
  assert.equal(await slot.waitForSignal(4, { sinceSeq: stored.seq, timeoutMs: 60 }), null);
  assert.ok(Date.now() - started >= 50);
});

test("last write wins per kind", () => {
  const slot = createRecordingFinalSlot();
  slot.set({ recordingId: 2, text: "first", final: true, kind: "transcript" });
  slot.set({ recordingId: 2, text: "corrected", final: true, kind: "transcript" });
  assert.equal(slot.peek(2).final.text, "corrected");
});

test("another recording's signal never resolves this recording's waiter", async () => {
  const slot = createRecordingFinalSlot();
  const pending = slot.waitForSignal(11, { timeoutMs: 80 });
  // A recording that started after this one finished publishing its own
  // text: strict id matching is what keeps one recording's transcript
  // from being pasted for another.
  slot.set({ recordingId: 12, text: "next recording", final: true, kind: "transcript" });
  assert.equal(await pending, null);
  assert.equal(slot.peek(11), null);
  assert.equal(slot.peek(12).final.text, "next recording");
});

test("superseded id: the oldest slot is dropped and its waiter released", async () => {
  const slot = createRecordingFinalSlot({ maxRecordings: 2 });
  const oldest = slot.set({ recordingId: 100, text: "oldest", final: false, kind: "status" });
  // Still waiting for its final, having already handled the provisional.
  const stale = slot.waitForSignal(100, { sinceSeq: oldest.seq, timeoutMs: 5000 });
  slot.set({ recordingId: 101, text: "middle", final: false, kind: "status" });
  slot.set({ recordingId: 102, text: "newest", final: false, kind: "status" });
  // Released with null rather than left hanging on its own timeout: the
  // caller falls back instead of blocking to its deadline.
  assert.equal(await stale, null);
  assert.equal(slot.peek(100), null);
  assert.equal(slot.size(), 2);
  assert.equal(slot.peek(101).provisional.text, "middle");
  assert.equal(slot.peek(102).provisional.text, "newest");
});

test("timeout: no signal at all resolves null after the caller's deadline", async () => {
  const slot = createRecordingFinalSlot();
  const started = Date.now();
  assert.equal(await slot.waitForSignal(77, { timeoutMs: 60 }), null);
  assert.ok(Date.now() - started >= 50, "must actually wait the timeout");
});

test("timeout: a zero or missing timeout is a non-blocking read", async () => {
  const slot = createRecordingFinalSlot();
  assert.equal(await slot.waitForSignal(77, { timeoutMs: 0 }), null);
  assert.equal(await slot.waitForSignal(77), null);
  slot.set({ recordingId: 77, text: "here", final: true, kind: "transcript" });
  assert.equal((await slot.waitForSignal(77)).text, "here");
});

test("an unusable recordingId degrades to a plain timer", async () => {
  const slot = createRecordingFinalSlot();
  // The legacy recordingId 0 (renderer too old to supply one) can never
  // be matched, so the poll fallback can use the same call as its sleep.
  const started = Date.now();
  assert.equal(await slot.waitForSignal(0, { timeoutMs: 60 }), null);
  assert.ok(Date.now() - started >= 50);
  assert.equal(slot.size(), 0);
});

test("a settled waiter is not disturbed by later signals", async () => {
  const slot = createRecordingFinalSlot();
  const pending = slot.waitForSignal(21, { timeoutMs: 5000 });
  slot.set({ recordingId: 21, text: "one", final: false, kind: "status" });
  assert.equal((await pending).text, "one");
  // No waiters left: a second signal must not throw or double-resolve.
  slot.set({ recordingId: 21, text: "two", final: true, kind: "transcript" });
  assert.equal(slot.peek(21).final.text, "two");
});

// ------------------------------------------------------------- the wiring
//
// The slot above is only useful if both ends of the channel agree on its
// name, and neither end can import the other (preload runs in the
// renderer's context, main.js needs Electron). Nothing at runtime
// reports a mismatch either: a renderer sending on a channel nobody
// listens to looks exactly like an older renderer that never sends —
// the post-stop task silently waits out its grace window and falls back
// to polling. So the agreement is asserted from the source text.

const PRELOAD_SRC = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

test("preload sends, and main listens on, the same one channel", () => {
  const sent = matchAll(PRELOAD_SRC, /ipcRenderer\.send\(\s*"([^"]+)"/g);
  assert.equal(sent.filter((c) => c === "recording-final").length, 1, "the hand-off is sent on one channel, once");
  const listened = matchAll(MAIN_SRC, /mainWindowIpc\.on\(\s*"([^"]+)"/g);
  assert.ok(
    listened.includes("recording-final"),
    `main.js must listen on "recording-final" (listens on: ${listened.join(", ") || "nothing"})`,
  );
});

test("preload exposes the hand-off as window.transcriptor.recordingFinal", () => {
  // The renderer half of the contract. Renaming either half here without
  // the other is the silent failure described above.
  assert.match(PRELOAD_SRC, /exposeInMainWorld\(\s*"transcriptor"/);
  assert.match(PRELOAD_SRC, /recordingFinal:\s*\(/);
});

test("main validates every hand-off through the slot, never ad hoc", () => {
  // One door in. main.js imports the slot and nothing else from this
  // module: it validates by calling slot.set(), which validates
  // internally, so there is no second place a payload can be read.
  const imported = MAIN_SRC.match(/const\s*\{([^}]*)\}\s*=\s*require\("\.\/recording-final-slot"\)/);
  assert.ok(imported, "main.js must require ./recording-final-slot");
  assert.deepEqual(
    imported[1].split(",").map((s) => s.trim()).filter(Boolean),
    ["createRecordingFinalSlot"],
  );
});

test("the §6.8 wall-clock guesses stay deleted", () => {
  // Both of these turned "some time has passed" into "this text is
  // final" and pasted pre-upscale text. Finality is stated by the
  // renderer (final:true) or it does not exist.
  for (const guess of [
    "UI_FINAL_STATUS_TRANSCRIPT_FALLBACK_MS",
    "done_status_transcript_fallback",
    "ui_final_status_transcript_fallback",
  ]) {
    assert.ok(!MAIN_SRC.includes(guess), `${guess} must not come back (BUGS_AUDIT §6.8)`);
  }
});
