"use strict";

// Unit tests for the renderer-console mirror policy (renderer-console.js).
// Pure node:test — no Electron, mirrors accelerator.test.js.
//
// The regression these pin: NOTHING the renderer logged had ever reached
// main.log. Zero `[renderer …]` lines across the whole archive set. Two
// independent causes — a development-only gate, and a handler reading
// Electron's pre-36 `console-message` signature on Electron 42, where
// the message argument is undefined.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_MESSAGE_CHARS,
  createConsoleMirrorLimiter,
  formatConsoleMirrorLine,
  normalizeConsoleMessage,
  shouldMirrorConsoleMessage,
} = require("./renderer-console");

// ── signature normalisation ───────────────────────────────────────────

test("normalises the Electron >= 36 details-object signature", () => {
  // The shape the bundled Electron 42 actually emits. The old handler
  // read argument 3 here, got undefined, and dropped every message.
  const out = normalizeConsoleMessage(
    { level: "warning", message: "Recovery promote failed", lineNumber: 12 },
    undefined,
  );
  assert.deepEqual(out, { level: "WARN", message: "Recovery promote failed" });
});

test("normalises the Electron < 36 positional signature", () => {
  assert.deepEqual(normalizeConsoleMessage(3, "boom"), {
    level: "ERROR",
    message: "boom",
  });
  assert.deepEqual(normalizeConsoleMessage(2, "careful"), {
    level: "WARN",
    message: "careful",
  });
  assert.deepEqual(normalizeConsoleMessage(1, "fyi"), {
    level: "INFO",
    message: "fyi",
  });
  assert.deepEqual(normalizeConsoleMessage(0, "chatter"), {
    level: "DEBUG",
    message: "chatter",
  });
});

test("maps every string level Electron can emit", () => {
  for (const [raw, expected] of [
    ["error", "ERROR"],
    ["warning", "WARN"],
    ["warn", "WARN"],
    ["info", "INFO"],
    ["log", "INFO"],
    ["debug", "DEBUG"],
    ["verbose", "DEBUG"],
  ]) {
    assert.equal(
      normalizeConsoleMessage({ level: raw, message: "m" }, undefined).level,
      expected,
      `level ${raw}`,
    );
  }
});

test("an unknown shape degrades to INFO instead of throwing", () => {
  // A logger must never be able to break the thing it observes.
  assert.deepEqual(normalizeConsoleMessage(undefined, undefined), {
    level: "INFO",
    message: "",
  });
  assert.deepEqual(normalizeConsoleMessage(null, 42), {
    level: "INFO",
    message: "",
  });
  assert.equal(
    normalizeConsoleMessage({ level: "nonsense", message: "m" }, undefined).level,
    "INFO",
  );
});

// ── what gets mirrored ────────────────────────────────────────────────

test("warnings and errors are mirrored without the debug flag", () => {
  // The whole point: the renderer reports its failures at these levels,
  // and a support log that omits them is the bug being fixed.
  assert.equal(shouldMirrorConsoleMessage("ERROR", "anything", false), true);
  assert.equal(shouldMirrorConsoleMessage("WARN", "anything", false), true);
});

test("routine info and debug chatter is dropped", () => {
  assert.equal(shouldMirrorConsoleMessage("INFO", "hello", false), false);
  assert.equal(shouldMirrorConsoleMessage("DEBUG", "hello", false), false);
  assert.equal(shouldMirrorConsoleMessage("INFO", "hello", true), false);
});

test("[trace] lines are mirrored only behind the debug flag", () => {
  // High volume — thousands of lines per session — which is why the
  // flag exists at all.
  assert.equal(shouldMirrorConsoleMessage("INFO", "[trace] step", false), false);
  assert.equal(shouldMirrorConsoleMessage("INFO", "[trace] step", true), true);
  assert.equal(shouldMirrorConsoleMessage("DEBUG", "[trace-end] x", true), true);
});

// ── formatting ────────────────────────────────────────────────────────

test("the per-stop summary is always mirrored, flag or no flag", () => {
  // One line per recording, carrying the per-phase breakdown of the
  // stop chain. It was computed on every stop and thrown away, which is
  // why "the transcript took a very long time" had no answer in the log.
  const line = "[trace stopLive] total=1398ms | flushWorkletPort: 12ms → waitForWorkletDrain: 180ms";
  assert.equal(shouldMirrorConsoleMessage("INFO", line, false), true);
  assert.equal(shouldMirrorConsoleMessage("INFO", line, true), true);
});

test("the per-start summary is always mirrored, flag or no flag", () => {
  // The other end of the session: hotkey → first captured audio frame,
  // one line per recording. "The capsule waits about a second before it
  // starts" is answerable only if this reaches the support log.
  const line = "[trace startLive] total=812ms to first audio frame | loadMics: 96ms → getUserMedia: 402ms";
  assert.equal(shouldMirrorConsoleMessage("INFO", line, false), true);
  assert.equal(shouldMirrorConsoleMessage("INFO", line, true), true);
});

test("the tail-gap verdict is always mirrored, flag or no flag", () => {
  // Why a stop did or did not chase a missing ending. Without it, a
  // report of a cut-off transcript has no evidence behind it at all.
  const line = "[trace tail-gap] recordedSec=11.30 lastSpeechEnd=11.25 tailGapSec=0.05 decision=skip";
  assert.equal(shouldMirrorConsoleMessage("INFO", line, false), true);
});

test("the recording tones are always mirrored, flag or no flag", () => {
  // Whether the start/stop tone played: a tone leaves no other trace, so
  // "I don't hear the sound" is answerable only from this line.
  assert.equal(shouldMirrorConsoleMessage("INFO", "[cue] start played", false), true);
  assert.equal(shouldMirrorConsoleMessage("INFO", "[cue] stop resuming", false), true);
});

test("the warm hold's release and device signal are always mirrored, flag or no flag", () => {
  // The hold is what keeps the OS microphone indicator lit between takes.
  // "The light stays on and I can't tell why" is answered by the release
  // reason or by nothing at all — and a release happens a handful of
  // times per session, not per take.
  for (const line of [
    "[trace warmCapture] released reason=ttl heldMs=900012",
    "[trace warmCapture] released reason=lock-screen heldMs=95000",
    "[trace warmCapture] released reason=mic-hold-changed heldMs=12000",
    "[trace warmCapture] device signal silent=1 heldMs=60000",
    "[trace warmCapture] the silent output sink was refused; the capture context keeps the default output",
  ]) {
    assert.equal(shouldMirrorConsoleMessage("INFO", line, false), true, line);
    assert.equal(shouldMirrorConsoleMessage("INFO", line, true), true, line);
  }
});

test("the high-volume trace stream stays behind the flag", () => {
  // Thousands of lines per session — the reason the flag exists.
  const line = '[trace] {"id":"paste-1","scope":"paste","step":1}';
  assert.equal(shouldMirrorConsoleMessage("INFO", line, false), false);
  assert.equal(shouldMirrorConsoleMessage("INFO", line, true), true);
});

test("the always-mirrored list is a prefix match, not a substring one", () => {
  // A transcript quoting the prefix must not smuggle itself into the log.
  assert.equal(
    shouldMirrorConsoleMessage("INFO", "user said [trace stopLive] out loud", false),
    false,
  );
});

test("formats a mirrored line with its level tag", () => {
  assert.equal(
    formatConsoleMirrorLine({ level: "error", message: "kaput" }, undefined, false),
    "[renderer ERROR] kaput",
  );
});

test("returns an empty string for anything not mirrored", () => {
  assert.equal(formatConsoleMirrorLine({ level: "info", message: "hi" }, undefined, false), "");
  assert.equal(formatConsoleMirrorLine({ level: "error", message: "" }, undefined, false), "");
  assert.equal(formatConsoleMirrorLine(undefined, undefined, true), "");
});

test("folds newlines so one console entry stays one log line", () => {
  // A multi-line stack trace must not fragment into records that read
  // as separate events.
  const line = formatConsoleMirrorLine(
    { level: "error", message: "Error: x\n  at a()\n  at b()" },
    undefined,
    false,
  );
  assert.equal(line.includes("\n"), false);
  assert.equal(line, "[renderer ERROR] Error: x ⏎ at a() ⏎ at b()");
});

test("clips a runaway message and says how much was dropped", () => {
  const huge = "x".repeat(MAX_MESSAGE_CHARS + 250);
  const line = formatConsoleMirrorLine({ level: "error", message: huge }, undefined, false);
  assert.equal(line.length < huge.length, true);
  assert.equal(line.includes("(+250 chars)"), true);
});

test("a message exactly at the cap is not clipped", () => {
  const exact = "y".repeat(MAX_MESSAGE_CHARS);
  const line = formatConsoleMirrorLine({ level: "warning", message: exact }, undefined, false);
  assert.equal(line, `[renderer WARN] ${exact}`);
});

test("the real failure that went unlogged now produces a line", () => {
  // Reported by the user as "Could not recover 1 interrupted recording";
  // the renderer logged it with console.warn and it reached nothing.
  const line = formatConsoleMirrorLine(
    { level: "warning", message: "Recovery promote failed for cd98fa10: HTTP 409" },
    undefined,
    /* mirrorTraceLogs */ false,
  );
  assert.equal(line, "[renderer WARN] Recovery promote failed for cd98fa10: HTTP 409");
});

// ── rate limit ────────────────────────────────────────────────────────

test("the mirror is bounded per window, and says what it dropped", () => {
  // "error/warning are low volume by definition" holds for a renderer
  // behaving itself. A fetch retry loop is the case that matters, and each
  // mirrored line is a SYNCHRONOUS appendMainLog while the user waits for a
  // transcript.
  const admit = createConsoleMirrorLimiter({ maxLinesPerWindow: 3, windowMs: 1000 });
  const emitted = [];
  for (let i = 0; i < 50; i++) emitted.push(...admit(`[renderer ERROR] fetch failed #${i}`, 0));
  assert.equal(emitted.length, 3, "the window's budget is the budget");
  assert.deepEqual(emitted, [
    "[renderer ERROR] fetch failed #0",
    "[renderer ERROR] fetch failed #1",
    "[renderer ERROR] fetch failed #2",
  ]);

  // Next window: the drop count is reported, then normal service resumes.
  const after = admit("[renderer ERROR] fetch failed #50", 1000);
  assert.deepEqual(after, [
    "[renderer WARN] console mirror dropped 47 message(s) in the previous 1000 ms",
    "[renderer ERROR] fetch failed #50",
  ]);
  // ...and nothing is re-reported.
  assert.deepEqual(admit("[renderer ERROR] again", 1001), ["[renderer ERROR] again"]);
});

test("a renderer under the limit is mirrored unchanged, forever", () => {
  const admit = createConsoleMirrorLimiter({ maxLinesPerWindow: 20, windowMs: 1000 });
  for (let second = 0; second < 100; second++) {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(admit(`[renderer WARN] tick ${second}.${i}`, second * 1000 + i), [
        `[renderer WARN] tick ${second}.${i}`,
      ]);
    }
  }
});

test("a varying message defeats a dedup, which is why the bound is a window", () => {
  // A retry loop varies its text — attempt numbers, URLs, timestamps — so
  // suppressing only IDENTICAL consecutive lines would let it straight
  // through.
  const admit = createConsoleMirrorLimiter({ maxLinesPerWindow: 2, windowMs: 100 });
  const out = [];
  for (let i = 0; i < 10; i++) out.push(...admit(`[renderer ERROR] GET /api/x?attempt=${i}`, 0));
  assert.equal(out.length, 2);
});

test("a dropped line is a dropped line, but an empty decision is not counted", () => {
  const admit = createConsoleMirrorLimiter({ maxLinesPerWindow: 1, windowMs: 1000 });
  assert.deepEqual(admit("", 0), [], "formatConsoleMirrorLine's 'drop it' answer costs nothing");
  assert.deepEqual(admit("[renderer ERROR] a", 0), ["[renderer ERROR] a"]);
  assert.deepEqual(admit("", 0), []);
  assert.deepEqual(admit("[renderer ERROR] b", 0), []);
  assert.deepEqual(admit("[renderer ERROR] c", 1000), [
    "[renderer WARN] console mirror dropped 1 message(s) in the previous 1000 ms",
    "[renderer ERROR] c",
  ]);
});

test("main.js routes the mirror through the limiter", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(source, /createConsoleMirrorLimiter\(\)/);
  assert.match(source, /for \(const out of consoleMirrorLimiter\(line, Date\.now\(\)\)\) appendMainLog\(out\)/);
});
