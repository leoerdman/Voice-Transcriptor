"use strict";

// What the shell does when a backend child process exits
// (Ultra-Audit 2026-11-20 DM-09, DM-27).
//
// DM-09: a restart required ``code !== 0 || signal``. A backend that
// exited with code 0 outside shutdown — uvicorn's graceful stop after a
// SIGTERM it re-raised as a clean exit, the parent watchdog's
// ``os._exit(0)``, a ``kill`` from outside — was taken as a clean stop:
// no restart, no boot error, and every dictation failed with connection
// errors until the app was relaunched. The engine install's activation
// ("kill the backend; the exit handler respawns it") worked only when the
// child happened to die by signal. The rule now: the app is not quitting,
// so ANY exit of the live backend is unexpected and it comes back. Exit
// codes still go in the log; they no longer decide.
//
// DM-27: the handler did ``backend = null`` unconditionally. A late exit
// of a PREVIOUS child, arriving after its replacement had spawned, nulled
// the live handle — the next start spawned a second uvicorn and the kill
// path could no longer reach the first. Only the child that is still the
// live handle may clear it, and a superseded child's exit restarts
// nothing.
//
// Pure — desktop/backend-exit.test.js.

const BACKEND_HANDLE = Object.freeze({
  /** This child is the live ``backend``. */
  CURRENT: "current",
  /** ``backend`` is null: the handle was released (a kill, a spawn error). */
  RELEASED: "released",
  /** ``backend`` is a different, newer child. */
  SUPERSEDED: "superseded",
});

function backendHandleOf(liveBackend, child) {
  if (liveBackend === child) return BACKEND_HANDLE.CURRENT;
  if (liveBackend === null || liveBackend === undefined) return BACKEND_HANDLE.RELEASED;
  return BACKEND_HANDLE.SUPERSEDED;
}

/**
 * @param {{code: number|null, signal: string|null, isQuitting: boolean, handle: string}} input
 * @returns {{forgetHandle: boolean, restart: boolean, abnormal: boolean}}
 */
function decideBackendExit({ code = null, signal = null, isQuitting = false, handle } = {}) {
  const abnormal = Number(code || 0) !== 0 || (signal != null && signal !== "");
  return {
    forgetHandle: handle === BACKEND_HANDLE.CURRENT,
    restart: !isQuitting && handle !== BACKEND_HANDLE.SUPERSEDED,
    abnormal,
  };
}

module.exports = { BACKEND_HANDLE, backendHandleOf, decideBackendExit };
