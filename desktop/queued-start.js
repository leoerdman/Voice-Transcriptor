"use strict";

// A start press that lands while the previous take is still being
// finished is kept and run, not dropped.
//
// The single capsule (one capsule, one take, a post-stop queue that
// pastes in order) used to refuse such a press outright — `toggle_hotkey
// blocked reason=single-capsule-post-stop-active`, seven times in two
// days of logs — and the press did nothing at all. Five of the seven
// landed in the 900 ms the capsule spends showing "Paste Sent" after the
// paste had already happened; that dwell no longer holds the press back
// (main.js schedules it on a timer instead of sleeping in the worker).
//
// The rest land while a take is really still being finished: the renderer
// waiting for the final transcript, the main process pasting it, or the
// renderer still closing its take (busy). A new take cannot start in
// parallel with that:
//
//  - the renderer keeps one take's capture, socket and sink in module
//    state that its stop path reads across every await — a second take
//    started meanwhile would be written into the same slots;
//  - the paste borrows the clipboard and the keyboard: a start snapshots
//    the user's clipboard (`clipboard-prepare`) while the paste has the
//    transcript on it, and the native ⌘V waits for the modifiers the
//    hotkey itself holds down;
//  - the stop tone of the take being finished must not open the next one.
//
// So the press is QUEUED and the take starts the moment the previous one
// is done: the capsule shows the queued state, a second press cancels it
// (the hotkey stays a toggle), and a queue that cannot be served within
// `QUEUED_START_MAX_WAIT_MS` ends with a visible failure, never silently.
// One slot: a take is one press.
//
// Pure apart from the injected clock. Tested in queued-start.test.js.

/** How often a start queued behind a busy renderer is tried again. */
const QUEUED_START_RETRY_MS = 150;

/**
 * The longest a queued start waits. The renderer's slowest finish is its
 * recovery path (final envelope up to ~4 s + REST/local recovery capped
 * at 20 s + upscale 3 s); past 30 s the user has long since given up on
 * the press, and starting a recording then would surprise them.
 */
const QUEUED_START_MAX_WAIT_MS = 30_000;

/**
 * @param {{now?: () => number, maxWaitMs?: number}} [options]
 */
function createQueuedStart({ now = Date.now, maxWaitMs = QUEUED_START_MAX_WAIT_MS } = {}) {
  /** @type {null | {mode: string, queuedAt: number}} */
  let pending = null;
  return {
    /** The queued start, or null. */
    get pending() {
      return pending;
    },
    /**
     * A start press that cannot run now. Queues it, or — when one is
     * already queued — cancels that one: a second press is the toggle's
     * "never mind".
     * @returns {{action: "queued"|"cancelled", entry: {mode: string, queuedAt: number}}}
     */
    press(mode = "voice") {
      if (pending) {
        const entry = pending;
        pending = null;
        return { action: "cancelled", entry };
      }
      pending = { mode: mode === "screen" ? "screen" : "voice", queuedAt: now() };
      return { action: "queued", entry: pending };
    },
    /** How long the queued start has waited, ms (0 when none). */
    waitedMs() {
      return pending ? Math.max(0, now() - pending.queuedAt) : 0;
    },
    /** Has the queued start waited past the limit? */
    expired() {
      return !!pending && now() - pending.queuedAt > maxWaitMs;
    },
    /** Drop the queued start (it ran, expired, or its renderer is gone). */
    clear() {
      const entry = pending;
      pending = null;
      return entry;
    },
  };
}

module.exports = {
  QUEUED_START_RETRY_MS,
  QUEUED_START_MAX_WAIT_MS,
  createQueuedStart,
};
