"use strict";

// SSOT for "which system power events this app reacts to, and what each
// one means".
//
// Two shipped fixes died here once already. `powerMonitor.on("resume")`
// (BUG-81 hotkey re-claim) and the `suspend` / `lock-screen` warm-capture
// release were written for the top level of `app.whenReady`, but landed
// physically nested inside `restoreShortcutsAfterCaptureAbort` — a
// function that returns early unless the user opened Settings, started a
// hotkey capture and then aborted it. In a normal session nothing was
// ever subscribed, and every abort added one more duplicate subscription
// on top.
//
// The registration therefore does not live in main.js as loose statements
// any more. It lives behind one call with three properties a test can
// check without an Electron process:
//
//   * the event → action mapping is data, not control flow;
//   * subscribing twice against the same powerMonitor is a no-op, so a
//     caller that runs more than once cannot accumulate handlers;
//   * a handler that throws is contained — a failed shortcut re-claim
//     must not stop the warm-capture release, and neither may take the
//     app down from inside an OS event callback.

/** What the app does when the OS announces each power transition. */
const POWER_EVENT_ACTIONS = Object.freeze({
  // The machine slept. Another app may have claimed our accelerators
  // while we were away and the OS may have dropped them; registration is
  // idempotent (unregister-then-register), so re-claiming is safe.
  resume: "reclaim-shortcuts",
  // The renderer keeps a microphone capture warm between recordings and
  // cannot see powerMonitor — it lives in main. A warm capture carried
  // across a suspend comes back attached to a device that may no longer
  // exist: silence, with no error and no waveform. Sent on both events,
  // because a lock does not always become a suspend and a suspend does
  // not always announce a lock first.
  suspend: "release-warm-capture",
  "lock-screen": "release-warm-capture",
  // The OS is shutting down or logging out (Linux, macOS; Windows reports
  // it as the window's `session-end`, which main routes to the same
  // handler). The window's close-confirmation (DM-30) must never hold up
  // an ending session: the session ends whether or not the dialog is
  // answered, and a held close only turns a clean exit into a killed one.
  shutdown: "end-session",
});

/** Every event name the app subscribes to, in registration order. */
const POWER_EVENTS = Object.freeze(Object.keys(POWER_EVENT_ACTIONS));

/** Action names, so callers name them instead of retyping the strings. */
const POWER_ACTIONS = Object.freeze({
  RECLAIM_SHORTCUTS: "reclaim-shortcuts",
  RELEASE_WARM_CAPTURE: "release-warm-capture",
  END_SESSION: "end-session",
});

/**
 * The action for one event name, or "" for anything not subscribed.
 * Pure: the decision is readable without an OS or an Electron process.
 */
function powerEventAction(event) {
  const key = String(event || "");
  return Object.prototype.hasOwnProperty.call(POWER_EVENT_ACTIONS, key)
    ? POWER_EVENT_ACTIONS[key]
    : "";
}

// One entry per powerMonitor object we have already wired, so a second
// call cannot double-subscribe. WeakSet: a test's fake monitor must not
// be retained after the test drops it.
const subscribedMonitors = new WeakSet();

/**
 * Subscribe the app's power handlers to `powerMonitor`, once.
 *
 * @param {{on: Function}} powerMonitor Electron's powerMonitor (or a fake).
 * @param {object} handlers
 * @param {Function} handlers.reclaimShortcuts   run on resume
 * @param {Function} handlers.releaseWarmCapture run on suspend / lock-screen, given the event name
 * @param {Function} [handlers.endSession]       run on shutdown (the OS is ending the session)
 * @param {Function} [handlers.log]              one line per event and per handler failure
 * @returns {{registered: string[], alreadySubscribed: boolean}}
 */
function subscribePowerEvents(powerMonitor, handlers = {}) {
  const { reclaimShortcuts, releaseWarmCapture, endSession, log } = handlers;
  if (!powerMonitor || typeof powerMonitor.on !== "function") {
    throw new TypeError("subscribePowerEvents: powerMonitor with .on() is required");
  }
  if (typeof reclaimShortcuts !== "function" || typeof releaseWarmCapture !== "function") {
    throw new TypeError("subscribePowerEvents: reclaimShortcuts and releaseWarmCapture are required");
  }
  if (subscribedMonitors.has(powerMonitor)) {
    return { registered: [], alreadySubscribed: true };
  }
  subscribedMonitors.add(powerMonitor);

  const note = typeof log === "function" ? log : () => { };
  const registered = [];
  for (const event of POWER_EVENTS) {
    const action = powerEventAction(event);
    powerMonitor.on(event, () => {
      note(`[power] ${event} — ${action}`);
      try {
        if (action === POWER_ACTIONS.RECLAIM_SHORTCUTS) reclaimShortcuts(event);
        else if (action === POWER_ACTIONS.END_SESSION) { if (typeof endSession === "function") endSession(event); }
        else releaseWarmCapture(event);
      } catch (e) {
        // An OS event callback is not a place to throw from: the other
        // subscriptions on the same transition still have to run.
        note(`[power] ${event} handler failed: ${e?.message || e}`);
      }
    });
    registered.push(event);
  }
  return { registered, alreadySubscribed: false };
}

/** Test seam: forget that `powerMonitor` was wired, so it can be wired again. */
function _resetPowerEventSubscriptions(powerMonitor) {
  if (powerMonitor) subscribedMonitors.delete(powerMonitor);
}

module.exports = {
  POWER_EVENTS,
  POWER_ACTIONS,
  powerEventAction,
  subscribePowerEvents,
  _resetPowerEventSubscriptions,
};
