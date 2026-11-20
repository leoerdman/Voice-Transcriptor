"use strict";

// At most one run of an operation at a time (Ultra-Audit 2026-11-20 DM-06).
//
// The GigaAM engine install claimed its "in flight" flag only after an
// up-to-60 s import probe, so two invokes inside that window (double
// click, two windows, a StrictMode double effect) both passed the check
// and ran two multi-GB pip installs into one staging directory. The fix
// is that the check and the claim are one synchronous step: ``tryRun``
// starts the operation and records its promise before it returns, so no
// caller can observe "free" between another caller's check and claim.
//
// Pure: no Electron, no timers — desktop/single-flight.test.js.

function createSingleFlight() {
  let inFlight = null;
  return {
    /** A run is in progress. */
    get busy() {
      return inFlight !== null;
    },
    /**
     * Start ``start()`` unless a run is in progress.
     *
     * Returns the run's promise (it settles as ``start()``'s does), or
     * ``null`` when another run holds the flight. The flight is released
     * when the run settles, whichever way — including a synchronous throw
     * from ``start``.
     */
    tryRun(start) {
      if (inFlight) return null;
      let run;
      try {
        run = Promise.resolve(start());
      } catch (error) {
        run = Promise.reject(error);
      }
      // Claimed on this synchronous turn: ``finally`` callbacks always run
      // on a later microtask, so the claim below precedes the release.
      const held = run.finally(() => {
        if (inFlight === held) inFlight = null;
      });
      inFlight = held;
      return held;
    },
  };
}

module.exports = { createSingleFlight };
