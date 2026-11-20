"use strict";

// What the user is told for each screen-mode warning — one table, keyed by
// the kinds the controller raises (./screen-mode-controller.js
// SCREEN_MODE_WARNING) plus the one main raises itself (the screenshot
// hotkey it binds).
//
// The table used to live in main.js, keyed by retyped strings, and had no
// copy for three kinds the controller raised ("helper", "capture-failed"
// and, after a rename, the failed start): those warnings reached the log
// and nobody else (Ultra-Audit 2026-11-20 D1). The kinds are now imported,
// not retyped, and desktop/screen-mode-warnings.test.js requires copy for
// every one of them.

const { SCREEN_MODE_WARNING } = require("./screen-mode-controller");

/** Raised by main when the screenshot hotkey cannot be registered. */
const SCREEN_SHOT_HOTKEY_WARNING = "screenshot-hotkey";

const SCREEN_MODE_WARNING_COPY = Object.freeze({
  [SCREEN_MODE_WARNING.START_FAILED]: {
    title: "Screen mode didn't start",
    body: "The recording goes on as a voice recording. See the log for the reason, then try screen mode again.",
  },
  [SCREEN_MODE_WARNING.ACCESSIBILITY]: {
    title: "Screen mode can't draw",
    body: "Allow Transcriptor in System Settings → Privacy & Security → Accessibility, then start screen mode again.",
  },
  [SCREEN_MODE_WARNING.SCREEN_RECORDING]: {
    title: "Screen mode can't take screenshots",
    body: "Allow Transcriptor in System Settings → Privacy & Security → Screen & System Audio Recording.",
  },
  [SCREEN_MODE_WARNING.HELPER]: {
    title: "Screen mode stopped drawing",
    body: "The drawing helper quit. The recording goes on and the screenshots taken so far are kept; start screen mode again to draw.",
  },
  [SCREEN_MODE_WARNING.CAPTURE_FAILED]: {
    title: "A screenshot could not be taken",
    body: "The strokes stay on the screen and go into the next screenshot.",
  },
  [SCREEN_SHOT_HOTKEY_WARNING]: {
    title: "Screenshot key is taken",
    body: "Another app holds the screenshot key, so it does nothing in this take. Use the camera button on the capsule, or pick another key in Settings.",
  },
});

/** The copy for a warning kind, or null for a kind with none. */
function screenModeWarningCopy(kind) {
  return Object.prototype.hasOwnProperty.call(SCREEN_MODE_WARNING_COPY, kind)
    ? SCREEN_MODE_WARNING_COPY[kind]
    : null;
}

module.exports = { SCREEN_MODE_WARNING_COPY, SCREEN_SHOT_HOTKEY_WARNING, screenModeWarningCopy };
