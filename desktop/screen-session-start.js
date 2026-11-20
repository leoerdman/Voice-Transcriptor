"use strict";

// What main does once screenMode.start() has answered for a take the
// renderer is already recording (Ultra-Audit 2026-11-20 DM-31, main-side
// half of S-02 / DX-03).
//
// The session is started only after the renderer confirmed the recording
// (up to 8 s) and the capsule session began. A stop that reached the
// renderer inside that window — its own Stop button — ran stopLive, whose
// screen-mode:finish found no session yet; start() then created overlays,
// the palette and the mouse helper for a take that was already over, and
// nothing ended them until some later stop. And a start that failed left
// only a trace line while the renderer went on believing it was in a
// screen take.
//
// After start() answers, main asks the renderer once more: if the take it
// started for is no longer recording, the session is an orphan and is
// ended at once; if start() failed, the user is told.
//
// Pure — desktop/screen-session-start.test.js.

const AFTER_SCREEN_START = Object.freeze({
  /** The take is live and so is its session. */
  KEEP: "keep",
  /** The take ended while the session was starting: end the session. */
  END_ORPHAN: "end-orphan",
  /** start() failed: tell the user. */
  FAILED: "failed",
});

/**
 * @param {{started: {ok?: boolean}|null, renderer: {recording: boolean, recordingId: number}|null, recordingId: number}} input
 *   ``renderer`` is the recording-state probe after start() answered
 *   (null = no answer: the renderer is busy, the take goes on).
 */
function decideAfterScreenStart({ started, renderer, recordingId } = {}) {
  if (!started || started.ok !== true) return AFTER_SCREEN_START.FAILED;
  if (!renderer) return AFTER_SCREEN_START.KEEP;
  const sameTake = !!renderer.recording && Number(renderer.recordingId || 0) === Number(recordingId || 0);
  return sameTake ? AFTER_SCREEN_START.KEEP : AFTER_SCREEN_START.END_ORPHAN;
}

module.exports = { AFTER_SCREEN_START, decideAfterScreenStart };
