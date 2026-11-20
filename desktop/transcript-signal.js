"use strict";

// What a renderer hand-off signal MEANS for the post-stop task: paste it,
// keep waiting, or report a terminal status (Ultra-Audit 2026-11-20 DM-01).
//
// The decision used to be made by reading the user's own words.
// ``isMeaningfulTranscriptText`` refused any text that STARTED with
// "http " or "network error" and any text that CONTAINED "no speech
// detected" / "silence detected" — so a dictation of "HTTP server returns
// 500" or "network error handling is flaky" was classified as a status
// string, nothing was pasted, and the capsule displayed the user's
// sentence as if it were an error message. In-band signalling over user
// data: the content of a transcript can never be evidence about what kind
// of message it is.
//
// The renderer already says what each publish is. ``final`` is true only
// for its paste-ready text (frontend/src/main.tsx publishRecordingOutput),
// and every publish carries ``source = "<kind>[:<phase>]"`` with kind one
// of "transcript" | "status" | "error" and phase naming what the renderer
// is doing ("upscaling" for the pre-upscale provisional, "no-speech" when
// the recording produced nothing). This module reads only those explicit
// fields. The one text comparison left is whole-string EQUALITY against
// the fixed placeholders the renderer itself writes for "no speech" — a
// sentence that merely contains those words is a sentence.
//
// Pure: no Electron, no clock — desktop/transcript-signal.test.js.

/** The status the capsule shows for a recording that produced no speech. */
const NO_SPEECH_STATUS = "Recording completed, no speech detected.";

/**
 * Exact (normalized, lower-cased) placeholder texts the renderer shows
 * instead of a transcript when there was no speech. Equality only.
 */
const NO_SPEECH_PLACEHOLDERS = new Set([
  "[silence]",
  "[ silence ]",
  "[no speech captured]",
  NO_SPEECH_STATUS.toLowerCase(),
]);

const SIGNAL_OUTCOME = Object.freeze({
  /** Paste-ready text: paste it. */
  FINAL: "final",
  /** Best-known text, not paste-ready yet: keep waiting for the final. */
  PROVISIONAL: "provisional",
  /** The recording is over and there will be no paste. */
  TERMINAL: "terminal",
});

function normalizeTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isNoSpeechPlaceholder(value) {
  const text = normalizeTranscriptText(value).toLowerCase();
  return !!text && NO_SPEECH_PLACEHOLDERS.has(text);
}

/**
 * Text that can be handed to the user as a transcript: non-empty and not
 * one of the renderer's own no-speech placeholders. Used where the text
 * comes from a store the renderer only fills with transcripts (its
 * paste-ready history, a "transcript"-kind ui-final, last_transcript.json).
 */
function isPasteableTranscript(value) {
  const text = normalizeTranscriptText(value);
  return !!text && !isNoSpeechPlaceholder(text);
}

/**
 * Classify one validated hand-off signal ({ final, text, kind, phase } —
 * the fields desktop/recording-final-slot.js validated; they used to be
 * parsed out of a free-form ``source`` label).
 *
 * Returns ``{ outcome, text, status, upscaling }``:
 *   - FINAL: ``text`` is what to paste.
 *   - PROVISIONAL: ``text`` is the best-known text (never pasted).
 *   - TERMINAL: ``status`` is what the capsule should say.
 *   - ``upscaling``: the renderer has its transcript and is running the
 *     paste upscale now — the capsule shows "Upscaling" until the final
 *     arrives. True only on a PROVISIONAL verdict; this explicit phase is
 *     the one signal of that state since the main process stopped
 *     polling the renderer for it (DM-15).
 */
function classifyRecordingSignal(signal) {
  const s = signal && typeof signal === "object" ? signal : {};
  const text = normalizeTranscriptText(s.text);
  const kind = String(s.kind || "");
  const phase = String(s.phase || "");
  const noSpeech = !text || phase === "no-speech" || isNoSpeechPlaceholder(text);
  if (s.final === true) {
    if (!noSpeech) return { outcome: SIGNAL_OUTCOME.FINAL, text, status: "", upscaling: false };
    return { outcome: SIGNAL_OUTCOME.TERMINAL, text: "", status: NO_SPEECH_STATUS, upscaling: false };
  }
  // Not paste-ready. The renderer marks the pre-upscale publish with the
  // "upscaling" phase, and a transcript-kind publish that is not final is
  // transcript text the renderer has not declared paste-ready — both are
  // best-known text to wait past, not an ending.
  if (!noSpeech && (phase === "upscaling" || kind === "transcript")) {
    return { outcome: SIGNAL_OUTCOME.PROVISIONAL, text, status: "", upscaling: phase === "upscaling" };
  }
  // A status/error publish with nothing to paste: the recording is over.
  return {
    outcome: SIGNAL_OUTCOME.TERMINAL,
    text: "",
    status: noSpeech ? NO_SPEECH_STATUS : text,
    upscaling: false,
  };
}

module.exports = {
  NO_SPEECH_STATUS,
  SIGNAL_OUTCOME,
  normalizeTranscriptText,
  isNoSpeechPlaceholder,
  isPasteableTranscript,
  classifyRecordingSignal,
};
