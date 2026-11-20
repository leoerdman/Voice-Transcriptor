"use strict";

// "Is this our own app?" — one rule for the paste target checks
// (Ultra-Audit 2026-11-20 DM-16, review item #4).
//
// Exact names, derived from the app's name rather than retyped: a
// substring check on the product name would exclude third-party apps
// whose name contains the word ("Audio Transcriptor Pro"). Both the
// activation check and the paste-target check ask isOwnAppName.
//
// Pure: the app name and this process's pid are injected —
// desktop/own-process-rules.test.js drives them.

/**
 * @param {{ appName: () => string, pid: number }} deps ``appName`` is
 *   asked on every check (Electron's ``app.getName()``).
 */
function createOwnProcessRules({ appName, pid }) {
  /** Is this process name our own app (the app, or its helper)? */
  function isOwnAppName(name) {
    const n = String(name || "").trim().toLowerCase();
    const own = String(appName() || "").trim().toLowerCase();
    return !!n && !!own && (n === own || n === `${own} helper`);
  }

  /** May a window of the app with this name be activated as a paste target? No for these. */
  function isBadActivationTarget(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return true;
    // Our own process family, plus "electron": by name alone a bare
    // Electron process is not a safe target (it may be us in a dev run,
    // or the shell of an app whose real window is elsewhere). Electron
    // helpers have deterministic suffixes that substring match is
    // correct for.
    if (n === "electron" || isOwnAppName(n)) return true;
    if (n.includes("helper (renderer)") ||
        n.includes("helper (gpu)") ||
        n.includes("helper (plugin)") ||
        n.includes("electron helper")) return true;
    return false;
  }

  /** Is the frontmost app ({ pid, name }) somewhere a paste may go? */
  function shouldUsePasteTarget(front) {
    const frontPid = Number(front?.pid || 0);
    const name = String(front?.name || "").trim().toLowerCase();
    if (frontPid > 0 && frontPid === pid) return false;
    if (isOwnAppName(name)) return false;
    if (!name && frontPid <= 0) return false;
    return true;
  }

  return { isOwnAppName, isBadActivationTarget, shouldUsePasteTarget };
}

module.exports = { createOwnProcessRules };
