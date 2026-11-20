"use strict";

// Who owns the snapshot of the user's REAL clipboard during a paste
// (Ultra-Audit 2026-11-20 DM-02, DM-26).
//
// A paste overwrites the clipboard with the transcript and, once the
// target has verifiably received it, puts back what the user had. Two
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

module.exports = { createClipboardLeases };
