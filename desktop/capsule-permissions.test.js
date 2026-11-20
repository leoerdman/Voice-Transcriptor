"use strict";

// DM-35 (Ultra-Audit 2026-11-20): the capsule's own session partition
// denies every permission request and check, instead of keeping
// Electron's grant-everything default.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { topLevelFunctionSource } = require("./main-source");

test("the capsule window's session denies all permissions", () => {
  const fn = topLevelFunctionSource("ensureRecordingStatusCapsuleWindow");
  assert.ok(fn, "ensureRecordingStatusCapsuleWindow not found");
  assert.match(fn, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
  assert.match(fn, /setPermissionCheckHandler\(\(\) => false\)/);
});
