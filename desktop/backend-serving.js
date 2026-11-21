"use strict";

/**
 * "The backend is serving" — one answer, held in one place.
 *
 * The main window's page is served by the backend, so a page can only be
 * (re)loaded while the backend answers. Before this module that fact was
 * re-derived by every caller with its own poll and its own timeout, and
 * the renderer-recovery path did not derive it at all: on 2026-11-21 at
 * 05:54:37 UTC macOS sent SIGTERM to the renderer AND the backend at once,
 * the recovery loaded the page 500 ms later against a backend that was
 * still restarting (ERR_CONNECTION_REFUSED), and when the backend came
 * back healthy nothing loaded the page again. The window stayed black.
 *
 * The state has three values and moves only on facts main.js observes:
 *
 *   starting → serving   /api/health answered with this boot's nonce
 *   any      → down      the backend process exited
 *   any      → failed    the restart budget ran out (no restart coming)
 *
 * `whenServing()` resolves at once while serving, waits while starting or
 * down (a restart is on its way), and rejects while failed. No timer, no
 * poll: the waiters are settled by the transitions themselves.
 */

const BACKEND_SERVING_STATES = Object.freeze({
  starting: "starting",
  serving: "serving",
  down: "down",
  failed: "failed",
});

function createBackendServing() {
  let state = BACKEND_SERVING_STATES.starting;
  let failure = null;
  let waiters = [];

  function settle(fn) {
    const pending = waiters;
    waiters = [];
    for (const w of pending) fn(w);
  }

  return {
    state: () => state,
    markServing() {
      state = BACKEND_SERVING_STATES.serving;
      failure = null;
      settle((w) => w.resolve());
    },
    markDown() {
      state = BACKEND_SERVING_STATES.down;
      failure = null;
    },
    markFailed(reason) {
      state = BACKEND_SERVING_STATES.failed;
      failure = new Error(String(reason || "backend failed"));
      const err = failure;
      settle((w) => w.reject(err));
    },
    whenServing() {
      if (state === BACKEND_SERVING_STATES.serving) return Promise.resolve();
      if (state === BACKEND_SERVING_STATES.failed) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

/**
 * Load a page that the backend serves, once the backend serves.
 *
 * The state can say "serving" a moment after the backend died: on
 * 2026-11-21 the renderer's loss reached main at 05:54:37.397 and the
 * backend's exit at .447, so a load in between hit a closed port. A failed
 * load is therefore evidence, not an end: `confirmServing()` asks the
 * backend itself (bounded; it rejects when the backend does not answer)
 * and the load runs again. ERR_ABORTED means a newer navigation took over
 * and ends the attempt. `maxLoads` bounds the pathological case of a
 * backend that answers its health check yet cannot serve the page.
 */
async function loadWhenServing({ serving, load, confirmServing, maxLoads = 3 }) {
  for (let attempt = 1; ; attempt += 1) {
    await serving.whenServing();
    try {
      await load();
      return;
    } catch (e) {
      if (e?.code === "ERR_ABORTED" || attempt >= maxLoads) throw e;
      await confirmServing();
    }
  }
}

module.exports = { createBackendServing, loadWhenServing, BACKEND_SERVING_STATES };
