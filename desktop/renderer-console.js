"use strict";

// Renderer console → support log policy — the single source of truth for
// WHAT of the renderer's console output reaches main.log and in what
// shape. Pure, unit-tested by renderer-console.test.js against the exact
// code Electron loads, mirroring the ./accelerator.js pattern.
//
// ── Why this module exists ────────────────────────────────────────────
//
// Nothing the renderer logged had ever reached main.log. Measured across
// the full archive set: zero `[renderer …]` lines, in any file, ever.
// Two independent reasons, either of which was sufficient:
//
//   1. The mirror was gated on a development-only flag
//      (TRANSCRIPTOR_RENDERER_TRACE_LOGS=1 / NODE_ENV=development), so
//      in every shipped build it was off.
//   2. The handler read Electron's PRE-36 `console-message` signature,
//      `(event, level, message)`. Electron 36 replaced it with
//      `(event, details)`. On the bundled Electron 42 the third argument
//      is undefined, so even with the flag on, the prefix test compared
//      the string "undefined" and matched nothing.
//
// The cost was not theoretical. The renderer reports its failures with
// console.warn / console.error — a recovery that could not be promoted,
// an AudioWorklet that fell back to ScriptProcessor (a real capture
// quality downgrade), a saved-audio fetch that failed, a key save that
// was rejected. A user-visible error banner therefore left NO trace in
// the support log at all; diagnosing one meant reproducing it by hand.
//
// ── The policy ────────────────────────────────────────────────────────
//
// Severity decides, not a string prefix:
//
//   error / warning  → always mirrored. These are, by definition, the
//                      renderer telling us something went wrong, and
//                      they are low volume.
//   [trace…] lines   → mirrored only behind the debug flag. These are
//                      high-volume instrumentation, thousands of lines
//                      per session; they are why the flag exists.
//   everything else  → dropped. Routine info/debug chatter is noise in
//                      a support log.
//
// Both call signatures are normalised, so the mirror keeps working
// across an Electron upgrade instead of silently going dark again.

/** Longest mirrored message. Bounds a runaway console dump. */
const MAX_MESSAGE_CHARS = 600;

/**
 * Low-volume per-session summaries that are always mirrored.
 *
 * Severity is the right default rule, but it misfiles one thing: a
 * summary emitted once per recording is not chatter, and putting it
 * behind the debug flag with the thousands of per-step `[trace]` lines
 * threw away the single most useful latency record in the app.
 *
 * `[trace stopLive]` is computed on every stop — the per-phase
 * breakdown of the stop chain, `flushWorkletPort → waitForWorkletDrain
 * → stopMediaRecorderAndFlush → pcmSink.finalize → …` with milliseconds
 * against each — and then discarded. When a user says "the transcript
 * took a very long time", that line is the answer, and it existed only
 * in a devtools console nobody had open.
 *
 * `[trace startLive]` is the same record for the other end of the
 * session: the phases between the hotkey reaching the renderer and the
 * first captured audio frame. Without it "the capsule takes a second to
 * come up" is unanswerable from a support log.
 *
 * `[trace tail-gap]` is the decision that follows: whether the stop path
 * believed the transcript's tail was complete, and what it did about it.
 * When a user reports a cut-off ending, that verdict is the whole
 * diagnosis, and it was written only to a devtools console nobody had
 * open — two or three lines per stop.
 *
 * `[cue]` says whether the start and stop tones played (`played`,
 * `resuming`, `unavailable`, `failed`). A tone leaves no other trace, and
 * "I don't hear the sound" (2026-11-20) was undiagnosable without it —
 * two lines per recording.
 *
 * A handful of lines per recording. Anything added here must stay that
 * cheap.
 */
const ALWAYS_MIRRORED_PREFIXES = Object.freeze([
  "[trace stopLive]",
  "[trace startLive]",
  "[trace tail-gap]",
  "[cue]",
]);

const LEVEL_ERROR = "ERROR";
const LEVEL_WARN = "WARN";
const LEVEL_INFO = "INFO";
const LEVEL_DEBUG = "DEBUG";

// Electron <36 passed a numeric level; 36+ passes a string on `details`.
const NUMERIC_LEVELS = Object.freeze({
  0: LEVEL_DEBUG,
  1: LEVEL_INFO,
  2: LEVEL_WARN,
  3: LEVEL_ERROR,
});

const STRING_LEVELS = Object.freeze({
  debug: LEVEL_DEBUG,
  verbose: LEVEL_DEBUG,
  log: LEVEL_INFO,
  info: LEVEL_INFO,
  warning: LEVEL_WARN,
  warn: LEVEL_WARN,
  error: LEVEL_ERROR,
});

/**
 * Normalise either `console-message` signature into `{level, message}`.
 *
 * Electron <36:  (event, level:number, message:string, line, sourceId)
 * Electron >=36: (event, details:{level:string, message:string, ...})
 *
 * Accepting both is what keeps this from going dark on the next upgrade
 * the way it did on the last one. An unrecognised shape yields level
 * INFO and whatever text could be found, never a throw — a logger must
 * not be able to break the thing it observes.
 */
function normalizeConsoleMessage(a, b) {
  // Electron >= 36: a single details object.
  if (a && typeof a === "object" && typeof a.message === "string") {
    return {
      level: STRING_LEVELS[String(a.level || "").toLowerCase()] || LEVEL_INFO,
      message: a.message,
    };
  }
  // Electron < 36: positional level + message.
  const level =
    typeof a === "number"
      ? NUMERIC_LEVELS[a] || LEVEL_INFO
      : STRING_LEVELS[String(a || "").toLowerCase()] || LEVEL_INFO;
  return { level, message: typeof b === "string" ? b : "" };
}

/**
 * Decide whether a normalised console message belongs in the log.
 *
 * `mirrorTraceLogs` gates only the high-volume `[trace…]` stream;
 * warnings and errors are never gated, because a support log that omits
 * them is exactly what we are fixing.
 */
function shouldMirrorConsoleMessage(level, message, mirrorTraceLogs) {
  if (level === LEVEL_ERROR || level === LEVEL_WARN) return true;
  const text = String(message || "");
  if (ALWAYS_MIRRORED_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  if (!mirrorTraceLogs) return false;
  return text.startsWith("[trace");
}

/**
 * Full decision + formatting. Returns the line to append, or "" to drop.
 *
 * Newlines are folded so one console entry stays one log line — a
 * multi-line stack trace must not fragment into records that look like
 * separate events.
 */
function formatConsoleMirrorLine(a, b, mirrorTraceLogs) {
  const { level, message } = normalizeConsoleMessage(a, b);
  if (!message) return "";
  if (!shouldMirrorConsoleMessage(level, message, mirrorTraceLogs)) return "";
  const folded = message.replace(/\s*\n\s*/g, " ⏎ ").trim();
  const clipped =
    folded.length > MAX_MESSAGE_CHARS
      ? `${folded.slice(0, MAX_MESSAGE_CHARS)}…(+${folded.length - MAX_MESSAGE_CHARS} chars)`
      : folded;
  return `[renderer ${level}] ${clipped}`;
}

// ── Rate limit ────────────────────────────────────────────────────────
//
// "error / warning are low volume by definition" is true of a renderer
// behaving itself and false of the one case that matters: a fetch retry
// loop, a failing recovery poll, an AudioWorklet erroring per buffer. Each
// mirrored line is a SYNCHRONOUS appendMainLog on the main process, and the
// renderer is loudest exactly when the user is waiting for a transcript —
// so the mirror could turn a renderer fault into main-process stalls on the
// latency-critical path.
//
// The bound is a rolling window rather than a per-message dedup, because a
// retry loop varies its text (URLs, attempt numbers) and a dedup would let
// it through. Nothing is silently lost: the count of what was dropped is
// reported on the next window, which is the fact a support log needs.
const MIRROR_RATE_LIMIT = Object.freeze({ maxLinesPerWindow: 20, windowMs: 1000 });

/**
 * @param {{maxLinesPerWindow: number, windowMs: number}} [limit]
 * @returns {(line: string, now: number) => string[]} the lines to append —
 *   none, the line, or a suppression summary followed by the line.
 */
function createConsoleMirrorLimiter(limit = MIRROR_RATE_LIMIT) {
  const maxLinesPerWindow = Math.max(1, Number(limit.maxLinesPerWindow) || 1);
  const windowMs = Math.max(1, Number(limit.windowMs) || 1);
  let windowStartedAt = -Infinity;
  let emitted = 0;
  let suppressed = 0;

  return function admit(line, now) {
    if (!line) return [];
    const at = Number(now) || 0;
    const out = [];
    if (at - windowStartedAt >= windowMs) {
      if (suppressed > 0) {
        out.push(
          `[renderer WARN] console mirror dropped ${suppressed} message(s) in the previous ${windowMs} ms`,
        );
      }
      windowStartedAt = at;
      emitted = 0;
      suppressed = 0;
    }
    // The summary does NOT count against the window's budget: it is emitted
    // at most once per window by construction, so it cannot become a log
    // source of its own, and charging for it would starve the very line the
    // budget exists to let through when the budget is small.
    if (emitted >= maxLinesPerWindow) {
      suppressed += 1;
      return out;
    }
    emitted += 1;
    out.push(line);
    return out;
  };
}

module.exports = {
  MAX_MESSAGE_CHARS,
  createConsoleMirrorLimiter,
  formatConsoleMirrorLine,
  normalizeConsoleMessage,
  shouldMirrorConsoleMessage,
};
