"use strict";

// DM-35 (Ultra-Audit 2026-11-20): the capsule's own session partition
// denies every permission request and check, instead of keeping
// Electron's grant-everything default.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { denyAllSessionPermissions } = require("./session-permissions");
const { topLevelFunctionSource } = require("./main-source");

function fakeSession() {
  return {
    request: null,
    check: null,
    setPermissionRequestHandler(fn) { this.request = fn; },
    setPermissionCheckHandler(fn) { this.check = fn; },
  };
}

test("every permission request is answered no, and every check is false", () => {
  const session = fakeSession();
  denyAllSessionPermissions(session);
  assert.equal(typeof session.request, "function", "no request handler: Electron would grant everything");
  assert.equal(typeof session.check, "function", "no check handler: Electron would grant everything");
  for (const permission of ["media", "clipboard-read", "notifications", "geolocation", "openExternal", "unknown"]) {
    const answers = [];
    session.request({}, permission, (allowed) => answers.push(allowed), {});
    assert.deepEqual(answers, [false], `${permission} request`);
    assert.equal(session.check({}, permission, "data:", {}), false, `${permission} check`);
  }
});

test("the capsule window's session goes through it (wiring)", () => {
  const fn = topLevelFunctionSource("ensureRecordingStatusCapsuleWindow");
  assert.ok(fn, "ensureRecordingStatusCapsuleWindow not found");
  assert.match(fn, /^\s*denyAllSessionPermissions\(recordingStatusWindow\.webContents\.session\);/m);
});
