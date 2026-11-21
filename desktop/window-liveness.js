"use strict";

/**
 * Window liveness — the one owner of "this window's page is alive".
 *
 * Every BrowserWindow the app creates is registered here with `watch`,
 * and this module alone answers the loss of its page process
 * (`webContents` `render-process-gone`). The answer is the same for every
 * window, only the two steps it calls differ per window:
 *
 *   - `restore(win)` — the window object is still there: load its page
 *     again. For the main window that means "once the backend serves",
 *     because the page comes from the backend (./backend-serving).
 *   - `recreate()` — the window or its webContents is gone: build the
 *     window again from the state main.js holds (geometry, status).
 *
 * `onGone(details, { recoverable })` runs first, for every loss, so the
 * window's owner can drop state that died with the page (in-flight
 * recording flags, a screen take, a shortcut capture).
 *
 * `clean-exit` is the page closing with its window and is not recovered;
 * nothing is recovered while the app quits. Losses that arrive while a
 * restore is still running are coalesced into one more restore after it,
 * so a page that dies again mid-load is restored again — and a burst of
 * events is not a burst of loads.
 *
 * The other process kinds (`app` `child-process-gone`) are logged here
 * too. Chromium restarts the GPU and utility processes itself and
 * reconnects live pages to them; no Transcriptor state lives in them, so
 * the log line is the whole answer — and the evidence if one ever is not
 * restarted.
 */

function isRecoverableRendererLoss(reason) {
  return String(reason || "") !== "clean-exit";
}

function errorText(e) {
  return String(e?.message || e || "unknown error");
}

function createWindowLiveness({ log, isQuitting }) {
  function watch(win, spec) {
    const name = String(spec?.name || "window");
    let running = null;
    let again = false;

    function webContentsAlive() {
      try {
        return !!win && !win.isDestroyed() && !!win.webContents && !win.webContents.isDestroyed();
      } catch {
        return false;
      }
    }

    async function recoverOnce() {
      if (isQuitting()) return;
      if (webContentsAlive()) {
        log(`[window-liveness] window=${name} action=restore`);
        await spec.restore(win);
      } else if (typeof spec.recreate === "function") {
        log(`[window-liveness] window=${name} action=recreate`);
        await spec.recreate();
      } else {
        log(`[window-liveness] window=${name} action=none reason=window-gone`);
      }
    }

    function recover() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          try {
            await recoverOnce();
          } catch (e) {
            log(`[window-liveness] window=${name} recovery failed: ${errorText(e)}`);
          }
        } while (again && !isQuitting());
      })().finally(() => { running = null; });
      return running;
    }

    win.webContents.on("render-process-gone", (_event, details) => {
      const reason = String(details?.reason || "unknown");
      const exitCode = details?.exitCode ?? "";
      const recoverable = isRecoverableRendererLoss(reason);
      log(`[window-liveness] window=${name} render-process-gone reason=${reason} exitCode=${exitCode} recover=${recoverable ? 1 : 0}`);
      try {
        spec.onGone?.(details, { recoverable });
      } catch (e) {
        log(`[window-liveness] window=${name} onGone failed: ${errorText(e)}`);
      }
      if (!recoverable) return;
      void recover();
    });

    return { recover };
  }

  function onChildProcessGone(details) {
    const type = String(details?.type || "unknown");
    const reason = String(details?.reason || "unknown");
    const parts = [`type=${type}`, `reason=${reason}`, `exitCode=${details?.exitCode ?? ""}`];
    if (details?.serviceName) parts.push(`service=${details.serviceName}`);
    if (details?.name) parts.push(`name=${JSON.stringify(String(details.name))}`);
    log(`[window-liveness] child-process-gone ${parts.join(" ")}`);
  }

  return { watch, onChildProcessGone };
}

module.exports = { createWindowLiveness, isRecoverableRendererLoss };
