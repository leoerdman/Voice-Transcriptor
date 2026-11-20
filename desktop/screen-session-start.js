"use strict";

// What main does once screenMode.start() has answered for a take the
// renderer is already recording (Ultra-Audit 2026-11-20 DM-31, S-02 / S-04,
// review D2 / D3).
//
// The renderer was told "screen take" with the press, so it opened its
// live session for the Screen Sessions collection. Three answers:
//
//   * STARTED — the take and its session are live. Nothing to do.
//   * ENDED — the take's own stop reached the controller before its start
//     (a quick stop). The controller refused to open a session nobody
//     would finish; that is the whole of "this take already ended" — one
//     mechanism, the controller's tombstone, fed by every way a take ends
//     (the renderer's screen-mode:finish, and main's
//     endScreenModeForLostRenderer, both naming the take's id). A normal
//     outcome: no warning, and nothing to tell a renderer whose take is
//     already over.
//   * FAILED — the user has been warned by the controller (the one owner
//     of that notification), and the renderer must be told the take is a
//     voice take, so it is not filed under Screen Sessions — whose
//     retention keeps far fewer recordings' audio — without a screen
//     session.
//
// A start() that rejected or answered nothing usable counts as FAILED.
//
// Pure — desktop/screen-session-start.test.js.

const { SCREEN_START_OUTCOME } = require("./screen-mode-controller");

const AFTER_SCREEN_START = Object.freeze({
  /** The take is live and so is its session. */
  KEEP: "keep",
  /** The take ended before its session could start: nothing to do. */
  ENDED: "ended",
  /** start() failed: the take goes on as a voice take — tell the renderer. */
  VOICE_TAKE: "voice-take",
});

/**
 * @param {{ok?: boolean, outcome?: string}|null|undefined} started
 *   what screenMode.start() resolved to (null when it rejected)
 */
function decideAfterScreenStart(started) {
  const outcome = started && typeof started === "object" ? started.outcome : "";
  if (outcome === SCREEN_START_OUTCOME.STARTED && started.ok === true) return AFTER_SCREEN_START.KEEP;
  if (outcome === SCREEN_START_OUTCOME.ENDED) return AFTER_SCREEN_START.ENDED;
  return AFTER_SCREEN_START.VOICE_TAKE;
}

module.exports = { AFTER_SCREEN_START, decideAfterScreenStart };
