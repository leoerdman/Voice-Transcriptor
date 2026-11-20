"use strict";

// The one way the desktop shell starts a normal shutdown
// (Ultra-Audit 2026-11-20 DM-19, review item #4).
//
// `quitApp` is the only caller of `app.quit()`: the window-lifecycle
// table's `quit` action, the paste-capability self-heal relaunch, the
// tray's Quit item and the SIGINT/SIGTERM/SIGHUP handlers all go through
// it, so every shutdown leaves one `[main-window] quit requested` line
// with its reason. `before-quit` (registered in main.js) does the
// teardown; this only starts it.
//
// Pure: Electron's `app`, the process, the logger and the timers are
// injected — desktop/quit-path.test.js drives them with fakes.

/** Exit status a signal-terminated process reports (128 + signal number). */
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
});

/** How long a signal waits for the normal shutdown before forcing the exit. */
const SIGNAL_QUIT_GRACE_MS = 1500;
/**
 * A signal's backend kill escalates to SIGKILL after this — shorter than
 * the grace above so the escalation lands before the forced exit.
 */
const SIGNAL_BACKEND_ESCALATE_AFTER_MS = 250;

/**
 * @param {{
 *   app: {quit: Function},
 *   log: (line: string) => void,
 *   normalizeReason: (reason: string) => string,
 * }} deps ``normalizeReason`` is main.js's one lifecycle-reason rule.
 * @returns {(reason?: string) => void} quitApp
 */
function createQuitApp({ app, log, normalizeReason }) {
  return function quitApp(reason = "") {
    log(`[main-window] quit requested reason=${normalizeReason(reason)}`);
    app.quit();
  };
}

/**
 * SIGINT/SIGTERM/SIGHUP: mark the app quitting, kill the backend with a
 * short escalation, and quit through `quitApp`. If `quitApp` throws, or
 * the normal shutdown has not ended the process within the grace, exit
 * with the signal's status.
 *
 * @param {{
 *   proc: {on: Function},
 *   log: (line: string) => void,
 *   markQuitting: () => void,
 *   killBackend: (reason: string, opts: {escalateAfterMs: number}) => void,
 *   quitApp: (reason: string) => void,
 *   exit: (code: number) => void,
 *   setTimer?: (fn: Function, ms: number) => any,
 * }} deps
 */
function installSignalQuitHandlers({ proc, log, markQuitting, killBackend, quitApp, exit, setTimer = setTimeout }) {
  for (const [sig, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    proc.on(sig, () => {
      log(`[signal] ${sig}`);
      markQuitting();
      killBackend(`signal-${sig}`, { escalateAfterMs: SIGNAL_BACKEND_ESCALATE_AFTER_MS });
      try {
        quitApp(`signal-${sig}`);
      } catch {
        exit(code);
      }
      const exitTimer = setTimer(() => exit(code), SIGNAL_QUIT_GRACE_MS);
      if (typeof exitTimer?.unref === "function") exitTimer.unref();
    });
  }
}

module.exports = {
  SIGNAL_EXIT_CODES,
  SIGNAL_QUIT_GRACE_MS,
  SIGNAL_BACKEND_ESCALATE_AFTER_MS,
  createQuitApp,
  installSignalQuitHandlers,
};
