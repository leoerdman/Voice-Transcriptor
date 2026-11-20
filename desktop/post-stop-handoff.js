"use strict";

// How a post-stop task learns its transcript (Ultra-Audit 2026-11-20
// DM-15 / S-13, review item #4).
//
// The renderer's recording-final IPC hand-off is the one source: every
// renderer publish for a recording lands in that renderer epoch's
// mailbox (./recording-final-slot) and is read through
// ./transcript-signal's classification. An executeJavaScript poll of
// renderer globals and DOM ids used to take over after 2 s of IPC
// silence, as a second owner of the same decision; it is gone, and this
// module takes nothing but the mailbox, so it cannot come back here.
//
// Pure: the slot, the clock and the per-signal callback are injected —
// desktop/post-stop-handoff.test.js drives them with a real slot.

const { SIGNAL_OUTCOME, classifyRecordingSignal } = require("./transcript-signal");

/** Why enqueuePostStopTask admits a stopped recording, or does not. */
const POST_STOP_ADMISSION = Object.freeze({
  ADMIT: "admit",
  /** Auto-transcribe is off: there is no paste to wait for. */
  AUTO_TRANSCRIBE_OFF: "auto-transcribe-off",
  /**
   * No positive recording id: a hand-off carries nothing else to match a
   * task to, so the task could only wait out its deadline. Refused, and
   * the caller closes the session.
   */
  NO_RECORDING_ID: "no-recording-id",
  /** Already enqueued for this (epoch, id): a second paste of one recording. */
  DUPLICATE: "duplicate",
});

/**
 * @param {{autoTranscribe: boolean, recordingId: number}} task
 * @param {() => boolean} isAlreadyEnqueued asked only for an otherwise admissible task
 * @returns {string} one of POST_STOP_ADMISSION
 */
function decidePostStopAdmission(task, isAlreadyEnqueued) {
  if (!task.autoTranscribe) return POST_STOP_ADMISSION.AUTO_TRANSCRIBE_OFF;
  if (!(task.recordingId > 0)) return POST_STOP_ADMISSION.NO_RECORDING_ID;
  if (isAlreadyEnqueued()) return POST_STOP_ADMISSION.DUPLICATE;
  return POST_STOP_ADMISSION.ADMIT;
}

/**
 * Wait for recording ``recordingId``'s hand-off until ``deadlineAt``.
 *
 * A FINAL signal ends the wait with its text; a TERMINAL one ends it with
 * nothing to paste and the status to show; a PROVISIONAL one is
 * best-known text (never pasted, §6.8) and the wait goes on. A signal
 * already in the slot when the wait starts counts, and each signal is
 * handled once.
 *
 * @param {{
 *   slot: {peek: Function, waitForSignal: Function},
 *   recordingId: number,
 *   deadlineAt: number,
 *   now?: () => number,
 *   onSignal?: (signal: object, verdict: object) => void,
 * }} options ``onSignal`` sees every handled signal with its verdict
 *   (the caller's trace and "Upscaling" status).
 * @returns {Promise<{transcript: string, bestKnownText: string, terminalStatus: string}>}
 *   ``transcript`` is non-empty only for a FINAL; with neither it nor
 *   ``terminalStatus`` the deadline expired, and ``bestKnownText`` is the
 *   recovery's best text.
 */
async function awaitRecordingTranscript({ slot, recordingId, deadlineAt, now = Date.now, onSignal = () => { } }) {
  let transcript = "";
  let bestKnownText = "";
  let terminalStatus = "";
  let handledSeq = 0;
  while (now() < deadlineAt) {
    const known = slot.peek(recordingId);
    if (known?.last && known.last.seq > handledSeq) {
      const signal = known.last;
      handledSeq = signal.seq;
      const verdict = classifyRecordingSignal(signal);
      onSignal(signal, verdict);
      if (verdict.outcome === SIGNAL_OUTCOME.FINAL) {
        transcript = verdict.text;
        terminalStatus = "";
        break;
      }
      if (verdict.outcome === SIGNAL_OUTCOME.TERMINAL) {
        transcript = "";
        terminalStatus = verdict.status;
        break;
      }
      bestKnownText = verdict.text;
      continue;
    }
    // Ends the moment the renderer publishes something newer than what
    // has been handled, so a signal never sits in the slot while this
    // sleeps on a timer.
    await slot.waitForSignal(recordingId, {
      sinceSeq: handledSeq,
      timeoutMs: Math.max(1, deadlineAt - now()),
    });
  }
  return { transcript, bestKnownText, terminalStatus };
}

module.exports = { POST_STOP_ADMISSION, decidePostStopAdmission, awaitRecordingTranscript };
