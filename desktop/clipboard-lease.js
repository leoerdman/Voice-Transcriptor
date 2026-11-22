"use strict";

// Who owns the snapshot of the user's REAL clipboard during a paste
// (Ultra-Audit 2026-11-20 DM-02, DM-26).
//
// A paste overwrites the clipboard with the transcript and, once the
// paste is out and nobody has copied anything since, puts back what the
// user had (clipboardRestoreDecision below). Two
// rules make that possible, and both were broken:
//
//  1. The snapshot is taken BEFORE anything writes the transcript. Both
//     production callers (the post-stop task and the paste-last hotkey)
//     wrote the transcript first and the paste ladder snapshotted after,
//     so the "original" it restored was the transcript itself and the
//     user's clipboard was destroyed by every dictation. The ladder now
//     takes the lease and writes the text in one place, and the callers
//     no longer write at all.
//
//  2. Every lease is released exactly once. The depth counter was paired
//     by hand at a dozen return points; any throw between acquire and a
//     return left the depth above zero forever, and every later paste
//     reused a stale snapshot. A lease is released by an explicit
//     outcome (restore scheduled, transcript kept) or, failing that, by
//     the caller's ``finally`` — and releasing twice is a no-op.
//
// One writer stands outside the lease on purpose: the post-stop timeout
// recovery (main.js handlePostStopTranscriptTimeout) puts the transcript
// on the clipboard WITHOUT pasting it. No paste means nothing to restore,
// so there is no snapshot to take; and a restore window still open from
// an earlier paste aborts by itself when it sees content it did not write.
//
// Chained pastes share one snapshot: a second paste that starts while the
// first one's restore window is still open must not capture the first
// transcript as "original" content. The shared snapshot lives until the
// last outstanding lease is released.
//
// Pure: the snapshot itself is taken by the injected function, so the
// accounting is tested without Electron (desktop/clipboard-lease.test.js).

function createClipboardLeases(takeSnapshot) {
  let depth = 0;
  let shared = null;

  function releaseOne() {
    depth = Math.max(0, depth - 1);
    if (depth === 0) shared = null;
  }

  /**
   * Take a lease on the shared snapshot. The first lease of a chain takes
   * the snapshot; later ones reuse it.
   *
   * The returned lease:
   *   - ``snapshot`` — the user's clipboard as it was before the chain.
   *   - ``release()`` — give the lease back now. Idempotent.
   *   - ``handOff()`` — the lease outlives this call (a delayed restore
   *     owns it); returns the release function the new owner calls.
   *   - ``settle()`` — for a ``finally``: release unless handed off.
   */
  function acquire() {
    depth += 1;
    if (shared === null) shared = takeSnapshot();
    const snapshot = shared;
    let released = false;
    let handedOff = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseOne();
    };
    return {
      snapshot,
      release,
      handOff() {
        handedOff = true;
        return release;
      },
      settle() {
        if (!handedOff) release();
      },
    };
  }

  return {
    acquire,
    /** Outstanding leases — for tests and diagnostics. */
    depth: () => depth,
  };
}

// ── When the user's clipboard is put back (OPTIMIZATION.md 1.5) ─────────
//
// The restore used to wait for a VERIFIED paste. Verification needs an
// accessibility read of the target's text, and the apps people dictate
// into most (Claude desktop, Chromium-based editors) expose none: in the
// 2026-11 logs 14 of 308 pastes were verified, so in ~95% of dictations
// the user's clipboard was replaced by the transcript for good.
//
// The rule now is Hex's (src/paste.rs): once the paste chord is out, wait
// CLIPBOARD_RESTORE_DELAY_MS for the target to read the pasteboard, then
// put the original back — but only if the clipboard still holds exactly
// what we wrote. A clipboard somebody changed in that window (the user's
// own ⌘C, a later paste of ours) is left alone. "Still ours" is the
// pasteboard change count where the native helper reports it, and the
// text we wrote where only Electron's clipboard is available.
//
// A paste that FAILED keeps the transcript (main.js
// keepTranscriptOnClipboardAfterFailure): the text the user just
// dictated must not vanish together with the paste.
//
// Windows and Linux keep the verified gate. Their paste chord is sent by
// SendKeys / xdotool, which report success for a keystroke that went
// nowhere (BUGS_AUDIT §6.1) — "sent" there is no evidence the text
// landed, and a restore would take the only copy of the transcript away.
// macOS's chord is a CGEventPost or an AppleScript with a SENT receipt.

/** How long the target gets to read the pasteboard before the restore. */
const CLIPBOARD_RESTORE_DELAY_MS = 500;

/**
 * Should a SUCCESSFUL paste (the chord was sent) put the user's
 * clipboard back?
 *
 * @param {{platform: string, verified?: boolean|null}} paste
 * @returns {{restore: boolean, reason: string}}
 */
function clipboardRestoreDecision({ platform, verified } = {}) {
  if (verified === true) return { restore: true, reason: "verified" };
  if (platform === "darwin") return { restore: true, reason: "sent" };
  return { restore: false, reason: "unverified-send" };
}

/**
 * Does the clipboard still hold what the paste wrote? By change count
 * when both are known (a count says "nobody wrote since", even a write
 * of the same text), by the text otherwise.
 */
function clipboardStillOurs({ writtenChangeCount, currentChangeCount, writtenText, currentText } = {}) {
  const counted = Number.isInteger(writtenChangeCount) && Number.isInteger(currentChangeCount);
  if (counted) return writtenChangeCount === currentChangeCount;
  return String(currentText == null ? "" : currentText) === String(writtenText == null ? "" : writtenText);
}

module.exports = {
  CLIPBOARD_RESTORE_DELAY_MS,
  clipboardRestoreDecision,
  clipboardStillOurs,
  createClipboardLeases,
};
