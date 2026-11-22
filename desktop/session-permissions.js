"use strict";

// A session partition that grants nothing (Ultra-Audit 2026-11-20 DM-35).
//
// Electron's default for a session with no handlers is to grant every
// permission request and check. The recording capsule is a static data:
// page that needs none, and lives in its own partition, so it would keep
// that default unless both handlers are installed.
//
// Pure: the session is injected — desktop/capsule-permissions.test.js
// drives it with a fake.

/**
 * @param {{setPermissionRequestHandler: Function, setPermissionCheckHandler: Function}} session
 */
function denyAllSessionPermissions(session) {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

// Chromium runs a permission CHECK on every getUserMedia / enumerate /
// setSinkId, i.e. several on every recording, and logging each one put
// ~1,250 identical `[perm-check]` lines (audio granted, video denied,
// speaker-selection denied) into three days of main.log. What a support
// reader needs is the decision and the moment it changed, so a check is
// logged the first time its (permission, origin) pair is seen in this
// process and again only when the decision for that pair differs from the
// last one logged.
const PERMISSION_LOG_MAX_KEYS = 256;

/**
 * @returns {(key: string, decision: string) => boolean} true when this
 *   decision should be logged: first sight of `key`, or a decision that
 *   differs from the one last logged for it.
 */
function createPermissionChangeLog({ maxKeys = PERMISSION_LOG_MAX_KEYS } = {}) {
  const last = new Map();
  return (key, decision) => {
    if (last.get(key) === decision) return false;
    if (!last.has(key) && last.size >= maxKeys) {
      // Bounded: origins carry the backend port and data: URLs their
      // size, so the key space is open-ended in principle. Forgetting
      // costs one repeated line, never a missed change.
      last.delete(last.keys().next().value);
    }
    last.set(key, decision);
    return true;
  };
}

module.exports = { createPermissionChangeLog, denyAllSessionPermissions };
