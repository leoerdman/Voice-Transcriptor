"use strict";

// The record hotkey's one renderer round trip (Ultra-Audit 2026-11-20
// DM-05).
//
// The main process asks the renderer "are you recording?" and, in the
// same evaluation, toggles. It waits at most RENDERER_TOGGLE_BUDGET_MS and
// then gives up — but ``executeJavaScript`` cannot be cancelled. A
// renderer that unblocked a moment later still ran the toggle: it started
// a recording after main had already reset the status and released the
// press, so there was no capsule, no monitor and no paste target, and the
// user's retry STOPPED the invisible recording they did not know had
// started.
//
// The press now carries its own expiry. The script refuses to dispatch
// once the wall clock (the same system clock in both processes) has
// passed ``notAfter``, which is set short of the main-side budget by
// RENDERER_TOGGLE_RETURN_MARGIN_MS so that an answer produced in time
// also has time to travel back before main stops listening.
//
// Pure: returns the script text; desktop/renderer-toggle.test.js runs it
// in a VM against a fake window.

const RENDERER_TOGGLE_BUDGET_MS = 2000;
const RENDERER_TOGGLE_RETURN_MARGIN_MS = 250;

function toggleNotAfter(now = Date.now()) {
  return now + RENDERER_TOGGLE_BUDGET_MS - RENDERER_TOGGLE_RETURN_MARGIN_MS;
}

function toggleDispatchScript({ allowStart, startDetail = { mode: "voice" }, notAfter }) {
  const deadline = Number.isFinite(notAfter) ? Math.trunc(notAfter) : 0;
  return `
    (() => {
      // This press expired before the renderer got to it: the main
      // process has already given up on it. Doing nothing is the only
      // answer that cannot start a recording nobody is watching.
      if (Date.now() > ${deadline}) return { ok: false, expired: true, uiReady: false, dispatched: false };
      const uiReady = typeof window.__transcriptorLiveStatusSnapshot === 'function';
      const isRec = !!(window.__transcriptorIsRecording);
      const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
      const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
      const liveSnapshot = uiReady ? window.__transcriptorLiveStatusSnapshot() : null;
      const autoSendEnter = !!liveSnapshot?.autoSendEnter;
      const timerText = String(liveSnapshot?.timerText || '00:00').trim();
      // The renderer owns the recording clock and the floor under it.
      // Asking it — rather than timing the press here — is what keeps
      // the two processes from disagreeing about whether this stop
      // produced anything.
      const tooShort = isRec && typeof window.__transcriptorRecordingTooShort === 'function'
        ? !!window.__transcriptorRecordingTooShort()
        : false;
      const state = { ok: true, uiReady, wasRecording: isRec, recording: isRec, dispatched: false, discarded: tooShort, auto, autoSendEnter, timerText, recordingId };
      if (!uiReady) return state;
      if (!isRec && !${allowStart ? "true" : "false"}) return state;
      // The detail is read only when this press STARTS a recording: it says
      // which kind (voice or screen) and, for screen mode, the session id
      // the renderer hands back to main when the take stops.
      window.dispatchEvent(new CustomEvent('transcriptor-hotkey-toggle', { detail: ${JSON.stringify(startDetail)} }));
      state.dispatched = true;
      state.recording = !isRec;
      return state;
    })();
    `;
}

module.exports = {
  RENDERER_TOGGLE_BUDGET_MS,
  RENDERER_TOGGLE_RETURN_MARGIN_MS,
  toggleNotAfter,
  toggleDispatchScript,
};
