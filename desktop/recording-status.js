"use strict";

// SSOT for "what state is the recording capsule in".
//
// The capsule's only input is a human-readable status string, and the
// machine state was recovered from it by TWO independent substring
// ladders — `recordingStatusMode` for the icon/wave/timer and
// `recordingStatusTone` for the colour. Copies of one decision drift,
// and these had:
//
//   "Starting"          -> mode recording, tone NEUTRAL
//   "App Loading"       -> mode fail,      tone warning
//   "Grant Access"      -> mode fail,      tone warning
//   "App Not Ready"     -> mode transcribing (the default), tone warning
//   "Mic Not Started"   -> mode transcribing, tone neutral
//                          (a terminal error shown as work in progress)
//   "Pasting"           -> mode transcribing, tone neutral
//   "Timed out, but the transcript is on your clipboard…"
//                       -> mode transcribing, tone neutral
//                          (the final recovery status, shown as unfinished)
//
// Nothing about the product requires a status to be a failure by mode
// and a warning by tone. So: a status now travels WITH its kind, and
// mode and tone are two views of that one value — they cannot disagree.
//
// The text ladder does not disappear, because one producer still sends
// text only: the RENDERER. Its user-facing copy ("Recording with live
// preview enabled.", "Recording exceeds 2 hours — …") was being parsed
// here by substring, which made UI copywriting in frontend/src/main.tsx
// a de-facto API for the capsule's colour. That ladder is now ONE
// function, in one place, with the renderer vocabulary enumerated next to it and asserted by a test — so at least the
// coupling is visible and checked. When the renderer starts sending its
// own `statusKind` (it already computes one for itself), the ladder goes.

/** Machine state of a recording status. One value, two views. */
const RECORDING_STATUS_KIND = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RECORDING: "recording",
  /** Silence countdown running: the take will stop unless the user speaks. */
  AUTOSTOP: "autostop",
  TRANSCRIBING: "transcribing",
  UPSCALING: "upscaling",
  /** Terminal success. */
  OK: "ok",
  /** Terminal, recoverable by the user — the transcript is safe. */
  WARN: "warn",
  /** Terminal failure. */
  FAIL: "fail",
});

/**
 * How each kind is drawn: `mode` picks the icon, the wave and whether
 * the timer runs; `tone` picks the colour.
 */
const RECORDING_STATUS_PRESENTATION = Object.freeze({
  [RECORDING_STATUS_KIND.IDLE]: Object.freeze({ mode: "idle", tone: "neutral" }),
  [RECORDING_STATUS_KIND.STARTING]: Object.freeze({ mode: "recording", tone: "recording" }),
  [RECORDING_STATUS_KIND.RECORDING]: Object.freeze({ mode: "recording", tone: "recording" }),
  [RECORDING_STATUS_KIND.AUTOSTOP]: Object.freeze({ mode: "autostop", tone: "warning" }),
  [RECORDING_STATUS_KIND.TRANSCRIBING]: Object.freeze({ mode: "transcribing", tone: "processing" }),
  [RECORDING_STATUS_KIND.UPSCALING]: Object.freeze({ mode: "upscaling", tone: "processing" }),
  [RECORDING_STATUS_KIND.OK]: Object.freeze({ mode: "ok", tone: "success" }),
  [RECORDING_STATUS_KIND.WARN]: Object.freeze({ mode: "fail", tone: "warning" }),
  [RECORDING_STATUS_KIND.FAIL]: Object.freeze({ mode: "fail", tone: "error" }),
});

/** Modes whose capsule runs the elapsed timer and the live waveform. */
const LIVE_RECORDING_KINDS = Object.freeze([
  RECORDING_STATUS_KIND.STARTING,
  RECORDING_STATUS_KIND.RECORDING,
  RECORDING_STATUS_KIND.AUTOSTOP,
]);

/**
 * The renderer's own status copy, which main.js has to classify because
 * the renderer sends text and not a kind. Listed here so that changing a
 * sentence in frontend/src/main.tsx breaks a test rather than silently
 * repainting the capsule.
 */
const RENDERER_STATUS_VOCABULARY = Object.freeze([
  Object.freeze({ text: "Recording with live preview enabled.", kind: RECORDING_STATUS_KIND.RECORDING }),
  Object.freeze({ text: "Recording with live preview enabled. Local assist is canonical for fast stop.", kind: RECORDING_STATUS_KIND.RECORDING }),
  Object.freeze({ text: "Recording exceeds 2 hours — the WebM fallback keeps only the last 2 h. Canonical PCM audio is unaffected.", kind: RECORDING_STATUS_KIND.RECORDING }),
]);

/** Is this one of the kinds the module knows? */
function isRecordingStatusKind(kind) {
  return Object.prototype.hasOwnProperty.call(RECORDING_STATUS_PRESENTATION, String(kind || ""));
}

/**
 * The single text ladder, for statuses that arrive without a kind.
 * Ordered most-specific first; every branch is covered by a test that
 * walks the real vocabulary of both processes.
 */
function classifyRecordingStatusText(status) {
  const text = String(status || "").trim().toLowerCase();
  const K = RECORDING_STATUS_KIND;
  if (!text) return K.IDLE;

  // Terminal successes, named exactly.
  if (
    text.startsWith("recording completed") ||
    text.startsWith("final transcript is ready") ||
    text.startsWith("transcript is ready") ||
    text.includes("no speech detected")
  ) {
    return K.OK;
  }
  // A silence countdown is running: amber, but the take is still live.
  if (text.includes("auto stop")) return K.AUTOSTOP;
  if (
    text === "starting" ||
    text === "recording" ||
    text.startsWith("recording.") ||
    text.startsWith("recording with ") ||
    text.startsWith("recording audio only") ||
    text.startsWith("recording exceeds ")
  ) {
    return text === "starting" ? K.STARTING : K.RECORDING;
  }
  if (text.includes("upscal")) return K.UPSCALING;
  if (text.includes("transcrib") || text.includes("processing") || text.includes("pasting")) {
    return K.TRANSCRIBING;
  }
  if (text.includes("pasted") || text.includes("sent") || text.includes("saved") || text.includes("done")) {
    return K.OK;
  }
  // "In Clipboard …" is the recovery status: the paste did not land but
  // the transcript is one keypress away. A warning, not an error.
  if (text.includes("in clipboard") || text.includes("clipboard")) return K.WARN;
  if (text.includes("access") || text.includes("loading") || text.includes("not ready")) return K.WARN;
  if (
    text.includes("fail") ||
    text.includes("error") ||
    text.includes("no text") ||
    text.includes("not started") ||
    text.includes("timed out")
  ) {
    return K.FAIL;
  }
  // Anything unrecognised is still work in progress rather than a
  // verdict we have not earned.
  return K.TRANSCRIBING;
}

/**
 * Presentation for a status. `kind` wins when the producer named one;
 * otherwise the text is classified.
 */
function recordingStatusPresentation(status, kind = "") {
  const resolved = isRecordingStatusKind(kind) ? kind : classifyRecordingStatusText(status);
  return { kind: resolved, ...RECORDING_STATUS_PRESENTATION[resolved] };
}

/** Does the capsule run its timer and waveform for this kind? */
function recordingStatusIsLive(kind) {
  return LIVE_RECORDING_KINDS.includes(kind);
}

module.exports = {
  RECORDING_STATUS_KIND,
  RECORDING_STATUS_PRESENTATION,
  LIVE_RECORDING_KINDS,
  RENDERER_STATUS_VOCABULARY,
  isRecordingStatusKind,
  classifyRecordingStatusText,
  recordingStatusPresentation,
  recordingStatusIsLive,
};
