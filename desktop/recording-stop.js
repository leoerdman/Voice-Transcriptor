"use strict";

// What a main-process stop (capsule click, silence auto-stop, dead-pipeline
// fail-safe) does once the renderer has — or has not — answered
// (Ultra-Audit 2026-11-20 DM-03, DM-22).
//
// DM-03: the recording-state probe used to substitute ``{recording:false}``
// when the renderer did not answer within its 1 s budget, so a renderer
// that was merely busy (finalize, GC, layout) was read as "not
// recording": the capsule was hidden, the monitor and its dead-pipeline
// guard stopped and the status said "Saved To App" while the microphone
// kept recording, with no capsule left to stop it from. "No answer" is
// now its own input, and it means the recording is still going: nothing
// was dispatched, so nothing stopped.
//
// DM-22: the captured paste target (the app the user started in) was
// cleared on every exit, including the ones where the recording goes on;
// the real stop later had no target and fell back to whatever was in
// front. It is kept exactly when the recording continues.
//
// Pure — desktop/recording-stop.test.js.

const STOP_ACTION = Object.freeze({
  /** The recording continues: keep monitor, capsule and paste target. */
  KEEP_RECORDING: "keep-recording",
  /** Stopped with auto-transcribe: hand the recording to the post-stop queue. */
  ENQUEUE: "enqueue",
  /** Stopped (or was not recording): saved in the app, nothing to paste. */
  SAVED: "saved",
  /** The stop was dispatched but never confirmed: report and reset. */
  UNCONFIRMED: "unconfirmed",
});

/**
 * @param {object} input
 * @param {null|{recording:boolean, recordingId:number}} input.snapshot
 *   the recording-state probe; ``null`` = the renderer did not answer.
 * @param {null|object} [input.result] the stop request's answer, asked
 *   only when ``snapshot.recording``; ``null`` = no answer.
 */
function decideMainProcessStop({ snapshot, result } = {}) {
  if (snapshot === null || snapshot === undefined) {
    return { action: STOP_ACTION.KEEP_RECORDING, reason: "renderer-silent", keepsPasteTarget: true };
  }
  if (!snapshot.recording) {
    return { action: STOP_ACTION.SAVED, reason: "not-recording", keepsPasteTarget: false };
  }
  if (result === null || result === undefined) {
    return { action: STOP_ACTION.UNCONFIRMED, reason: "stop-timed-out", keepsPasteTarget: false };
  }
  if (result.stale) {
    return { action: STOP_ACTION.KEEP_RECORDING, reason: "stale", keepsPasteTarget: true };
  }
  if (result.ok && result.auto) {
    return { action: STOP_ACTION.ENQUEUE, reason: "stopped", keepsPasteTarget: false };
  }
  return { action: STOP_ACTION.SAVED, reason: result.ok ? "stopped" : "not-recording", keepsPasteTarget: false };
}

module.exports = { STOP_ACTION, decideMainProcessStop };
