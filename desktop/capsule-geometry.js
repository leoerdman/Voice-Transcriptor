"use strict";

// The recording capsule's window size and placement
// (Ultra-Audit 2026-11-20 DM-13, DM-25).
//
// DM-13: the capsule's size had two sources. Main built the pill's CSS
// from fixed constants (110 px, or 110 + gap + icon in screen mode), then
// the capsule page MEASURED that pill and sent the size back over
// ``document.title`` so main could resize the window. Until the first
// measurement arrived the window was 110 px, so the 126 px screen-mode
// pill was clipped on the first frames of every screen take. The pill's
// size is a function of one flag; so is the window's.
//
// DM-25: every capsule update — including the level ticks the monitor
// sends up to ~5.5 times a second — called setBounds() with a position
// derived from the CURSOR's display, plus a screen-mode layout pass. On
// a multi-monitor desk the capsule jumped to wherever the pointer was,
// mid-take. The capsule is placed when it appears and when its size
// changes, on the display it is already on; level and status ticks only
// repaint.
//
// Pure — desktop/capsule-geometry.test.js.

/**
 * @param {{width: number, maxWidth: number, height: number}} capsule
 *   the RECORDING_STATUS_CAPSULE constants
 * @param {boolean} screenMode
 */
function capsuleWindowSize(capsule, screenMode) {
  return {
    width: screenMode ? capsule.maxWidth : capsule.width,
    height: capsule.height,
  };
}

/** Centered at the bottom of ``workArea``, ``bottomMargin`` above its edge. */
function capsuleBoundsIn(workArea, size, bottomMargin) {
  const area = workArea || { x: 0, y: 0, width: 1440, height: 900 };
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + area.height - size.height - bottomMargin),
    width: size.width,
    height: size.height,
  };
}

/**
 * Does this update have to move or resize the window? Only when it is
 * about to appear, or when its size is not the one it was placed with.
 */
function capsuleNeedsPlacement({ visible, placedSize, size }) {
  if (!visible || !placedSize) return true;
  return placedSize.width !== size.width || placedSize.height !== size.height;
}

module.exports = { capsuleWindowSize, capsuleBoundsIn, capsuleNeedsPlacement };
