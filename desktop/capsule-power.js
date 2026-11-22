"use strict";

/**
 * The recording capsule window is built once, kept for the whole session
 * and only shown and hidden. What it costs while hidden is decided here,
 * in one place:
 *
 *   - asleep (hidden): `backgroundThrottling` on, so Chromium stops the
 *     page's timers and animation frames and the compositor has nothing
 *     to tick. This is what the old "destroy it after 8 s idle" policy
 *     bought with a 110-380 ms re-create on the next press: a hidden window
 *     created with throttling off kept its compositor running (~13% of a
 *     core at idle, and the shared GPU process with it).
 *   - awake (about to be shown / shown): throttling off. The capsule is a
 *     `focusable: false` window that the OS never treats as the active
 *     one, so with throttling on its level wave and timer would stall
 *     while it is on screen.
 *
 * `awake` runs before the first paint is sent and before `showInactive`,
 * `sleep` hides the window and then throttles it. Both are idempotent.
 */
function createCapsulePower({ log = () => { } } = {}) {
  function setThrottling(win, on) {
    try {
      win.webContents.setBackgroundThrottling(on);
      return true;
    } catch (e) {
      log(`[recording-capsule] throttling=${on} failed: ${e?.message || e}`);
      return false;
    }
  }
  return {
    awake(win) {
      if (!win || win.isDestroyed()) return;
      setThrottling(win, false);
    },
    sleep(win) {
      if (!win || win.isDestroyed()) return;
      try { win.hide(); } catch { }
      setThrottling(win, true);
    },
  };
}

/** The one log line per recording: hotkey press to capsule on screen. */
function capsulePressMetricLine({ pressedAt, now, status }) {
  const pressed = Number(pressedAt || 0);
  if (!(pressed > 0)) return "";
  return `[recording-capsule] press_to_capsule_visible_ms=${Math.max(0, now - pressed)} status="${status}"`;
}

module.exports = { createCapsulePower, capsulePressMetricLine };
