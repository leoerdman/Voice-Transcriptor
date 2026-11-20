"use strict";

// The silence auto-stop configuration main's recording monitor applies
// (FU-13c, Ultra-Audit 2026-11-20).
//
// The setting and its numbers belong to the renderer: Settings owns the
// toggle, and the defaults and bounds are `UI_TOKENS.autoStopSilence` in
// frontend/src/main.tsx, which clamps every value it publishes through
// `window.__transcriptorLiveStatusSnapshot().autoStopSilence`. main.js
// used to keep a second copy of those defaults
// (`DEFAULT_RECORDING_AUTO_STOP_CONFIG = {enabled:false, seconds:2,
// thresholdDb:-42}`) as its fallback — numbers nothing but a test held in
// step with the renderer's. A fallback only needs to say "off": when the
// renderer has not answered, or answered with something unusable, there
// is no setting to apply, and seconds/threshold of a disabled auto-stop
// are never read.
//
// Pure — desktop/auto-stop-config.test.js.

/** No auto-stop. The numbers are inert: the monitor reads them only when enabled. */
const AUTO_STOP_OFF = Object.freeze({ enabled: false, seconds: 0, thresholdDb: 0 });

/**
 * The renderer's published auto-stop setting, or AUTO_STOP_OFF.
 * Enabled only with a positive finite duration and a finite threshold.
 */
function parseAutoStopConfig(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return AUTO_STOP_OFF;
  const seconds = Number(raw.seconds);
  const thresholdDb = Number(raw.thresholdDb);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(thresholdDb)) return AUTO_STOP_OFF;
  return { enabled: true, seconds, thresholdDb };
}

module.exports = { AUTO_STOP_OFF, parseAutoStopConfig };
