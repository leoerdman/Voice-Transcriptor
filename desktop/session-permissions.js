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

module.exports = { denyAllSessionPermissions };
